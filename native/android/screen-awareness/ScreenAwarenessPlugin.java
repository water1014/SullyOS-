package com.aetheros.simulator;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;

@CapacitorPlugin(
    name = "ScreenAwareness",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class ScreenAwarenessPlugin extends Plugin {
    @PluginMethod
    public void startSession(PluginCall call) {
        if (Build.VERSION.SDK_INT < 21) {
            call.reject("屏幕感知需要 Android 5.0 或更高版本");
            return;
        }
        if (ScreenAwarenessService.isRunning()) {
            JSObject result = new JSObject();
            result.put("active", true);
            result.put("alreadyRunning", true);
            call.resolve(result);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "handleNotificationPermission");
            return;
        }
        launchProjectionConsent(call);
    }

    @PermissionCallback
    private void handleNotificationPermission(PluginCall call) {
        if (call == null) return;
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("需要允许糯米机显示持续通知，才能安全开启屏幕感知");
            return;
        }
        launchProjectionConsent(call);
    }

    private void launchProjectionConsent(PluginCall call) {
        MediaProjectionManager manager =
            (MediaProjectionManager) getContext().getSystemService(android.content.Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            call.reject("当前设备不支持系统屏幕捕获");
            return;
        }
        startActivityForResult(call, manager.createScreenCaptureIntent(), "handleProjectionPermission");
    }

    @ActivityCallback
    private void handleProjectionPermission(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("你取消了屏幕共享授权，屏幕感知没有开启");
            return;
        }
        try {
            Intent service = new Intent(getContext(), ScreenAwarenessService.class);
            service.setAction(ScreenAwarenessService.ACTION_START);
            service.putExtra(ScreenAwarenessService.EXTRA_RESULT_CODE, result.getResultCode());
            service.putExtra(ScreenAwarenessService.EXTRA_DATA, result.getData());
            if (Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(service);
            } else {
                getContext().startService(service);
            }
            JSObject response = new JSObject();
            response.put("active", true);
            response.put("requiresVisibleNotification", true);
            response.put("localOnly", true);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("无法启动屏幕感知服务", error);
        }
    }

    @PluginMethod
    public void stopSession(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), ScreenAwarenessService.class));
            JSObject result = new JSObject();
            result.put("active", false);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法停止屏幕感知", error);
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("active", ScreenAwarenessService.isRunning());
        result.put("latestFrameAt", ScreenAwarenessService.getLatestFrameAt());
        call.resolve(result);
    }

    @PluginMethod
    public void getLatestFrame(PluginCall call) {
        File frame = ScreenAwarenessService.getLatestFrameFile(getContext());
        if (!ScreenAwarenessService.isRunning() || !frame.isFile() || frame.length() <= 0) {
            call.reject("还没有可用画面，请稍等片刻后重试");
            return;
        }
        if (frame.length() > 8L * 1024L * 1024L) {
            call.reject("本机画面缓存超出安全读取上限");
            return;
        }
        try (FileInputStream input = new FileInputStream(frame);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            JSObject result = new JSObject();
            result.put("mimeType", "image/jpeg");
            result.put("base64", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
            result.put("capturedAt", ScreenAwarenessService.getLatestFrameAt());
            result.put("localOnly", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("读取本机屏幕画面失败", error);
        }
    }

    @PluginMethod
    public void clearLatestFrame(PluginCall call) {
        File frame = ScreenAwarenessService.getLatestFrameFile(getContext());
        boolean deleted = !frame.exists() || frame.delete();
        JSObject result = new JSObject();
        result.put("cleared", deleted);
        call.resolve(result);
    }
}
