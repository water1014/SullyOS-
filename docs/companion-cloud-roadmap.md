# 宋祁常驻后端与生活工具路线图

状态：设计基线与现有能力盘点；尚未部署阿里云、尚未改动现有功能。
目标分支：`feature/image-studio`
数据决策：手机本地 + 服务器同步（local-first）。
Toy Control：暂停开发，仅保留此前架构草案；不纳入当前里程碑。
APK：所有功能完成后的最后阶段。

## 0. 不重复造轮子：当前代码盘点

### 已存在，可复用
- 本地数据：`utils/db.ts` 使用 IndexedDB，已有 diaries、room_notes、handbook、messages、memory nodes、XHS activity 等存储。
- 交换日记：`apps/JournalApp.tsx`，包含 userPage / charPage、日记卡片回流聊天、归档进记忆宫殿。
- 手账模型：`types.ts` 中 HandbookPage / HandbookEntry 一类的跨角色手账模型；先检查完整实现再决定是否扩展。
- 房间便签和秘密纸条：`room_notes`、`components/chat/SecretNote.tsx`、`utils/secretNote.ts`。
- 待写入队列：`utils/pendingDiary.ts`，用于外部日记服务失败后的重试。
- 社交平台：`apps/SocialApp.tsx`、`apps/XhsFreeRoamApp.tsx`、`utils/xhsMcpClient.ts`、`utils/xhsMcpConfig.ts`。
- 通用 MCP：`utils/mcpClient.ts`、`utils/mcpFireCore.ts`，支持远程工具发现与调用。
- 主动消息：`worker/amsg/` 已有 Cron、agentic tool loop、主动消息和推送；`worker/proactive-push/` 是推送加速器。

### 当前缺口
- 已有第一版 local-first 本地同步底座：Outbox / Inbox / cursor / conflict policy，当前仅 room_notes 进入可选文字队列，尚无网络传输。
- 交换日记并不等于双方各自独立的日记与便签产品。
- 社交平台目前以小红书适配为主，尚需统一的平台连接器、权限分级与操作确认。
- 现有 AMSG Worker 已经负责部分主动任务调度；新增 VPS 不可再并行创建一套相同 cron，否则可能重复触发。
- 当前仓库的原生 Android 代码有限，整机屏幕感知需要单独的原生 Android 阶段。

## 1. 目标架构

手机是完整原始数据的主存储；阿里云 VPS 是持久任务与同步服务，不是手机数据库的替代品。

手机本地：
- IndexedDB 保留现有业务数据和完整本地记录。
- 新增 Outbox、Inbox、同步游标、冲突记录。
- 图片、视频等 Blob 默认留在本地；大文件另行选择性同步。
- 私密图片与私密聊天默认不进入普通云同步。

阿里云 2 vCPU / 2 GiB：
- HTTPS API（设备认证、增量同步、任务接口）。
- PostgreSQL（事件日志、任务、设备、同步元数据和用户选择同步的副本）。
- 轻量 Worker（自主任务、预约苏醒、记忆整理任务）。
- Caddy 负责 TLS 入口。
- 外部模型 API 负责推理；VPS 不运行本地大模型。
- 初期不部署 Redis、向量数据库或图像模型；通过限并发、任务队列和数据库索引控制内存。

职责分工：
- AMSG Worker 暂时继续服务现有主动消息/即时对话链路，保持兼容。
- VPS 先作为新同步与持久任务服务，不立即接管 AMSG 的现有 Cron。
- 完成任务幂等、推送验证和迁移测试后，再评估把哪些调度任务逐步迁移到 VPS。
- 任何时刻同一个逻辑任务只能有一个调度所有者；迁移期间用明确的 owner/version 标记防止双发。

## 2. Local-first 同步协议

每个同步实体至少包含：
- `id`：全局唯一 ID。
- `owner_device_id`：创建或最后修改设备。
- `local_version`：本地单调递增版本。
- `updated_at`：UTC 时间。
- `deleted_at`：软删除时间，可为空。
- `sync_state`：pending / synced / conflict / failed。

事件封套：
- `event_id`：UUID，服务端幂等去重键。
- `device_id`：已配对设备 ID。
- `entity_type`、`entity_id`、`operation`。
- `base_version`、`new_version`。
- `payload`：经过 schema 校验的数据。
- `created_at`。

