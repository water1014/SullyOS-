package com.aetheros.simulator;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

public final class ScreenAwarenessService extends Service {
    public static final String ACTION_START = "com.aetheros.simulator.screen.START";
    public static final String ACTION_STOP = "com.aetheros.simulator.screen.STOP";
    public static final String EXTRA_RESULT_CODE = "projection_result_code";
    public static final String EXTRA_DATA = "projection_data";
    private static final String CHANNEL_ID = "sullyos_screen_awareness";
    private static final int NOTIFICATION_ID = 7314;
    private static final long FRAME_INTERVAL_MS = 3000L;
    private static volatile boolean running = false;
    private static volatile long latestFrameAt = 0L;

    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private HandlerThread captureThread;
    private Handler captureHandler;
    private final AtomicBoolean frameWriting = new AtomicBoolean(false);
    private long lastFrameAt = 0L;

    public static boolean isRunning() {
        return running;
    }

    public static long getLatestFrameAt() {
        return latestFrameAt;
    }

    public static File getLatestFrameFile(Context context) {
        return new File(new File(context.getCacheDir(), "screen-awareness"), "latest.jpg");
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopCapture();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(intent.getAction())) return START_NOT_STICKY;
        if (running) return START_STICKY;

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent resultData = getProjectionData(intent);
        if (resultCode != android.app.Activity.RESULT_OK || resultData == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            startVisibleForegroundService();
            MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = manager.getMediaProjection(resultCode, resultData);
            if (projection == null) throw new IllegalStateException("MediaProjection unavailable");

            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    stopCapture();
                    stopSelf();
                }
            }, new Handler(getMainLooper()));

            startCapturePipeline();
            running = true;
            return START_STICKY;
        } catch (Exception error) {
            stopCapture();
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    private Intent getProjectionData(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) {
            return intent.getParcelableExtra(EXTRA_DATA, Intent.class);
        }
        //noinspection deprecation
        return intent.getParcelableExtra(EXTRA_DATA);
    }

    private void startVisibleForegroundService() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "屏幕感知",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("屏幕感知开启时持续显示，可随时停止");
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent stopIntent = new Intent(this, ScreenAwarenessService.class);
        stopIntent.setAction(ACTION_STOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent stopPending = PendingIntent.getService(this, 7315, stopIntent, pendingFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("糯米机屏幕感知已开启")
            .setContentText("仅在本机缓存画面，不会自动上传。点击停止即可结束")
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止感知", stopPending);
        return builder.build();
    }

    private void startCapturePipeline() {
        DisplayManager displayManager = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        Display display = displayManager.getDisplay(Display.DEFAULT_DISPLAY);
        if (display == null) throw new IllegalStateException("Default display unavailable");

        DisplayMetrics metrics = new DisplayMetrics();
        display.getRealMetrics(metrics);
        int width = Math.max(1, metrics.widthPixels);
        int height = Math.max(1, metrics.heightPixels);
        int density = Math.max(1, metrics.densityDpi);

        captureThread = new HandlerThread("SullyOS-ScreenCapture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());
        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
        imageReader.setOnImageAvailableListener(this::saveLatestFrame, captureHandler);

        virtualDisplay = projection.createVirtualDisplay(
            "SullyOS-ScreenAwareness",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.getSurface(),
            null,
            captureHandler
        );
        if (virtualDisplay == null) throw new IllegalStateException("Virtual display unavailable");
    }

    private void saveLatestFrame(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) return;
            long now = System.currentTimeMillis();
            if (now - lastFrameAt < FRAME_INTERVAL_MS || !frameWriting.compareAndSet(false, true)) {
                return;
            }

            Image.Plane[] planes = image.getPlanes();
            if (planes.length == 0) return;
            Image.Plane plane = planes[0];
            ByteBuffer buffer = plane.getBuffer();
            int pixelStride = plane.getPixelStride();
            int rowStride = plane.getRowStride();
            int rowPadding = Math.max(0, rowStride - pixelStride * image.getWidth());
            int paddedWidth = image.getWidth() + rowPadding / Math.max(1, pixelStride);

            Bitmap padded = Bitmap.createBitmap(
                paddedWidth,
                image.getHeight(),
                Bitmap.Config.ARGB_8888
            );
            padded.copyPixelsFromBuffer(buffer);
            Bitmap frame = Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
            padded.recycle();

            File directory = new File(getCacheDir(), "screen-awareness");
            if (!directory.exists() && !directory.mkdirs()) {
                frame.recycle();
                return;
            }
            File temporary = new File(directory, "latest.tmp");
            File destination = new File(directory, "latest.jpg");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                frame.compress(Bitmap.CompressFormat.JPEG, 62, output);
                output.flush();
                output.getFD().sync();
            }
            frame.recycle();
            if (destination.exists() && !destination.delete()) {
                temporary.delete();
                return;
            }
            if (!temporary.renameTo(destination)) {
                temporary.delete();
                return;
            }
            lastFrameAt = now;
            latestFrameAt = now;
        } catch (Exception ignored) {
            // Screen capture is best-effort; never log screen contents or file data.
        } finally {
            if (image != null) image.close();
            frameWriting.set(false);
        }
    }

    private void stopCapture() {
        running = false;
        latestFrameAt = 0L;
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (imageReader != null) {
            imageReader.setOnImageAvailableListener(null, null);
            imageReader.close();
            imageReader = null;
        }
        if (projection != null) {
            try {
                projection.unregisterCallback(null);
            } catch (Exception ignored) {
                // Projection may already be stopped by Android.
            }
            projection.stop();
            projection = null;
        }
        if (captureThread != null) {
            captureThread.quitSafely();
            captureThread = null;
            captureHandler = null;
        }
        File frame = getLatestFrameFile(this);
        if (frame.exists()) frame.delete();
        File directory = frame.getParentFile();
        if (directory != null && directory.exists()) directory.delete();
        stopForeground(true);
    }

    @Override
    public void onDestroy() {
        stopCapture();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
