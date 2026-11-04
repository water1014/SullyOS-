# SecureStorage 原生插件

为后续设备配对和云端同步令牌提供 Android Keystore-backed 存储。

## 实现

- Capacitor 6 插件名：`SecureStorage`
- AES/GCM/NoPadding，128-bit authentication tag。
- AES 密钥由 Android Keystore 创建和保管，不导出到 JavaScript。
- 密文保存在应用私有 SharedPreferences；每个键名作为 AES-GCM AAD，防止密文被挪到另一个键名下。
- 提供 `put`、`get`、`remove` 三个方法。
- 浏览器预览只使用页面内存 Map，不使用 localStorage 或 IndexedDB 保存长期令牌；刷新页面后需要重新配对。
- Android Keystore 密钥不随普通应用备份迁移。换机或系统恢复后若无法解密，需要重新配对设备。

## 接入

`scripts/sync-tiao-capacitor.ps1` 会在 Capacitor sync 前调用 `scripts/install-secure-storage.ps1`，复制 Java 源码并在 `MainActivity` 注册插件。

## 重要边界

- 该插件只解决本机令牌静态存储，不代表端到端加密，也不保护已解密并进入 JavaScript 内存的令牌。
- 当前尚未做真实 Android 编译和设备验收。
- 在 secure storage 原生插件编译、安装、读取、删除测试通过前，不得把设备 bearer token 持久化到浏览器存储。
- 不会自动上传 API Key、聊天记录或私密媒体。
