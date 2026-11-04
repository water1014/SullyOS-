# 宋祁 Local-first 同步协议 v1

状态：设计规格，尚未实现或部署。目标分支 feature/image-studio。
关联路线图：docs/companion-cloud-roadmap.md

## 1. 目标与边界

手机 IndexedDB 是主要数据源。阿里云 PostgreSQL 保存用户允许同步的副本、事件日志、设备游标和自主任务状态。客户端先本地提交，再异步同步。服务器不能整库覆盖手机。

现有 messages、diaries、room_notes、assets、characters、memory_nodes 等对象仓库保持原样；同步层使用独立 store 和适配器。Toy Control 暂缓，不属于本阶段交付范围。

## 2. 同步实体与默认策略

| entity_type | 本地来源 | 默认策略 |
|---|---|---|
| character_profile | characters | 仅本机；仅同步白名单资料字段 |
| message | messages | 仅本机；用户开启后同步文字，追加式 |
| diary | diaries | 仅本机；userPage / charPage 可分别同步 |
| room_note | room_notes | 仅本机；独立版本 |
| handbook_page | 手账相关 store | 仅本机；确认实际 store 后接入 |
| memory_summary | memory_nodes / event_boxes | 仅本机；只允许用户选中的文字摘要 |
| media_asset | assets / blob_assets | 默认不上传 |
| companion_task | 服务端任务表 | 云端状态，结果以事件回流 |

现有 Message 主键是本地自增数字，不适合作为跨设备主键。同步适配器必须为消息分配稳定 UUID syncId，保留本地 id 供 UI 使用。不能把一台设备的 IndexedDB 自增 ID 直接写入另一台设备。

RoomNote 当前字段包括 id、charId、timestamp、content、type、relatedMessageId。DiaryEntry 包含 userPage、charPage、date、timestamp、isArchived、autoSync 等字段。同步层保留现有业务字段，并单独维护版本元数据。

## 3. 本地同步元数据

通过 IndexedDB 加性迁移增加四个 store，不修改既有业务 store。

### sync_outbox
字段：eventId、entityType、entityId、operation、baseVersion、payload、createdAt、retryAt、attemptCount、state、lastErrorCode。
- eventId 首次入队生成，重试永远复用。
- payload 入队前执行同步策略和字段白名单过滤。
- state：pending / in_flight / blocked。
- 错误只保存稳定错误码，不保存完整 HTTP 响应、密钥或正文。

### sync_inbox
字段：eventId、serverSequence、entityType、entityId、operation、entityVersion、payload、receivedAt、appliedAt、applyState。
- pull 后先持久化 inbox，再应用业务数据。
- 应用失败保留 inbox，下一次启动继续处理。

### sync_state
字段：accountId、deviceId、lastPulledSequence、lastAckedSequence、lastSuccessfulSyncAt、syncPolicy、lastErrorCode。

### sync_conflicts
字段：conflictId、entityType、entityId、localVersion、remoteVersion、localSnapshotRef、remoteSnapshotRef、detectedAt、resolutionState。
快照保存在本地受控存储；不要把私密正文复制到诊断日志。

迁移必须非破坏性：只新增 store/index，不删除或重建 messages、diaries、room_notes、assets 等现有 store。

## 4. 事件信封

客户端事件字段：
- eventId：UUID，全局幂等键
- deviceId：已配对设备 ID
- entityType、entityId、operation
- baseVersion、clientVersion
- clientCreatedAt
- payload：经过同步白名单过滤的数据

operation 为 create / update / delete。delete 事件不带正文，只携带实体身份、baseVersion 和删除时间。payload 必须按 entityType 使用严格 schema 验证；未知字段拒绝或剔除，不能整对象无差别上传。

## 5. PostgreSQL 表

### accounts
id UUID PK、auth_subject UNIQUE、status、created_at。不保存明文密码。

### devices
id UUID PK、account_id FK、label、platform、app_version、token_hash、token_version、last_seen_at、revoked_at。每台设备独立令牌；服务端只存令牌哈希；撤销后立即拒绝该设备请求。

### sync_events
event_id UUID PK、account_id、device_id、server_sequence BIGSERIAL、entity_type、entity_id、operation、base_version、entity_version、payload JSONB、client_created_at、received_at。
UNIQUE(account_id,event_id)；索引(account_id,server_sequence)和(account_id,entity_type,entity_id)。

### sync_entity_heads
(account_id,entity_type,entity_id) 联合主键；current_version、last_event_id、deleted_at。

### device_cursors
(account_id,device_id) 联合主键；last_acked_sequence、updated_at。

### companion_tasks
id UUID PK、account_id、character_id、task_type、state、scheduled_at、lease_owner、lease_until、attempt_count、max_attempts、idempotency_key UNIQUE、payload JSONB、result_event_id。
state：pending / leased / running / completed / failed / cancelled。
索引(state,scheduled_at)和(lease_until)。

### provider_credentials
id UUID PK、account_id、provider、label、encrypted_secret、key_version、created_at、revoked_at。
只有用户明确允许云端自主任务使用时才保存。采用服务器主密钥 envelope encryption；解密仅在执行进程内存短暂发生。任务表只引用 credential_id，不放明文凭据。

### push_subscriptions
id UUID PK、account_id、device_id、platform、endpoint_or_token、encrypted_key_material、created_at、last_seen_at、revoked_at。

