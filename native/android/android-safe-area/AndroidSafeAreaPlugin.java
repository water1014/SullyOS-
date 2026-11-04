package com.aetheros.simulator;

import android.os.Build;
import android.view.DisplayCutout;
import android.view.View;
import android.view.WindowInsets;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AndroidSafeArea")
public class AndroidSafeAreaPlugin extends Plugin {
    @PluginMethod
    public void getInsets(PluginCall call) {
        try {
            int statusBarId = getContext().getResources().getIdentifier(
                "status_bar_height", "dimen", "android"
            );
            int statusBarHeight = statusBarId > 0
                ? getContext().getResources().getDimensionPixelSize(statusBarId)
                : 0;
            int cutoutTop = 0;
            View decor = getActivity().getWindow().getDecorView();
            WindowInsets insets = decor.getRootWindowInsets();
            if (Build.VERSION.SDK_INT >= 28 && insets != null) {
                DisplayCutout cutout = insets.getDisplayCutout();
                if (cutout != null) cutoutTop = cutout.getSafeInsetTop();
            }
            float density = getContext().getResources().getDisplayMetrics().density;
            int topInset = Math.max(statusBarHeight, cutoutTop);
            JSObject result = new JSObject();
            result.put("topInsetPx", topInset);
            result.put("topInsetDp", topInset / density);
            result.put("density", density);
            result.put("hasDisplayCutout", cutoutTop > 0);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("读取 Android 顶部安全区失败", error);
        }
    }
}
