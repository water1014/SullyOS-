package com.aetheros.simulator;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class AmsgNotificationTapReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String payload = intent.getStringExtra("payload");
        if (payload == null) return;
        context.getSharedPreferences(AmsgUnifiedPushPlugin.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(AmsgUnifiedPushPlugin.KEY_LAUNCH_PAYLOAD, payload)
            .putLong(AmsgUnifiedPushPlugin.KEY_LAUNCH_PAYLOAD_AT, System.currentTimeMillis())
            .commit();
        AmsgUnifiedPushPlugin.sendEvent(context, AmsgUnifiedPushPlugin.ACTION_TAP, payload);
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            context.startActivity(launch);
        }
    }
}
