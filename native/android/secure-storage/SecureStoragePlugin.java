package com.aetheros.simulator;

import android.content.SharedPreferences;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {
    private static final String KEY_ALIAS = "com.aetheros.simulator.secure-storage.v1";
    private static final String PREFS_NAME = "sullyos_secure_storage_v1";
    private static final int GCM_TAG_BITS = 128;
    private static final int MAX_VALUE_BYTES = 16 * 1024;

    @PluginMethod
    public void put(PluginCall call) {
        try {
            String key = validateKey(call.getString("key"));
            String value = call.getString("value");
            if (value == null) throw new IllegalArgumentException("缺少安全存储内容");
            byte[] plaintext = value.getBytes(StandardCharsets.UTF_8);
            if (plaintext.length > MAX_VALUE_BYTES) throw new IllegalArgumentException("安全存储内容过长");

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(plaintext);
            byte[] packed = new byte[iv.length + encrypted.length];
            System.arraycopy(iv, 0, packed, 0, iv.length);
            System.arraycopy(encrypted, 0, packed, iv.length, encrypted.length);

            getContext().getSharedPreferences(PREFS_NAME, 0)
                .edit()
                .putString(key, Base64.encodeToString(packed, Base64.NO_WRAP))
                .commit();

            JSObject result = new JSObject();
            result.put("stored", true);
            call.resolve(result);
            Arrays.fill(plaintext, (byte) 0);
        } catch (Exception error) {
            call.reject("安全保存失败", error);
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String key = validateKey(call.getString("key"));
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, 0);
            String encoded = prefs.getString(key, null);
            JSObject result = new JSObject();
            if (encoded == null) {
                result.put("value", (String) null);
                call.resolve(result);
                return;
            }

            byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
            if (packed.length <= 12 + 16) throw new SecurityException("安全存储数据格式无效");
            byte[] iv = Arrays.copyOfRange(packed, 0, 12);
            byte[] encrypted = Arrays.copyOfRange(packed, 12, packed.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            byte[] plaintext = cipher.doFinal(encrypted);
            if (plaintext.length > MAX_VALUE_BYTES) throw new SecurityException("安全存储数据长度无效");
            result.put("value", new String(plaintext, StandardCharsets.UTF_8));
            Arrays.fill(plaintext, (byte) 0);
            Arrays.fill(packed, (byte) 0);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("安全读取失败，可能需要重新配对设备", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            String key = validateKey(call.getString("key"));
            getContext().getSharedPreferences(PREFS_NAME, 0).edit().remove(key).commit();
            JSObject result = new JSObject();
            result.put("removed", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("安全删除失败", error);
        }
    }

    private String validateKey(String value) {
        if (value == null || !value.matches("[A-Za-z0-9._-]{1,80}")) {
            throw new IllegalArgumentException("安全存储键名无效");
        }
        return value;
    }

    private SecretKey getOrCreateKey() throws Exception {
        if (Build.VERSION.SDK_INT < 23) throw new IllegalStateException("安全存储要求 Android 6.0 或更高版本");
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(false)
            .build());
        return generator.generateKey();
    }
}
