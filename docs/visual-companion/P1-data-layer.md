# 宋祁视觉人格系统 · P1 数据层规格

> 状态：P1 本地数据层第一批已实现。`feature/image-studio` 已加入 v75 IndexedDB 增量建表、标准视觉数据备份/恢复隔离和 GC 引用保护；尚未进行真实浏览器迁移验收，不触碰 Worker 生产环境。

## 1. 本次源码核验基线

- 分支：`feature/image-studio`；正式分支：`master`。
- `utils/db.ts` 当前声明 `DB_VERSION = 75`，数据库名为 `AetherOS_Data`。v75 新增 6 个视觉相关 Store，不改写聊天、旧画廊或原 Blob 数据。
- 已有 `blob_assets`，通用 BlobRef 令牌为 `blobref:<id>`，新生成 ID 使用 `b_` 前缀。
- `utils/blobGc.ts` 当前的引用白名单是 19 个 Object Store（不是数据库总 Store 数），并扫描 localStorage 全量值。
- `utils/backupBlobs.ts` 已有 v3 Blob 旁路备份：JSON 保留令牌，二进制写入 `blobs/<id>`，索引为 `blobs/index.json`。
- 旧生图室仍独立使用 `image-studio:studio_*` 资产 ID、`blob_assets` 二进制及 localStorage 画廊索引；不能把旧 ID 当成 `blobref:` 令牌。
- `DB.saveMessageOnce(deliveryId, message)` 已存在，可作为主动图片消息投递的幂等入口。
- 当前生图室 API 凭据（含自定义请求头）保存在 localStorage。不得把现有配置直接复制到云端任务记录。

## 2. 数据边界

采用“本地角色视觉资料 + 云端任务编排 + 独立图片资产”三层：

| 层 | 责任 | 不应保存 |
|---|---|---|
| IndexedDB | 角色视觉档案、视觉记忆、企划/分镜、本地任务镜像、标准资产元数据 | 云端 Provider 密钥明文 |
| Worker / D1 | 任务状态、幂等键、重试时间、预算账本、投递状态 | 图片二进制、私密图明文、前端 API Key |
| R2 / 独立私密存储 | 标准图片资产；私密资产独立命名空间并加密 | 聊天消息正文作为文件名或公开 URL |

**隐私隔离必须是存储边界，不只是 UI 标签。** 私密资产不进入普通画廊、标准 Blob GC、标准导出包、普通消息预览缓存或公共 URL。私密图片的密钥版本和加密元数据与资产记录绑定；任何密钥缺失/解密失败都应 fail closed，不回退到明文。

## 3. 本地 IndexedDB Store（v75 已建表）

本次 v75 迁移只在 `onupgradeneeded` 中按 Store/索引存在性增量创建；没有 clear/delete 既有 Store，也没有改写现有记录。实际用户浏览器升级仍须经过回归验收。

| Store | KeyPath | 关键索引 | 用途 |
|---|---|---|---|
| `visual_profiles` | `id` | `charId`, `charId_version` | 角色视觉身份版本 |
| `visual_memories` | `id` | `charId`, `charId_status`, `charId_category` | 视觉记忆及确认状态 |
| `visual_projects` | `id` | `charId`, `charId_status` | 写真企划和分镜 |
| `visual_task_mirror` | `id` | `charId`, `status`, `updatedAt` | 云端任务的本地镜像/恢复游标 |
| `visual_assets` | `id` | `charId`, `privacyScope`, `taskId`, `projectId` | 资产元数据，不存二进制 |
| `private_visual_blobs` | `id` | `charId`, `createdAt` | 私密加密二进制容器，独立于普通 Blob GC/备份 |

私密二进制不复用普通 `blob_assets` 的 GC 生命周期，v75 已预留独立 `private_visual_blobs` Store；实际写入前仍须实现加密容器，并单独定义访问、备份、清理和恢复流程。若选择云端 R2 私密桶，必须使用服务端授权短时访问，不生成永久公开 URL。

## 4. 本地仓库实现

`utils/visualCompanion/repository.ts` 提供带领域类型的本地读写入口：

- 角色视觉档案、视觉记忆、写真企划：按角色索引查询，支持单条读写。
- 写真分镜：只更新目标 shot，不允许改变分镜 ID。
- 视觉任务：通过显式状态转换表推进，拒绝跳过阶段的非法转换；角色 ID、deliveryId、隐私范围和创建时间在状态更新时不可被覆盖。
- 视觉资产：标准资产必须使用 `blobref:`；私密资产必须使用独立存储引用并提供密钥版本。
- 私密资产不能通过普通删除入口移除元数据，必须等待私密保险库实现原子化加密销毁。
- `utils/visualCompanion/orchestrator.ts` 提供本地任务编排：创建幂等任务、认领排队任务、生成结果登记、资产保存完成、投递完成、失败重试、按失败阶段恢复、审批和取消。
- 重试检查点保存 `retryStage`。聊天投递失败恢复到 `delivery_pending`，不得回退到 `generating`；任务创建使用稳定 deliveryId 派生任务 ID，并通过 IndexedDB `add` 原子防重。
- 该编排器目前只管理本地元数据，不调用 Provider、不执行后台任务、不投递聊天消息。跨设备/浏览器关闭后的可靠执行仍需独立 Worker + Queue；实际聊天投递适配器必须复用 `DB.saveMessageOnce(deliveryId, message)`。

测试覆盖 v74→v75 升级保留旧聊天/画廊/Blob、标准备份隔离、任务状态转换和资产隐私边界。CI 对应测试文件为 `utils/visualCompanion/data.test.ts`、`utils/visualCompanion/repository.test.ts` 和 `utils/blobGc.test.ts`。

