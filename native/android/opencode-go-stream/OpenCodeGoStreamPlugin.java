package com.aetheros.simulator;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "OpenCodeGoStream")
public class OpenCodeGoStreamPlugin extends Plugin {
    private final ExecutorService executor = Executors.newFixedThreadPool(3);
    private final Map<String, Task> tasks = new ConcurrentHashMap<>();
    private static final class Task {
        volatile HttpURLConnection connection;
        volatile boolean cancelled;
    }

    @PluginMethod
    public void start(PluginCall call) {
        String id = call.getString("requestId");
        String url = call.getString("url");
        String method = call.getString("method");
        JSObject headers = call.getObject("headers");
        String body = call.getString("body");
        if (id == null || id.isEmpty() || url == null || url.isEmpty()) {
            call.reject("Missing request ID or URL");
            return;
        }
        Task task = new Task();
        if (tasks.putIfAbsent(id, task) != null) {
            call.reject("Duplicate request ID");
            return;
        }
        call.resolve();
        executor.execute(() -> runRequest(id, task, url, method == null ? "GET" : method, headers, body));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        Task task = tasks.get(call.getString("requestId"));
        if (task != null) {
            task.cancelled = true;
            if (task.connection != null) task.connection.disconnect();
        }
        call.resolve();
    }

    private void runRequest(String id, Task task, String url, String method, JSObject headers, String body) {
        HttpURLConnection connection = null;
        try {
            URL target = new URL(url);
            if (!"https".equalsIgnoreCase(target.getProtocol())
                || !"opencode.ai".equalsIgnoreCase(target.getHost())
                || !(target.getPath().startsWith("/zen/go/") || target.getPath().equals("/zen/go")
                    || target.getPath().startsWith("/inference/go/") || target.getPath().equals("/inference/go"))) {
                throw new SecurityException("Only OpenCode Go HTTPS endpoints are allowed");
            }
            connection = (HttpURLConnection) target.openConnection();
            task.connection = connection;
            connection.setRequestMethod(method);
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(120000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("Accept-Encoding", "identity");
            if (headers != null) {
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    String value = headers.optString(key, "");
                    if (!value.isEmpty() && !key.equalsIgnoreCase("host")
                        && !key.equalsIgnoreCase("content-length") && !key.equalsIgnoreCase("connection")) {
                        connection.setRequestProperty(key, value);
                    }
                }
            }
            if (body != null && !method.equalsIgnoreCase("GET") && !method.equalsIgnoreCase("HEAD")) {
                connection.setDoOutput(true);
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            if (task.cancelled) return;
            int status = connection.getResponseCode();
            JSObject response = new JSObject();
            response.put("requestId", id);
            response.put("status", status);
            JSObject responseHeaders = new JSObject();
            for (Map.Entry<String, java.util.List<String>> entry : connection.getHeaderFields().entrySet()) {
                if (entry.getKey() != null && entry.getValue() != null) {
                    responseHeaders.put(entry.getKey().toLowerCase(java.util.Locale.ROOT),
                        android.text.TextUtils.join(", ", entry.getValue()));
                }
            }
            response.put("headers", responseHeaders);
            notifyListeners("response", response);

            InputStream input;
            try { input = status >= 400 ? connection.getErrorStream() : connection.getInputStream(); }
            catch (Exception error) {
                input = connection.getErrorStream();
                if (input == null) throw error;
            }
            if (input != null) {
                try (InputStream stream = input) {
                    byte[] buffer = new byte[16384];
                    int count;
                    while (!task.cancelled && (count = stream.read(buffer)) != -1) {
                        byte[] part = new byte[count];
                        System.arraycopy(buffer, 0, part, 0, count);
                        JSObject chunk = new JSObject();
                        chunk.put("requestId", id);
                        chunk.put("base64", Base64.encodeToString(part, Base64.NO_WRAP));
                        notifyListeners("chunk", chunk);
                    }
                }
            }
            if (!task.cancelled) {
                JSObject complete = new JSObject();
                complete.put("requestId", id);
                notifyListeners("complete", complete);
            }
        } catch (Exception error) {
            if (!task.cancelled) {
                JSObject failure = new JSObject();
                failure.put("requestId", id);
                failure.put("message", error.getMessage() == null ? "Native request failed" : error.getMessage());
                notifyListeners("error", failure);
            }
        } finally {
            if (connection != null) connection.disconnect();
            tasks.remove(id, task);
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (Task task : tasks.values()) {
            task.cancelled = true;
            if (task.connection != null) task.connection.disconnect();
        }
        tasks.clear();
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