## 6. HTTP API 契约

所有用户端接口使用 TLS + 设备令牌；服务端校验 token_hash、account_id、device_id、revoked_at。任务内部接口使用独立服务身份，不接受普通设备令牌执行 claim。

### POST /v1/devices/pair
一次性短时配对码兑换设备令牌。配对码一次性消费，令牌只显示一次；服务端只存哈希。

### POST /v1/sync/push
请求包含 deviceId 和 events 数组。每条事件包含 eventId、entityType、entityId、operation、baseVersion、clientVersion、clientCreatedAt、payload。
响应逐条返回 accepted（含 serverSequence/entityVersion）、duplicate、conflict 或 rejected（稳定错误 code）。
- 相同 eventId 重放返回原结果，不重复写入。
- 服务端先检查该账号的 entity sync policy，再 schema validate。
- 单批事件数和字节数设上限；媒体文件不走此接口。
- 事件和 entity head 更新必须在同一数据库事务中。

### GET /v1/sync/pull?after={sequence}&limit={n}
按 serverSequence 升序返回游标之后的事件。客户端先写 inbox，再应用，再 ack；不得在下载 HTTP 成功时提前推进游标。

### POST /v1/sync/ack
请求包含 deviceId、appliedThroughSequence。服务端只接受不大于已下发最大 sequence 的 ack，并单调递增。

### GET /v1/sync/status
只返回游标、待同步数量、最后同步时间和稳定错误码，不返回正文或密钥。

### GET /v1/devices 与 DELETE /v1/devices/{id}
列出设备和撤销设备。撤销立即使该设备令牌失效。

### POST /v1/push/register
登记或更新该设备推送订阅。

### 内部任务接口
POST /internal/tasks/claim、POST /internal/tasks/{id}/complete。只允许服务端 worker 身份访问；claim 使用短租约，超时自动释放。

## 7. 冲突规则

| 数据 | 冲突规则 |
|---|---|
| message | 追加式，eventId 去重；编辑/撤回通过新事件表示 |
| diary | 同 baseVersion 并发修改时保留两份版本，生成 conflict 副本，用户选择合并 |
| room_note | 同 diary，不静默覆盖正文 |
| memory_summary | 自动整理只能产生候选新版本；用户手动修正优先 |
| character_profile | 字段级合并；API 配置和设备本地字段不参与同步 |
| delete | tombstone；所有有效设备 ack 或超过安全保留期后才能压缩 |

仅允许对明确标记为普通偏好的字段使用 last-write-wins。不得用于聊天、日记、便签和记忆正文。

## 8. 隐私与同步策略

每类数据提供：仅本机 / 同步文字 / 同步完整（仅对支持完整同步的类别开放）。
默认：
- 聊天、日记、便签、记忆：仅本机；用户单独开启后可同步文字。
- 图片、视频原件默认不上传。
- 私密图片和私密聊天附件永不进入普通同步队列。
- 原始屏幕截图/录屏帧默认只在手机临时处理，禁止默认上传。
- 屏幕识别摘要需要单独授权。
- API/MCP token、Cookie、自定义秘密请求头不随普通数据同步。
- 云端模型凭据必须独立授权、加密保存、可撤销。

提供暂停同步、查看云端副本、清除云端副本、撤销设备入口。清除云端副本需二次确认。

## 9. 现有 Worker 迁移

现有 worker/amsg、worker/proactive-push、worker/post-office 继续工作。阿里云 v1 先做设备认证、同步 API、事件日志和任务状态，不接管现有 AMSG Cron。

后续迁移采用影子计算：新 worker 先计算决策但不执行；比对结果后按任务类型逐项切换。每种逻辑任务同一时刻只能有一个调度 owner。主动消息使用 taskId + occurrenceId 幂等，防止重复发送。

## 10. 2 vCPU / 2 GiB 运行边界

初期：Fastify API + 一个低并发 worker + PostgreSQL + Caddy。不开 Redis，不运行本地 LLM/embedding/视觉模型。数据库连接池小、限制并发、日志轮转、备份加密并异机保存。数据库端口不暴露公网。部署前先做峰值内存和恢复演练。

## 11. 实施顺序与验收

1. 定义 TS 类型和 schema 校验。
2. IndexedDB 增加 sync_outbox / inbox / state / conflicts。
3. 先选 room_notes 做端到端同步试点，不直接同步全量聊天。
4. 建立 PostgreSQL 迁移、配对、push/pull/ack、撤销设备。
5. 加入 diary、handbook，再评估聊天和记忆摘要。
6. 加入任务租约和主动消息结果回流。
7. 与现有 AMSG 做影子比对后再逐项迁移。

验收：
- 断网、杀进程、重复上传和重复拉取不丢事件。
- 同一 eventId 上传多次只落库一次。
- 并发编辑日记/便签保留双方内容。
- 撤销设备立即失效。
- 私密媒体、未授权类别无法上传。
- Worker 重启不重复发送同一主动消息。
- 任何阶段不覆盖 master，不部署，不生成 APK。

## 12. 本阶段明确不做

不上传整个 IndexedDB；不上传私密媒体或屏幕原始帧；不把 API 密钥放入普通同步；不让云端直接控制 Android；不创建阿里云资源；不部署；不打 APK。