核心接口建议：
- `POST /v1/devices/pair`：一次性配对码兑换设备令牌。
- `POST /v1/sync/push`：批量提交 Outbox 事件，逐条返回 accepted / duplicate / conflict / rejected。
- `GET /v1/sync/pull?cursor=...`：按游标拉取服务端事件。
- `POST /v1/sync/ack`：确认客户端已持久化某个游标。
- `GET /v1/devices`、`DELETE /v1/devices/:id`：设备列表与撤销。
- `GET /v1/tasks`、`POST /v1/tasks/:id/cancel`：任务状态与取消。
- `GET /v1/health`：不泄露密钥的健康检查。

同步规则：
- 先写本地数据库，再写 Outbox；网络失败不影响用户继续使用。
- 服务端按 event_id 幂等处理，重复上传不得重复生成消息或副作用。
- Inbox 先落本地事务，再 ack 游标，避免先 ack 后丢数据。
- 消息以不可变追加事件同步；编辑/撤回作为新事件。
- 删除使用 tombstone，并保留足够长的同步窗口，防止旧副本复活。
- 日记和便签按记录 ID / 字段版本合并；同字段并发修改生成 conflict，不静默 last-write-wins。
- 服务器生成的主动消息使用稳定 task_id + occurrence_id，客户端按唯一键去重。
- 图片 Blob 不混入事件 JSON；默认只同步元数据，用户明确选择后才上传文件。

## 3. 独立日记与便签

不要覆盖 JournalApp 的交换日记体验。新功能应建立在现有本地 store 上，明确区分：

1. 我的日记：用户自己的私人空间，默认不注入角色上下文、不上传云端。
2. 宋祁的日记：角色自主写作，标记生成来源、关联经历和时间；用户可查看、编辑或删除。
3. 共同日记：双方共同完成，允许选择性进入记忆宫殿。
4. 我的便签：用户留给宋祁的便签，可设为提醒、长期提示或仅自己可见。
5. 宋祁的便签：宋祁自主留下的便签，支持到期、置顶和已读状态。
6. 互留便签：双方可回复或引用，但不伪装成普通聊天消息。

隐私和上下文规则：
- 每条记录有 visibility：private / shared / character_only。
- AI 只能读取明确授权给角色的记录。
- private 记录不参与自动记忆提取。
- 用户可对单条记录执行“加入记忆宫殿”，并查看写入结果。
- 删除日记不自动删除聊天原文；两者通过明确关联 ID 管理。

## 4. 社交平台工具中心

复用通用 MCP 与 XHS 客户端，新增统一 Connector Registry，不为每个平台重写聊天工具循环。

平台分层：
- read：搜索、读取公开内容、读取用户自己的内容。
- draft：生成草稿、整理素材、预览发布内容。
- write：点赞、收藏、评论、发布等外部副作用。

权限规则：
- 默认启用 read。
- draft 不产生外部副作用。
- write 操作在前台逐次确认；后台自主任务不得执行 destructive / publish 类工具。
- Cookie、Token 和自定义请求头只存本机安全配置；如同步到个人 VPS，必须显式选择并使用服务器端加密密钥，日志绝不记录凭据。
- 每个平台单独授权、测试、撤销；连接失败不得显示假绿灯。
- 优先使用官方 API 或用户明确配置的 MCP 服务；不绕过登录、验证码、访问控制或平台风控。

第一批以现有小红书连接器为基准，补齐统一状态、授权范围、操作确认和故障恢复；后续平台逐个接入，不一次铺开。

## 5. Android 整机屏幕感知（独立阶段）

- 使用 Android 原生 MediaProjection 采集用户授权的整屏或选定应用。
- 每次会话都要由用户显式启动和授权，显示前台服务通知，提供醒目的停止操作。
- Accessibility 仅用于用户明确启用的辅助功能场景，不作为隐蔽监控替代品。
- 默认本地 OCR / 视觉摘要；原始截图不上传、不长期存储。
- 默认排除银行、支付、密码管理器、系统权限页等敏感应用；支持用户自定义黑名单。
- 锁屏、授权撤销、服务异常、用户停止时结束采集。
- 服务器只接收用户选择共享的结构化摘要，不接收持续原始屏幕流。
- Web/PWA 本身无法读取 Android 其他应用屏幕，必须在最后的原生 Android 集成阶段实现。

