# Toy Control Android

这是一个独立 Android App 的源码工程预留目录。目标是独立管理 BLE 设备，并通过受签名权限保护的 Android Bound Service 向 SullyOS 提供本机工具能力。

当前状态：架构已定，设备协议适配器尚未实现。不要在没有确认设备型号和协议来源前发送任何 GATT 控制数据。

## 产品原则

- 独立 App 可单独启动和使用。
- SullyOS 通过 Capacitor 原生插件访问 Bound Service。
- 默认不启动设备；AI 工具调用只能创建待确认请求。
- 停止优先级最高，断连和超时自动停止。
- 不开放公网 HTTP 控制端口。
- APK 在整个项目最后阶段生成。

## 待实现模块

- Compose 主界面、设备扫描与连接
- BLE GATT 管理
- 设备协议适配器（按已确认型号实现）
- 本地控制授权与安全状态机
- signature-protected Bound Service
- SullyOS ToyControlBridge Capacitor 插件
- 设备模拟器与协议单元测试

详见 ../../docs/toy-control-android.md。
