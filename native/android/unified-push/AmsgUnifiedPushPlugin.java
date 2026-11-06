package com.aetheros.simulator;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;
import org.unifiedpush.android.connector.ConstantsKt;
import org.unifiedpush.android.connector.data.PushEndpoint;

import java.util.List;

import kotlin.Unit;

@CapacitorPlugin(name = "AmsgUnifiedPush")
public class AmsgUnifiedPushPlugin extends Plugin {
    static final String PREFS = "sullyos_unified_push_v1";
    static final String ACTION_EVENT = "com.aetheros.simulator.AMSG_UNIFIED_PUSH_EVENT";
    static final String ACTION_PUSH = "push";
    static final String ACTION_REGISTRATION = "registration";
    static final String ACTION_TAP = "tap";
    static final String KEY_ENDPOINT = "endpoint";
    static final String KEY_P256DH = "p256dh";
    static final String KEY_AUTH = "auth";
    static final String KEY_VAPID = "vapid";
    static final String KEY_DISTRIBUTOR = "distributor";
    static final String KEY_TEMPORARY = "temporary";
    static final String KEY_LAST_ERROR = "last_error";
    static final String KEY_MESSAGES = "pending_messages";
    static final String KEY_LAUNCH_PAYLOAD = "launch_payload";

    private BroadcastReceiver receiver;

    @Override
    public void load() {
        super.load();
        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                String type = intent.getStringExtra("type");
                String payload = intent.getStringExtra("payload");
                if (ACTION_PUSH.equals(type)) {
                    JSObject event = new JSObject();
                    event.put("payload", payload);
                    notifyListeners("pushReceived", event);
                } else if (ACTION_TAP.equals(type)) {
                    JSObject event = new JSObject();
                    event.put("payload", payload);
                    notifyListeners("notificationTapped", event);
                } else {
                    notifyListeners("registrationChanged", getStatusObject());
                }
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_EVENT);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(getStatusObject());
    }

    private JSObject getStatusObject() {
        Context context = getContext();
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSObject result = new JSObject();
        List<String> distributors = UnifiedPush.getDistributors(context);
        JSArray distributorArray = new JSArray();
        for (String distributor : distributors) distributorArray.put(distributor);
        result.put("native", true);
        result.put("distributors", distributorArray);
        String distributor = UnifiedPush.getAckDistributor(context);
        if (distributor == null) distributor = UnifiedPush.getSavedDistributor(context);
        result.put("distributor", distributor);
        String endpoint = prefs.getString(KEY_ENDPOINT, null);
        String p256dh = prefs.getString(KEY_P256DH, null);
        String auth = prefs.getString(KEY_AUTH, null);
        if (endpoint != null && p256dh != null && auth != null) {
            JSObject keys = new JSObject();
            keys.put("p256dh", p256dh);
            keys.put("auth", auth);
            JSObject subscription = new JSObject();
            subscription.put("endpoint", endpoint);
            subscription.put("keys", keys);
            subscription.put("distributor", prefs.getString(KEY_DISTRIBUTOR, distributor));
            subscription.put("temporary", prefs.getBoolean(KEY_TEMPORARY, false));
            subscription.put("vapidPublicKey", prefs.getString(KEY_VAPID, ""));
            result.put("subscription", subscription);
        } else {
            result.put("subscription", (String) null);
        }
        result.put("lastError", prefs.getString(KEY_LAST_ERROR, null));
        return result;
    }

    @PluginMethod
    public void register(PluginCall call) {
        String vapid = call.getString("vapidPublicKey");
        if (vapid == null || vapid.trim().isEmpty()) {
            call.reject("缺少 VAPID 公钥，无法注册 UnifiedPush");
            return;
        }
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_VAPID, vapid.trim()).remove(KEY_LAST_ERROR).apply();
        String saved = UnifiedPush.getSavedDistributor(getContext());
        if (saved != null && UnifiedPush.getDistributors(getContext()).contains(saved)) {
            try {
                UnifiedPush.register(
                    getContext(),
                    ConstantsKt.INSTANCE_DEFAULT,
                    "SullyOS 主动消息",
                    vapid.trim()
                );
                JSObject result = new JSObject();
                result.put("pending", true);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("向 UnifiedPush 分发器发起注册失败", error);
            }
            return;
        }
        UnifiedPush.tryUseCurrentOrDefaultDistributor(getActivity(), success -> {
            if (Boolean.TRUE.equals(success)) {
                try {
                    UnifiedPush.register(
                        getContext(),
                        ConstantsKt.INSTANCE_DEFAULT,
                        "SullyOS 主动消息",
                        vapid.trim()
                    );
                    JSObject result = new JSObject();
                    result.put("pending", true);
                    call.resolve(result);
                } catch (Exception error) {
                    call.reject("向 UnifiedPush 分发器发起注册失败", error);
                }
            } else {
                call.reject("没有选择可用的 UnifiedPush 分发器。请先安装并打开支持 UnifiedPush 的分发器应用。");
            }
            return Unit.INSTANCE;
        });
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        try {
            UnifiedPush.unregister(getContext(), ConstantsKt.getINSTANCE_DEFAULT());
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_ENDPOINT).remove(KEY_P256DH).remove(KEY_AUTH)
                .remove(KEY_DISTRIBUTOR).remove(KEY_TEMPORARY).remove(KEY_VAPID)
                .remove(KEY_LAST_ERROR).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("取消 UnifiedPush 订阅失败", error);
        }
    }

    @PluginMethod
    public void drainPendingPushes(PluginCall call) {
        android.content.SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_MESSAGES, "[]");
        String launchPayload = prefs.getString(KEY_LAUNCH_PAYLOAD, null);
        JSArray messages = new JSArray();
        try {
            JSONArray stored = new JSONArray(raw);
            for (int i = 0; i < stored.length(); i++) {
                JSONObject item = stored.optJSONObject(i);
                if (item == null) continue;
                JSObject message = new JSObject();
                message.put("payload", item.optString("payload", ""));
                message.put("receivedAt", item.optLong("receivedAt", System.currentTimeMillis()));
                messages.put(message);
            }
        } catch (Exception ignored) { }
        JSObject result = new JSObject();
        result.put("messages", messages);
        result.put("launchPayload", launchPayload);
        call.resolve(result);
    }

    @PluginMethod
    public void acknowledgePendingPushes(PluginCall call) {
        Long throughValue = call.getLong("throughReceivedAt");
        long throughReceivedAt = throughValue == null ? 0L : throughValue;
        android.content.SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_MESSAGES, "[]");
        try {
            JSONArray current = new JSONArray(raw);
            JSONArray remaining = new JSONArray();
            for (int i = 0; i < current.length(); i++) {
                JSONObject item = current.optJSONObject(i);
                if (item != null && item.optLong("receivedAt", 0L) > throughReceivedAt) remaining.put(item);
            }
            android.content.SharedPreferences.Editor editor = prefs.edit().putString(KEY_MESSAGES, remaining.toString());
            editor.remove(KEY_LAUNCH_PAYLOAD).commit();
            call.resolve();
        } catch (Exception error) {
            call.reject("确认 UnifiedPush 收件箱失败", error);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) { }
            receiver = null;
        }
        super.handleOnDestroy();
    }

    static void sendEvent(Context context, String type, String payload) {
        Intent event = new Intent(ACTION_EVENT);
        event.setPackage(context.getPackageName());
        event.putExtra("type", type);
        if (payload != null) event.putExtra("payload", payload);
        context.sendBroadcast(event);
    }
}