## 6. OpenCode Go 与模型路由

- 保留现有 GPT / OpenAI-compatible / Anthropic / NAI 配置。
- OpenCode Go 自定义请求头和稳定 session ID 已有客户端配置基础；后续接 VPS 时需为 server-side provider 建立独立凭据引用，不把明文 Key 放进任务表或日志。
- 模型任务按用途路由：前台聊天优先使用当前角色配置；后台心跳、记忆整理、日记草稿可配置专用低成本模型。
- 每个后台任务设预算、超时、最大重试和每日调用上限。

## 7. 里程碑与验收

P0：盘点与契约
- 锁定现有 IndexedDB 数据结构与迁移策略。
- 定义同步实体、事件封套、冲突策略、设备认证和撤销。
- 确认 VPS 与 AMSG Worker 的唯一调度职责。

P1：本地同步基础（本地底座已实现，端到端仍未完成）
- [x] Outbox / Inbox / cursor / conflict store 的加性迁移。
- [x] room_notes 文字白名单、显式 opt-in、稳定 eventId、断点恢复、游标单调合并。
- [x] 关闭同步时清理传输副本；标准备份恢复前清空旧队列/Inbox/冲突/游标，保留本机设备身份和本地授权偏好。
- [x] 每次安装稳定设备 ID、本机设备命名。
- [x] 云端 API 源码第一版：一次性配对码、独立设备令牌、设备列表/撤销、同步策略、push / pull / ack、服务端幂等与版本冲突响应。
- [x] PostgreSQL schema 源码：账户、设备、配对码、事件、版本头、设备投递/确认游标、账号序列水位。
- [ ] 前端配对界面、安全令牌存储、Outbox/Inbox 网络 transport 与完整 PostgreSQL 集成测试。
- [ ] 多设备断网/重连与端到端验收。

P2：VPS 同步与设备服务
- API、PostgreSQL schema、配对、撤销、健康检查。
- 不接管现有 AMSG Cron。
- 多设备断网/重连和重复事件测试。

P3：日记与便签
- 在现有 JournalApp / Handbook / room_notes 上扩展独立空间。
- 双方独立日记、互留便签、隐私可见性、选择性记忆归档。
- 离线可编辑、同步冲突可恢复。

P4：社交平台工具中心
- 统一连接器状态和权限分级。
- 小红书先行，读/草稿/写分级验收。
- 发布、评论等外部操作逐次确认。

P5：自主活动与通知整合
- 复用现有 AMSG agentic 能力。
- VPS 负责持久任务状态与恢复，逐步迁移前先验证单一调度所有者。
- 主动消息离线暂存、推送、客户端去重。

P6：Android 屏幕感知
- 原生 MediaProjection 服务、可见授权、敏感应用排除、摘要处理。
- 不做隐蔽采集，不将屏幕原始图像默认上传。

P7：最终整合与 APK
- 全量测试、性能与权限审查。
- 最后才生成 APK；本路线图阶段不做 APK。

## 8. 当前实现进度（2026-11-04）

- 本地同步代码：utils/localSyncStore.ts、utils/localSyncStore.test.ts、components/settings/LocalSyncSettingsPanel.tsx。
- 备份恢复钩子：标准数据恢复开始前清空旧传输状态；媒体补充导入不影响同步状态。
- PostgreSQL 结构：server/companion-sync/migrations/0001_initial.sql、0002_pairing_and_delivery.sql、0003_account_sequence_watermark.sql。
- API 源码：server/companion-sync/server.mjs、protocol.mjs；支持一次性配对、每设备独立令牌、设备撤销、显式同步策略、push/pull/ack。
- 协议单测：server/companion-sync/protocol.test.ts；CI 增加 Node 语法检查和协议测试。
- 以上均为源代码，不代表真实数据库集成或云端部署。迁移尚未执行，API 尚未运行，前端尚未连接。
- 阿里云仍未部署；不创建资源、不写入真实凭据。

## 9. 本轮执行边界

本轮只完成现状盘点与架构基线文档；没有创建阿里云资源、没有部署、没有改动 AMSG Worker 的 Cron、没有实现 Toy Control、没有生成 APK。后续代码任务必须继续在 `feature/image-studio`，不得改动 `master`。
