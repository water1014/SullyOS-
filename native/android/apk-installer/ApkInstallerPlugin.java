package com.aetheros.simulator;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {
    private static final String AUTHORITY_SUFFIX = ".fileprovider";

    @PluginMethod
    public void getInstalledInfo(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(
                getContext().getPackageName(), signingFlags()
            );
            JSObject result = new JSObject();
            result.put("packageName", getContext().getPackageName());
            result.put("versionCode", packageVersionCode(info));
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put("certificateSha256", installedSignerFingerprint(info));
            result.put("canRequestPackageInstalls", Build.VERSION.SDK_INT < 26
                || getContext().getPackageManager().canRequestPackageInstalls());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法读取当前应用安装信息", error);
        }
    }

    @PluginMethod
    public void verifyApk(PluginCall call) {
        try {
            File apk = resolveInputFile(call.getString("path"));
            String expectedSha = normalizeSha(call.getString("sha256"));
            if (!apk.isFile() || apk.length() <= 0) throw new IllegalArgumentException("APK 文件不存在");
            String actualSha = sha256(apk);
            if (!actualSha.equals(expectedSha)) throw new SecurityException("APK SHA-256 不匹配");

            PackageInfo candidate = archiveInfo(apk);
            PackageInfo installed = getContext().getPackageManager().getPackageInfo(
                getContext().getPackageName(), signingFlags()
            );
            String candidateSigner = archiveSignerFingerprint(candidate);
            String installedSigner = installedSignerFingerprint(installed);
            boolean valid = getContext().getPackageName().equals(candidate.packageName)
                && candidateSigner.length() == 64
                && candidateSigner.equals(installedSigner)
                && packageVersionCode(candidate) > packageVersionCode(installed);

            JSObject result = new JSObject();
            result.put("valid", valid);
            result.put("packageName", candidate.packageName);
            result.put("versionCode", packageVersionCode(candidate));
            result.put("versionName", candidate.versionName == null ? "" : candidate.versionName);
            result.put("certificateSha256", candidateSigner);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("APK 校验失败", error);
        }
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent intent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(intent);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("无法打开安装权限设置", error);
        }
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        try {
            File source = resolveInputFile(call.getString("path"));
            String expectedSha = normalizeSha(call.getString("sha256"));
            if (!source.isFile() || !sha256(source).equals(expectedSha)) {
                throw new SecurityException("APK 文件校验失败");
            }
            PackageInfo candidate = archiveInfo(source);
            PackageInfo installed = getContext().getPackageManager().getPackageInfo(
                getContext().getPackageName(), signingFlags()
            );
            String candidateSigner = archiveSignerFingerprint(candidate);
            String installedSigner = installedSignerFingerprint(installed);
            if (!getContext().getPackageName().equals(candidate.packageName)
                || candidateSigner.length() != 64
                || !candidateSigner.equals(installedSigner)
                || packageVersionCode(candidate) <= packageVersionCode(installed)) {
                throw new SecurityException("APK 包名、签名或版本不匹配");
            }

            if (Build.VERSION.SDK_INT >= 26
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
                JSObject result = new JSObject();
                result.put("status", "permission_required");
                call.resolve(result);
                return;
            }

            File updateDir = new File(getContext().getCacheDir(), "verified-updates");
            if (!updateDir.exists() && !updateDir.mkdirs()) {
                throw new IllegalStateException("无法创建安装缓存目录");
            }
            File staged = new File(updateDir, "SullyOS-update.apk");
            copyFile(source, staged);
            if (!sha256(staged).equals(expectedSha)) {
                staged.delete();
                throw new SecurityException("安装暂存文件校验失败");
            }

            Uri contentUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + AUTHORITY_SUFFIX,
                staged
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(contentUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(intent);

            JSObject result = new JSObject();
            result.put("status", "installer_opened");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法启动 Android 安装器", error);
        }
    }

    private File resolveInputFile(String path) throws Exception {
        if (path == null || path.trim().isEmpty()) throw new IllegalArgumentException("缺少 APK 路径");
        Uri uri = Uri.parse(path);
        if (!"file".equalsIgnoreCase(uri.getScheme())) {
            throw new IllegalArgumentException("仅允许应用本地缓存中的 file URI");
        }
        File file = new File(uri.getPath());
        String cache = getContext().getCacheDir().getCanonicalPath() + File.separator;
        String candidate = file.getCanonicalPath();
        if (!candidate.startsWith(cache)) throw new SecurityException("APK 路径不在应用缓存目录内");
        return file;
    }

    private PackageInfo archiveInfo(File apk) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        PackageInfo info = pm.getPackageArchiveInfo(apk.getAbsolutePath(), signingFlags());
        if (info == null) throw new IllegalArgumentException("无法解析 APK");
        return info;
    }

    private int signingFlags() {
        return Build.VERSION.SDK_INT >= 28
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
    }

    private long packageVersionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private String installedSignerFingerprint(PackageInfo info) throws Exception {
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            android.content.pm.Signature[] signatures = info.signingInfo.getApkContentsSigners();
            if (signatures.length != 1) throw new SecurityException("不支持多签名 APK");
            return digest(signatures[0].toByteArray());
        }
        if (info.signatures == null || info.signatures.length != 1) {
            throw new SecurityException("APK 缺少唯一签名证书");
        }
        return digest(info.signatures[0].toByteArray());
    }

    private String archiveSignerFingerprint(PackageInfo info) throws Exception {
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            android.content.pm.Signature[] signatures = info.signingInfo.getApkContentsSigners();
            if (signatures.length > 0) return digest(signatures[0].toByteArray());
        }
        if (info.signatures != null && info.signatures.length > 0) {
            return digest(info.signatures[0].toByteArray());
        }
        return "";
    }

    private String normalizeSha(String value) {
        if (value == null) throw new IllegalArgumentException("缺少 SHA-256");
        String normalized = value.replaceAll("[^a-fA-F0-9]", "").toLowerCase(Locale.ROOT);
        if (normalized.length() != 64) throw new IllegalArgumentException("SHA-256 格式无效");
        return normalized;
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return hex(digest.digest());
    }

    private String digest(byte[] bytes) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }

    private void copyFile(File source, File target) throws Exception {
        try (InputStream input = new FileInputStream(source);
             FileOutputStream output = new FileOutputStream(target, false)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            output.getFD().sync();
        }
    }
}
