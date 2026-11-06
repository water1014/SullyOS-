package com.aetheros.simulator;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.UnifiedPush;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;
import org.unifiedpush.android.connector.FailedReason;

import java.nio.charset.StandardCharsets;

public class AmsgUnifiedPushService extends PushService {
    private static final String CHANNEL_ID = "sullyos_active_messages";
    private static final int NOTIFICATION_ID = 731204;

    @Override
    public void onMessage(PushMessage message, String instance) {
        if (message == null || !message.getDecrypted()) return;
        byte[] content = message.getContent();
        if (content == null || content.length == 0 || content.length > 16384) return;
        String payload = new String(content, StandardCharsets.UTF_8);
        android.content.SharedPreferences prefs = getSharedPreferences(AmsgUnifiedPushPlugin.PREFS, Context.MODE_PRIVATE);
        long receivedAt = Math.max(System.currentTimeMillis(), prefs.getLong("last_received_at", 0L) + 1L);
        try {
            JSONArray queue = new JSONArray(prefs.getString(AmsgUnifiedPushPlugin.KEY_MESSAGES, "[]"));
            JSONObject entry = new JSONObject();
            entry.put("payload", payload);
            entry.put("receivedAt", receivedAt);
            queue.put(entry);
            while (queue.length() > 50) {
                JSONArray trimmed = new JSONArray();
                for (int i = queue.length() - 50; i < queue.length(); i++) trimmed.put(queue.get(i));
                queue = trimmed;
            }
            prefs.edit().putString(AmsgUnifiedPushPlugin.KEY_MESSAGES, queue.toString())
                .putLong("last_received_at", receivedAt).commit();
        } catch (Exception error) {
            android.util.Log.e("SullyOSUnifiedPush", "Unable to persist push message", error);
            return;
        }
        AmsgUnifiedPushPlugin.sendEvent(this, AmsgUnifiedPushPlugin.ACTION_PUSH, payload, receivedAt);
        showNotification(payload);
    }

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        if (endpoint == null) return;
        android.content.SharedPreferences.Editor editor = getSharedPreferences(AmsgUnifiedPushPlugin.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(AmsgUnifiedPushPlugin.KEY_ENDPOINT, endpoint.getUrl())
            .putBoolean(AmsgUnifiedPushPlugin.KEY_TEMPORARY, false)
            .remove(AmsgUnifiedPushPlugin.KEY_LAST_ERROR);
        if (endpoint.getPubKeySet() != null) {
            editor.putString(AmsgUnifiedPushPlugin.KEY_P256DH, endpoint.getPubKeySet().getPubKey());
            editor.putString(AmsgUnifiedPushPlugin.KEY_AUTH, endpoint.getPubKeySet().getAuth());
        } else {
            editor.remove(AmsgUnifiedPushPlugin.KEY_P256DH).remove(AmsgUnifiedPushPlugin.KEY_AUTH);
        }
        String distributor = UnifiedPush.getAckDistributor(this);
        if (distributor != null) editor.putString(AmsgUnifiedPushPlugin.KEY_DISTRIBUTOR, distributor);
        editor.commit();
        AmsgUnifiedPushPlugin.sendEvent(this, AmsgUnifiedPushPlugin.ACTION_REGISTRATION, null);
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        getSharedPreferences(AmsgUnifiedPushPlugin.PREFS, Context.MODE_PRIVATE).edit()
            .putString(AmsgUnifiedPushPlugin.KEY_LAST_ERROR, "UnifiedPush 注册失败：" + String.valueOf(reason))
            .remove(AmsgUnifiedPushPlugin.KEY_ENDPOINT)
            .remove(AmsgUnifiedPushPlugin.KEY_P256DH)
            .remove(AmsgUnifiedPushPlugin.KEY_AUTH)
            .commit();
        AmsgUnifiedPushPlugin.sendEvent(this, AmsgUnifiedPushPlugin.ACTION_REGISTRATION, null);
    }

    @Override
    public void onUnregistered(String instance) {
        getSharedPreferences(AmsgUnifiedPushPlugin.PREFS, Context.MODE_PRIVATE).edit()
            .remove(AmsgUnifiedPushPlugin.KEY_ENDPOINT)
            .remove(AmsgUnifiedPushPlugin.KEY_P256DH)
            .remove(AmsgUnifiedPushPlugin.KEY_AUTH)
            .putString(AmsgUnifiedPushPlugin.KEY_LAST_ERROR, "UnifiedPush 订阅已被分发器注销")
            .commit();
        AmsgUnifiedPushPlugin.sendEvent(this, AmsgUnifiedPushPlugin.ACTION_REGISTRATION, null);
    }

    private void showNotification(String payload) {
        try {
            JSONObject data = new JSONObject(payload);
            String title = data.optString("contactName", "糯米机主动消息");
            String body = data.optString("previewBody", data.optString("message", "收到一条新消息"));
            if (title.trim().isEmpty()) title = "糯米机主动消息";
            if (body.trim().isEmpty()) body = "收到一条新消息";
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "主动消息", NotificationManager.IMPORTANCE_DEFAULT
                ));
            }
            Intent tap = new Intent(this, AmsgNotificationTapReceiver.class);
            tap.setAction("com.aetheros.simulator.AMSG_NOTIFICATION_TAP");
            tap.putExtra("payload", payload);
            PendingIntent pending = PendingIntent.getBroadcast(
                this, (int) (System.currentTimeMillis() & 0x7fffffff), tap,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0)
            );
            int icon = getApplicationInfo().icon;
            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(icon == 0 ? android.R.drawable.ic_dialog_info : icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, builder.build());
        } catch (Exception error) {
            android.util.Log.w("SullyOSUnifiedPush", "Unable to show push notification", error);
        }
    }
}