## 5. 云端 D1 任务表候选

建议由视觉任务 Worker 管理以下表（实际 SQL 以现有 Worker 依赖和迁移机制核验后再写）：

- `visual_tasks`：任务主记录、状态、角色、隐私范围、Provider 配置引用、模型、重试计数、预算上限、幂等 deliveryId。
- `visual_task_events`：状态变化审计、错误码、时间戳；禁止记录密钥、完整私密提示词或图片二进制。
- `visual_deliveries`：任务到聊天消息的投递状态、消息 ID、投递重试次数。
- `visual_budget_ledger`：每次生成实际扣费和预留额度，按任务 ID 幂等入账。

所有表都要有稳定主键、`char_id`、`created_at` / `updated_at`。对 `status + next_attempt_at`、`char_id + created_at`、`delivery_id` 建索引/唯一约束。不要把视觉任务硬塞进现有聊天任务状态表，避免旧主动消息执行器误领生图任务。

## 6. 任务状态机与幂等

合法主路径：

`queued → planning → awaiting_approval? → generating → persisting → delivery_pending → delivered`

异常路径：

- 可恢复错误：`generating/persisting/delivery_pending → retry_wait → 原阶段`
- 用户取消：非终态阶段 → `cancelled`
- 不可恢复错误：非终态阶段 → `failed`

关键约束：

1. 生成、保存资产、聊天投递是三个独立阶段。
2. Provider 成功后先持久化资产和任务结果，再创建消息投递。
3. 投递使用固定 `deliveryId` 调用 `DB.saveMessageOnce()`；重试投递只重试消息写入，不重新生成、不再次扣费。
4. 生成请求超时但结果未知时，先向 Provider/任务服务查询或标记为待核对，不能盲目重新生成。
5. 每次状态变化都写事件记录；任务状态更新使用条件更新/版本号，避免 Worker 并发重复执行。
6. 预算预留、实际扣费和退款/释放必须使用任务 ID 幂等。

## 7. 旧生图室兼容

旧画廊索引键：

- `sully-image-studio:config:v1`
- `sully-image-studio:items:v1`
- `sully-image-studio:nai-templates:v1`

旧资产 ID 形如 `image-studio:studio_xxx`，二进制位于现有 `blob_assets`。迁移策略：

1. 只读旧索引，保留原始 ID、提示词、模型参数、收藏、分类、备注和创建时间。
2. 逐条核验旧 Blob 存在且可读取；缺失资产记录为 `missing`，不得伪造空图。
3. 写入新资产后校验字节数/checksum，再建立新元数据引用。
4. ZIP v1 导入导出继续可读；v3 Blob 旁路只处理合法 `blobref:` 令牌，不能把 `studio_*` 直接拼成令牌。
5. 迁移报告确认数量和校验值一致后，才可讨论清理旧引用；第一版不删除旧资产、不自动迁移、不更改 localStorage 画廊。

## 8. GC 与备份必须同步更新

新增任何可能存放 `blobref:` 的字段或 Store，必须同时更新并测试：

- `utils/blobGc.ts` 的 `REF_SOURCE_STORES` 与 `iterateRefSources()`。已把 `visual_assets` 纳入普通引用扫描，防止标准资产的 `blobref:` 被误判为孤儿；`private_visual_blobs` 不进入普通 GC。
- `utils/blobDedupe.ts` 的引用改写/不可合并引用检查。
- `utils/backupBlobs.ts` 所依赖的序列化收集路径。
- 全量备份导出和恢复流程（`utils/db.ts`）。
- 私密资产必须走独立 GC 和独立备份，不得被标准 GC 当作普通孤儿清除。

若某个新 Store 暂时没有 `blobref:` 字段，也应在测试中明确证明；不能仅因当前没有数据就跳过未来引用面的评估。

## 9. API 凭据边界

现有 GPT / NAI / 自定义请求头配置位于 localStorage。未来云端执行不得直接读取或上传这份明文配置。应采用服务端凭据库/加密封装：

- 前端只保存不可逆的配置 ID 和展示用名称。
- 云端密钥按用户隔离、加密存储，访问控制限定到视觉任务执行器。
- 日志、任务事件、错误信息、普通备份和聊天消息均不得包含 API Key 或自定义请求头值。
- 导入旧配置时由用户明确选择“仅本机使用”或“安全迁移到云端”；默认不上传。

## 10. P1 验收门槛

- [ ] v74 老库升级后原有 67 个 Store（以运行时枚举为准）和全部索引仍存在。
- [ ] 新增 Store/索引迁移可重复执行且不会清空旧数据。
- [ ] 旧生图室画廊、ZIP v1、收藏/分类/备注均可读。
- [ ] 普通 Blob GC 不会删除私密资产；新增标准引用可被 GC 和去重测试识别。
- [ ] 全量备份导出/恢复覆盖新 Store；私密资产不混入普通备份。
- [ ] 重复 deliveryId 不会生成重复聊天消息。
- [ ] 任务投递失败重试不触发二次生图和二次扣费。
- [ ] API Key、自定义请求头不会出现在日志、D1 任务行、聊天消息或普通备份中。

## 11. 本阶段不做

不改 Worker 生产部署、不创建 R2 桶、不新增实际 D1 表、不搬运/删除旧图片、不把私密图片接入普通画廊。v75 代码迁移已加入分支，但在真实浏览器、旧库和备份恢复测试通过前，不应视为已完成用户侧升级验收。
