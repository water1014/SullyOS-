# Toy Control Android App 与 SullyOS 原生工具桥接方案

状态：设计基线（尚未部署、尚未生成 APK）
目标分支：feature/image-studio
独立应用包名建议：com.aetheros.toycontrol
SullyOS 包名：com.aetheros.simulator

## 1. 产品边界

Toy Control 是独立 Android 应用，同时向 SullyOS 提供一个本机 MCP-compatible 工具入口。

- Toy Control 独立启动、独立展示蓝牙权限、扫描、配对、连接和设备状态。
- SullyOS 只显示设备连接状态与可用工具入口；不复制第二套 BLE 协议实现。
- BLE 连接与设备协议只由 Toy Control 持有。
- 阿里云不直接连接蓝牙设备，也不允许云端直接启动设备。
- APK 打包放在项目最终阶段；本阶段只做源代码和接口设计。

## 2. 为什么采用 Android 原生 Binder Bridge，而不是 localhost HTTP MCP

SullyOS 现有通用 MCP 客户端只支持远程 Streamable HTTP handshake-era 协议；它不支持 stdio。SharkOS 的 toy-mcp 使用本地 Python HTTP 服务，并声明 MCP 2024-11-05。直接复用会遇到协议版本与 Android 运行环境问题。

本项目采用：
1. Toy Control 暴露仅限本机应用间访问的 Android Bound Service / Binder API。
2. SullyOS Capacitor 原生插件 ToyControlBridge 通过显式包名绑定服务。
3. 插件把 Binder 能力转换成 SullyOS 内部 MCP-compatible tool descriptors 和 tool calls。
4. 不打开公网端口，不把 BLE 指令交给云端，不依赖浏览器 localhost/CORS。

跨应用服务必须用 signature-level permission 限制调用方。两个 APK 发布时需由同一签名证书签名；不匹配时应拒绝连接并在界面解释原因。禁止使用 exported=true 且无权限保护的控制服务。

## 3. 模块结构

```
native/
  toy-control-android/           # 独立 Android Studio 项目
    app/
      src/main/
        AndroidManifest.xml
        java/com/aetheros/toycontrol/
          MainActivity.kt
          ui/                    # Compose UI
          bluetooth/             # BLE 扫描、连接、GATT
          protocol/              # 设备厂商协议适配器
          safety/                # 授权、限幅、会话计时、立即停止
          service/               # Bound Service / Foreground Service
          storage/               # 本地配对设备与用户偏好
        res/
    build.gradle.kts
    settings.gradle.kts
  android/
    toy-control-bridge/          # SullyOS Capacitor 原生插件源
      ToyControlBridgePlugin.java
      README.md

apps/
  ToyControlEntry.tsx            # 糯米机内的入口页（设备状态、打开独立 App）

utils/
  toyControlBridge.ts            # 前端能力封装、工具定义和调用适配
```

注意：仓库当前没有完整的 Android Studio 工程；现有 native/android 目录只包含少量原生插件源码。独立 App 应建立自己的 Gradle 工程，不能假设 Capacitor 的生成目录已提交到仓库。

## 4. 工具契约

第一版只暴露最少必要能力：

| 工具 | 能力 | 执行规则 |
|---|---|---|
| toy_device_status | 读取连接、设备型号、电量（若协议提供）和运行状态 | 只读 |
| toy_scan_devices | 搜索附近兼容设备 | 必须先有 Android 附近设备权限 |
| toy_connect_device | 连接用户选中的设备 | 必须在 App 内选择设备 |
| toy_request_control | 提交一次控制请求 | 只创建待确认请求，不直接启动 |
| toy_session_status | 查询当前会话状态 | 只读 |
| toy_stop | 停止当前会话 | 允许立即执行，优先级最高 |
| toy_disconnect | 断开设备连接 | 不得在运行中跳过停止流程 |

不提供云端启动、无人值守启动、隐蔽控制或后台自动恢复运行。

## 5. 安全与同意

- App 首次使用时说明 BLE 权限用途，并由 Android 系统弹窗请求 BLUETOOTH_SCAN / BLUETOOTH_CONNECT。
- 不请求位置权限，除非实际扫描实现确实依赖并且经审查需要。
- AI 工具调用只生成待确认卡片；用户在 Toy Control App 中确认后才发送控制命令。
- 用户在 App 内按下停止、通知栏停止，或 SullyOS 发出停止请求时，立即发送设备停止指令。
- 停止指令不得等待模型、云端或 UI 动画。
- 每次运行设硬性最长时长、强度上限、断连停止、超时停止和进程重启安全态。
- 设备连接/运行期间若使用前台服务，必须显示持续通知及停止动作。
- 未连接、协议未知、设备异常或停止命令未确认时，不允许继续启动。
- 本机 Binder 服务使用 signature permission 和显式组件；不暴露公网 HTTP 端口。
- 日志不记录 BLE 原始数据、令牌或敏感控制参数。

## 6. Android 适配

- Android 12+ 使用 BLUETOOTH_SCAN / BLUETOOTH_CONNECT 运行时权限。
- 设备配对优先评估 Companion Device Manager；需要自定义扫描和 GATT 控制时再使用 BluetoothLeScanner / BluetoothGatt。
- 长时间保持 BLE 连接时才启用 connectedDevice 类型前台服务，并展示通知；用户停止后立即关闭服务。
- 处理蓝牙关闭、权限撤回、设备离开范围、GATT 断开、服务被系统回收等情况。
- 适配 Android 16 设备并向下兼容合理 API 范围。

## 7. SullyOS 入口

糯米机增加「Toy Control」独立 App 入口：
- 已安装：显式 Intent 打开 Toy Control。
- 未安装：展示安装/配对说明，不显示虚假的已连接状态。
- 已授权：读取状态、显示可用工具。
- 未授权或签名不匹配：只显示原因和重新授权指引。
- 不在普通 Web 页面内模拟 BLE 控制。

## 8. 与云端后端的边界

阿里云只保存可选的非敏感设备元数据，例如设备别名、用户自选同步状态和工具版本；默认不上传设备标识、BLE 地址、运行细节或原始控制数据。

云端任务不能直接调用 toy_request_control。即使角色在云端提出请求，也必须回到本机，由用户在 Toy Control App 确认。停止请求可以通过本机入口优先处理，但云端离线时本地停止仍必须可用。

## 9. 验收条件

- 未授予权限时不会扫描或连接。
- 未安装 Toy Control 时 SullyOS 不显示假连接。
- 非同签名应用无法绑定控制服务。
- AI 请求不能绕过 App 内确认。
- App 内停止和通知停止可立即生效。
- BLE 断连、App 崩溃、计时到期均进入安全停止状态。
- 设备协议未知或设备型号不匹配时拒绝发送控制命令。
- SullyOS 和 Toy Control 可独立启动、独立退出。
- 不生成 APK，直到项目最终打包阶段。
