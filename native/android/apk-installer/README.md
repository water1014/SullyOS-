# ApkInstaller 原生插件接入说明

这里保存 Capacitor 6 Android 自定义插件的源码片段，不是完整 Android Studio 工程。当前仓库尚未生成 `android/`，所以这份 Java 代码还不能独立编译或在手机上运行。

## 文件

- `ApkInstallerPlugin.java`：读取安装信息、校验 APK 包名/版本/签名/SHA-256、请求系统安装权限并调用系统安装器。
- `apk_installer_paths.xml`：FileProvider 仅暴露应用缓存中的 `verified-updates/` 子目录。

## 接入完整 Capacitor Android 工程时

1. 将 Java 文件放到：
   `android/app/src/main/java/com/aetheros/simulator/ApkInstallerPlugin.java`
2. 将 XML 文件放到：
   `android/app/src/main/res/xml/apk_installer_paths.xml`
3. 在 `MainActivity.java` 的 `onCreate` 中注册插件：

   ```java
   import com.aetheros.simulator.ApkInstallerPlugin;

   @Override
   public void onCreate(Bundle savedInstanceState) {
       registerPlugin(ApkInstallerPlugin.class);
       super.onCreate(savedInstanceState);
   }
   ```

4. 在 `AndroidManifest.xml` 的 `<application>` 内注册 FileProvider：

   ```xml
   <provider
       android:name="androidx.core.content.FileProvider"
       android:authorities="${applicationId}.fileprovider"
       android:exported="false"
       android:grantUriPermissions="true">
       <meta-data
           android:name="android.support.FILE_PROVIDER_PATHS"
           android:resource="@xml/apk_installer_paths" />
   </provider>
   ```

5. 确认 app module 依赖包含 AndroidX Core（Capacitor Android 通常已传递提供）。
6. 使用相同 applicationId、长期保管的同一 release 签名证书构建并在真实 Android 设备验证。

## 安全边界

- 插件只接受应用自身 Cache 目录内的 `file://` 路径。
- SHA-256、包名、版本号和当前安装证书指纹均在原生层复核，前端校验不能代替原生校验。
- 安装动作交给 Android Package Installer，系统授权由用户完成；插件不静默安装、不绕过授权。
- 临时安装包复制到 `cache/verified-updates/`，由 FileProvider 通过临时只读 URI 授权给系统安装器。
- 不读取或修改 IndexedDB、聊天记录、角色、媒体库和用户备份。
- 目前没有对 APK 安装完成的可靠回调；系统安装器打开只代表交接成功，不代表安装成功。
- 暂存 APK 在新版本启动后可由后续清理任务删除；不要在系统安装器读取前立即删除。

## 尚需真实设备验收

- [ ] Java 源码在最终 Capacitor Android 工程编译通过。
- [ ] Android 8+ 未知来源安装权限流程验证。
- [ ] 同证书、同包名、更高 versionCode 的 APK 可覆盖升级。
- [ ] 错误 SHA、错误证书、错误包名、旧 versionCode 均被拒绝。
- [ ] Android 7 及以下兼容分支（如仍支持）验证。
- [ ] Android 12-16 真实设备测试 FileProvider URI 与安装器行为。

不要在没有完成这些检查前发布正式 APK。