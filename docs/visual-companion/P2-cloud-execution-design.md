# P2 · 云端视觉任务执行设计

状态：设计核验阶段，尚未部署、尚未接收 Provider 凭据。

## 目标

让已授权的主动分享任务在用户关闭页面、切换设备或系统挂起后仍能继续；任务状态、图片资产与聊天投递都必须可恢复、可幂等、可审计。

## 已核验的现有基础设施

- 主动消息 Worker 已绑定 D1（`DB`），现有任务、`client_state` 与 outbox 由同一 Worker 管理。
- Worker 已使用 `AMSG_MASTER_KEY` 与用户身份派生加密密钥；前端的 `ReiClient` 已有加密/解密桥接。
- 前端 `activeMsgClient.writeClientStateValue` 可以复用现有 Worker 连接与加密状态写入路径。
- Worker 已有 `InstantTickDO`：每个任务 UUID 一个 Durable Object 实例，通过 alarm 在独立 invocation 中运行；现有代码将其作为无需额外创建资源的长任务执行模式。
- 当前 `wrangler.toml` 只有 D1 与 Durable Object 绑定，没有 R2 bucket，也没有 Queue consumer。
- 当前视觉任务和图像二进制仍保存在浏览器 IndexedDB / BlobRef；页面关闭后不能由 Worker 读取。

## 建议架构

1. **任务控制面：D1**
   - 新增 `visual_tasks` 与 `visual_deliveries` 表。
   - 使用条件 UPDATE 原子认领任务；任务状态与 `deliveryId` 唯一约束保证幂等。
   - 记录阶段检查点：queued、generating、persisting、delivery_pending、delivered、retry_wait、failed。
   - 服务端重试使用退避时间，不依赖浏览器 timer。

2. **执行面：复用 Durable Object alarm 模式**
   - 增加独立视觉任务 DO namespace，每个 taskId 一个实例。
   - HTTP 请求只负责验权、落库、kick alarm 并返回 202。
   - alarm 执行 Provider 请求；异常写回 retry checkpoint，下一次 alarm / cron 继续。
   - 不与聊天任务共用状态机，避免视觉失败影响聊天投递。

3. **Provider 凭据**
   - 不把 API Key 或 custom headers 放进 task、outbox、普通日志。
   - 复用加密的 `client_state` 写入机制，使用独立 namespace/key 保存 GPT、NAI 官方、NAI 第三方配置。
   - Worker 运行时读取并解密，按 providerConfigId 选择配置；删除/换 Key 时同步清除旧配置。
   - 需要做配置版本、更新时间、设备同步状态与失效提示。
   - 不能把现有浏览器 localStorage 直接复制到 D1 明文，也不能把 `AMSG_MASTER_KEY` 或解密后的 Key 返回前端。

4. **图片资产：R2**
   - 新增私有 R2 bucket 保存生成结果；D1 只存对象 key、尺寸、MIME、checksum、taskId。
   - Worker 提供经过用户身份与共享密钥校验的读取端点；不能生成公开永久图片 URL。
   - 资产读取、过期清理、删除、备份策略都需要与 task 生命周期一致。
   - 私密图片必须使用单独的加密对象格式与独立权限路径；现有 `private_visual_blobs` 不能视为已加密保险库。

5. **聊天送达**
   - Worker 先写入唯一 delivery 记录，再发送只含 taskId/assetId 的事件。
   - 客户端收到事件后，通过受保护端点取图、保存到本地 BlobRef，再用现有 `DB.saveMessageOnce(deliveryId, ...)` 幂等插入聊天消息。
   - 客户端确认后回执 messageId；重复推送只返回已有消息，不重复生成、不重复插入。
   - 页面离线时 delivery 保持 pending，重连后继续领取。

## 必须先解决的外部资源与风险

- 必须创建并绑定 R2 bucket；当前仓库没有现成 R2 绑定。不能只改代码就宣称云端图片存储可用。
- 需要明确 Worker 的用户身份、`X-Client-Token`、加密状态读写和图片读取端点的验权边界。
- 图片 Provider 的自定义 Base URL 属于 SSRF 风险入口：云端执行必须限制协议、阻止 localhost/private/link-local IP、限制重定向，并对第三方域名做 DNS/IP 复核。
- API Key 和自定义头不能进入 D1 明文、任务 payload、错误消息或 Cloudflare 日志。
- 需要定义 R2 生命周期、单图/每日额度、并发限制、取消语义、Provider 429 不重试策略与用户可见账单。
- 私密图的服务端执行与静态加密方案未完成前，不开放私密云端任务。

## Provider 合规边界

- NovelAI 官方 API 文档要求图像生成由人类动作发起；因此 NAI 只用于用户明确点击发起的图像任务，不进入定时自主分享路径。
- NAI 第三方兼容服务需逐一核实其服务条款；在确认前同样不进入自主分享。
- 当前主动自动分享仅使用用户配置且已授权的 GPT Provider。

## 当前结论

本阶段先不添加 R2/DO 绑定、不接收云端 Provider Key、不修改 Worker 部署配置。下一步应先实现 D1 task schema、验权与加密 Provider 配置读写的单元测试；确认 Cloudflare R2 bucket 可创建后，再接入对象存储与 DO 执行器。这样不会出现任务已入队但密钥、图片存储或聊天送达链路缺失的半成品。
