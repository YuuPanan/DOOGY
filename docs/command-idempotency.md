# 设备命令幂等与记录保留

本页说明设备上报策略和走失模式的网络重试处理，以及业务幂等缓存的有限保留期。SQLite/PostgreSQL 与 offline/API 使用相同合同；命令幂等阶段没有引入新业务表、依赖或外部服务，后续照护附件上传也沿用同一缓存期限。

## 命令接口与重试

以下两个接口可选提供 `Idempotency-Key`，统一前缀 `/api/v1`，仍要求当前用户 Bearer 登录及家庭写权限：

| 接口 | 首次请求的业务效果 |
| --- | --- |
| `PUT /devices/{id}/reporting-policy` | 创建一个期望策略版本和待执行设备命令 |
| `POST /devices/{id}/lost-mode` | 请求开启或关闭走失模式；执行状态仍依赖设备回执 |

客户端为一次业务意图生成一个键，在网络超时后保持键和请求内容不变；新的业务意图使用新键。键长度为 1–200 个字符。相同用户、接口和键，在有效窗口内用相同规范化内容重试，返回首次成功回执，不重复创建命令、会话或写审计。省略默认字段与显式提供同一默认值属于相同内容；同键异内容返回 `409 IDEMPOTENCY_CONFLICT`。

示例请求头及策略请求体：

```http
PUT /api/v1/devices/{device_id}/reporting-policy
Authorization: Bearer {access_token}
Idempotency-Key: {本次意图的唯一键}
Content-Type: application/json

{"mode":"home_idle","interval_seconds":600,"expires_in_seconds":300}
```

未提供键时保留原有行为。普通策略重复提交仍可能生成新版本；走失开启在当前会话有效时保持原有自然去重，但该行为不能替代跨会话到期的请求幂等。

## 当前权限、绑定和回执快照

每次请求在写事务内先校验当前写权限与绑定，再查缓存。离开家庭、被降为 viewer 或设备不再可访问时，旧键不能恢复访问权。规范化请求额外包含当前绑定身份；同一用户解绑后重绑，即使仍可写，同一未过期旧键也会冲突，不会重放旧绑定响应或把旧网络请求当成新命令。家庭所有权交接没有改变绑定，原 owner 若仍是有写权限的 caregiver，可以重放自己此前的回执。

缓存的是**首次请求回执**。设备后来应用、拒绝或超时，走失会话后来关闭或到期，旧键仍返回首次回执，不代表此刻仍为 pending 或走失仍开启。重放不会延长命令、会话或缓存期限，也不会重新开启已经到期的会话；旧关闭键不会结束后来新开的会话。读取实时状态使用：

- `GET /devices/{id}/reporting-policy`
- `GET /devices/{id}/commands/{commandId}`

正常的到期维护仍按原规则推进；例如走失到期会独立生成恢复策略命令和维护审计，这不表示旧请求重新开启了会话。

幂等不等于真实硬件已执行。offline 回执来源仍为 simulator，API 模式区分 device，未接真实下行时不能把本地命令合同当成现场验证。

## 通用幂等缓存保留期

`IDEMPOTENCY_TTL_HOURS` 默认 24，允许 1–720 的整数小时。保留期按首次成功记录的 `created_at` 计算；`created_at <= 当前时间 - 保留期` 即视为到期，等号包含在内。重放不更新创建时间。配置改变对现有记录按新的窗口生效。

连接同一数据库的 API、Worker 和维护进程应使用一致的 TTL。较短窗口的 Worker 会更早物理清理记录，其他进程配置较长窗口也不能恢复已经删除的回执；使用同一 `start.bat` 环境文件可让本次 API/Worker 继承相同配置。

这一窗口同时作用于现有十二个使用数据库幂等缓存的 HTTP 操作：

| 范围 | 接口 |
| --- | --- |
| 业务创建 | `POST /pets`、`POST /geofences`、`POST /care-records` |
| 照护维护 | `PATCH /care-records/{id}`、`POST /care-records/{id}/withdraw`、`POST /care-records/{id}/attachments` |
| 安全确认 | `POST /safety-events/{id}/ack` |
| 客服 | `POST /support/tickets`、`PATCH /admin/support/tickets/{id}` |
| 失败恢复 | `POST /ingest/events/{id}/retry` |
| 设备意图 | `PUT /devices/{id}/reporting-policy`、`POST /devices/{id}/lost-mode` |

到期键不再提供旧回执；相同键可以形成新的业务操作，客户端不能把它当作永久去重身份。失败事务不留下新的成功缓存。隐私删除和家庭保留等清理可能更早移除关联缓存，因此 24 小时是最长默认保留窗口，不是所有场景的最短保留保证。

照护编辑重放不重复新增修订或审计；记录一旦撤回，PATCH 在读取缓存前返回 `409 CARE_RECORD_WITHDRAWN`，旧成功键也不能绕过。撤回须同时满足当前写权限与原作者/家庭 owner 身份；原因去掉两端空白后参与比较。同原因重复撤回不产生新修订、审计或恢复日志，同一未过期键异原因先返回 `409 IDEMPOTENCY_CONFLICT`，无键或新键异原因返回 `409 CARE_RECORD_ALREADY_WITHDRAWN`。创建照护的旧键仍可返回创建时的首次回执，但不会重建或重新启用已撤回记录；读取当前状态使用 `GET /care-records/{id}`。完整合同见 [care-withdrawal.md](care-withdrawal.md)。

照护附件上传也可使用同一窗口。相同键须保持规范化文件名、内容类型、大小与文件 SHA-256 不变；重放只返回首次附件元数据，不重复保存文件、父记录修订或审计。缓存比较文件摘要并保存元数据回执，不保存另一份原始文件正文。当前权限与父记录有效状态在查缓存前检查；父记录撤回后，旧上传键也返回 `409 CARE_RECORD_WITHDRAWN`。无键或缓存过期后的上传属于新操作，会新增附件并占用每条记录最多 10 个附件的名额。接口与请求示例见 [care-attachments.md](care-attachments.md)。

设备遥测的 event_id/boot/seq 去重、设备命令回执的版本校验，以及对外推送的通知 ID 不改用这一缓存期限。一次性认证秘密继续排除：登录/刷新、邀请、设备令牌或绑定码签发、解绑返回的新绑定码，以及位置分享令牌等响应不能进入通用回执缓存。

## 自动清理与本地维护

Worker 每分钟清理到期记录。无 Worker 时，请求路径仍会在事务内判断键是否过期，不会因为物理行尚未删除而重放过期回执。维护入口可独立预览或执行：

```powershell
./start.bat .env privacy idempotency-preview
./start.bat .env privacy idempotency-clean
./start.bat .env.postgres privacy idempotency-preview
./start.bat .env.postgres privacy idempotency-clean
```

BAT 同步依赖、构建后执行维护并退出，不启动 API/Worker。CLI 使用所选数据库访问权限，处理该库所有用户的到期幂等记录，不需要用户 Bearer；输出仅包含截止时间、窗口、匹配和删除数量，不打印请求体、回执或键。预览不删除业务记录，但正常打开数据库仍会应用待执行迁移。

幂等缓存保留原创建时间；恢复后沿用当前窗口判断过期，不为旧缓存重新计算起点或补足窗口。当前双库结构和升级规则见 [数据库说明](postgres.md)。

## 适用边界

本功能不等同所有写接口均支持缓存幂等或全局限流，不保证永久期限或外部供应商只执行一次；生产持续容量和真实硬件控制需另外验证。
