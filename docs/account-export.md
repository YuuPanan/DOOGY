# 账号与授权家庭数据导出

登录用户可在 Web 或本地终端导出本账号与获准读取的家庭资料。SQLite/PostgreSQL 和 offline/API 四种组合采用同一权限与分页规则。分区以导出清单为准。

## Web 自助导出

点击顶部「数据导出」，核对本人账号、各授权家庭的名称与角色，点击分区数可展开分区名称。点击「生成导出文件」。浏览器按清单生成时间作为上界，通过现有接口逐页读取，包含授权照护附件的正文。所有页面成功读完后，页面显示记录数与分区数，再点击「下载 NDJSON」保存。如果后续请求因撤权、登录失效或网络中断失败，重新打开「数据导出」可获取新清单。

Web 和终端生成的 NDJSON 都包含清单、记录、各分区计数、完成标记和内容 SHA-256。从 Web 下载的文件保存在浏览器选定的位置。浏览器在当前标签页组装文件，并通过 Web Crypto 计算校验值，使用本机启动地址即可。大量记录或附件可用逐页写入的终端命令。[本地导出命令](#本地导出)

## API 与权限

接口统一前缀 `/api/v1`，使用用户 Bearer 登录令牌，响应设置 `Cache-Control: no-store`：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /auth/data-export` | 返回导出清单、生成时间、个人分区、当前家庭及其可导出分区、排除项 |
| `GET /auth/data-export/{section}` | 按分区和当前权限读取一页业务记录 |

家庭分区通过 `household_id` 指定目标，不能用另一个家庭的游标或分区名绕过权限。每一页都重新检查当前身份和家庭访问权；退出家庭或被撤权后，旧清单与游标不恢复原访问权。清单列出的个人资料、家庭与分区，不构成永久访问授权。

分页参数为 `limit`（1–200，默认 200）、`cursor`、`household_id` 和 `snapshot_at`；`care_attachments` 因包含文件正文，每页最多返回 1 条，即使请求更大的 `limit` 也按 1 条分页。首次读取每个分区时，将清单的 `generated_at` 作为 `snapshot_at`；后续游标保留该上界，重复提供时必须相同。页面返回 `section`、`household_id`、`generated_at`、`items` 和 `next_cursor`。持续读取到 `next_cursor=null` 才完成该分区，不能只取第一页就称完整导出。游标同时绑定用户、分区和家庭，不能混用于其他范围。

清单读取会新增一条 `account.export.requested` 审计，用于记录发起者和家庭范围；它不修改用户业务记录或保存导出文件、令牌及原始内容。

## 业务分区

实际分区类型和数量以当前清单为准；下表列出主要分区，后续资料、内容、媒体和配置增量也通过清单提供。同一账号加入多个家庭时分别读取各家庭范围。各分区选择明确的业务字段，JSON 文本转换为结构化字段，布尔值采用 JSON 布尔类型：

| 范围 | 分区 | 内容 |
| --- | --- | --- |
| 个人 | `profile`、`sessions` | 本人资料与会话时间元数据，不包含密码或令牌散列 |
| 个人 | `password_recovery_requests` | 本人找回申请的模式、投递/验证/消费/失效时间元数据，不含email_hash、token_hash、失败计数或原始验证材料 |
| 个人 | `notification_preferences`、`push_token_metadata` | 通知偏好、终端平台和创建时间，不包含推送令牌 |
| 个人 | `owned_devices` | 本人拥有的设备主档与安全凭证元数据，不带位置或密钥 |
| 个人 | `support_tickets`、`support_history` | 本人工单与回复历史，排除诊断快照 |
| 个人 | `notifications`、`feedback`、`audit` | 本人当前可见通知、本人且仍有宠物家庭权限的反馈、本人审计动作/资源/时间；不带审计原始 metadata |
| 家庭 | `households`、`members`、`pets` | 家庭、当前成员、宠物档案与时区 |
| 家庭 | `devices`、`device_bindings`、`device_state` | 当前绑定设备、宠物绑定历史、设备缓存时间/电量等白名单状态 |
| 家庭 | `device_events` | 当前家庭宠物的消息时间、绑定身份、处理状态/次数和错误等元数据，包含失败或尚未投影消息，不含 payload/envelope/source_metadata |
| 家庭 | `locations`、`activity_samples` | 定位与质量标记、结构化活动样本，排除原始 signal/metrics |
| 家庭 | `geofences`、`geofence_evaluations` | 围栏配置和判断记录 |
| 家庭 | `safety_events`、`safety_acknowledgements` | 事件时间线、位置引用、关闭原因 `closed_reason` 与人工确认。旧记录的未知原因保留为 `null`，不附原始事件详情快照 |
| 家庭 | `care_records`、`care_record_revisions` | 有效及撤回的照护记录、如厕与自定义事项、人工备注、撤回标记与修订版本 |
| 家庭 | `care_attachments` | 照护附件元数据与 base64 文件正文，包含仍有权限读取的撤回记录附件；每页最多 1 条 |
| 家庭 | `reporting_policies`、`device_commands`、`lost_mode_sessions` | 策略、命令及走失会话历史 |
| 家庭 | `contact_alerts`、`contact_alert_recipients` | 用户文字请求、作者及期限、逐人选择版本/状态/尝试和错误；按当前家庭权限，不展开联系地址 |
| 家庭 | `daily_summaries`、`activity_observations` | 已保存的日摘要和活动观察，不为导出额外回算 |
| 家庭 | `location_shares` | 仅 owner/caregiver 可导出的分享元数据，始终排除访问令牌及散列 |

viewer 的清单不列出 `location_shares`，直接请求该分区也不能绕过原有写权限。导出当前允许读取的家庭业务数据，不恢复离开家庭后的共享访问；本人拥有的设备元数据与家庭位置访问范围仍分别判断。

`care_records` 包含 `withdrawn_at`、`withdrawn_by` 和 `withdrawal_reason`；有效记录三项为 `null`。默认照护列表会隐藏撤回记录，授权导出仍保留它们及既有修订，便于理解共享记录的变更。旧备份经日志补写的撤回可出现 `withdrawn_by=null` 和固定原因“恢复撤回记录”，表示原始操作者及原因无法从最小恢复日志还原，详见 [care-withdrawal.md](care-withdrawal.md)。

照护类型扩展后，`care_records` 的字段白名单增加 `custom_type`：`type=custom` 时为该条记录的名称，其余类型和旧记录为 `null`。`type=toileting` 的 `value.kind` 区分排尿、排便和两者。修订快照保留当时记录的名称与内容；升级前保存的旧快照可能没有 `custom_type`，不会补造历史名称。自定义名称只属于单条记录，导出权限和时间上界语义保持。字段与请求示例见 [如厕与自定义照护](care-types.md)。

附件通过独立的 `care_attachments` 家庭分区导出，文件正文使用 `content_base64`；解码后可按 `size_bytes` 与 `sha256` 核对原始字节。照护响应和修订中的 `attachments` 只携带元数据，正文不重复嵌入各个历史快照。上传前的历史可能没有附件或没有 `attachments` 字段，不能据此补造当时文件。导出文件因此可能明显增大，base64 正文约为原始文件的 4/3；本地命令继续逐页写入，每个附件页最多一条。上传、下载、历史与原生备份合同见 [照护记录附件](care-attachments.md)。

敏感认证材料不作为导出内容：密码和认证散列、设备长期令牌及散列、访问/刷新令牌、推送明文令牌、邀请与分享访问秘密均排除。原始遥测、signal、临时诊断和短期授权等排除项由清单说明；导出不通过备份表的全量复制扩大用户权限。

## 本地导出

从所选数据库登录获取当前账号的访问令牌，仅在当前终端设置 `DOOGY_ACCESS_TOKEN`。令牌应属于所选环境文件连接的那套数据库；不能拿另一套数据库的登录结果导出此库资料。

```powershell
$env:DOOGY_ACCESS_TOKEN = '登录后取得的访问令牌'
./start.bat .env export-account ./data/exports/my-account.ndjson
Remove-Item Env:DOOGY_ACCESS_TOKEN
```

PostgreSQL 使用独立配置，保留原 `.env`：

```powershell
$env:DOOGY_ACCESS_TOKEN = '该PostgreSQL账号的访问令牌'
./start.bat .env.postgres export-account ./data/exports/my-account-pg.ndjson
Remove-Item Env:DOOGY_ACCESS_TOKEN
```

启动脚本同步依赖、构建后执行导出，成功后退出；该维护动作不需要启动 API/Worker 或调用外部供应商。省略输出路径时使用工具的时间戳默认路径。凭据不放在命令参数、源码、示例环境文件或普通日志中。

使用默认 `.env` 时，也可执行 `npm.cmd run export:account -- ./data/exports/my-account.ndjson`；该命令会自动构建。需要独立环境文件时优先使用上述 BAT 入口。

目标必须是不存在的新文件，不覆盖旧文件。输出按页写入并遵循流写入背压；失败时移除本次创建的未完成文件，原有文件不受影响。导出过程中登录过期、会话撤销或权限改变导致后续页面不可读时，不把半份文件当作成功结果。

## NDJSON 文件

文件按行保存 JSON 对象：第一行是 `type=manifest` 的导出清单；中间每条 `type=record` 带 `section`、`household_id` 和一条 `data` 业务记录；最后一行 `type=complete` 包含总 `rows`、各分区 `counts`、完成时间和 `content_sha256`。完成标记用于识别整次导出结束，不将只有若干有效行的文件当成完整结果。

`counts` 按 `section + household_id` 分别计数，个人分区的 `household_id=null`。Web 与命令摘要显示实际遍历的分区组合数量，包括零记录的组合；数量随家庭及角色变化。

`content_sha256` 覆盖完成标记之前的所有 NDJSON 字节，包括每行的换行；命令成功输出的 `sha256` 则覆盖整个文件，包含完成标记。两个摘要用途不同，不能直接比较为同一个值。完整文件摘要可使用 `Get-FileHash -Algorithm SHA256` 复核。

命令成功输出文件路径、记录数量及校验摘要，默认保存到被 Git 排除的 `data/exports/`。两个入口生成的文件都可能包含精确位置、宠物档案、人工备注与完整附件正文，应作为私有数据保存。

## 时间与恢复边界

同一次导出沿用清单的时间上界；有创建、接收或生成时间的分区用相应字段过滤新增记录。通知偏好等没有记录创建时间的设置按读取时值返回，设备当前绑定、策略和缓存状态也不是历史快照。分页读取不持有长事务，不回滚后续更新来恢复旧版本；记录更新、删除和权限变更仍可能影响后续页面，因此文件不保证整个数据库在某一时刻的事务快照。

该文件用于用户查看和携带授权业务数据，不包含可还原账号认证状态的全部材料，也不替代 SQLite 快照或 PostgreSQL 归档。数据库备份恢复使用 [database-operations.md](database-operations.md) 的专用工具。

账号注销、owner 显式共享删除、家庭自动保留和恢复删除重放已由独立接口/命令提供，见 [privacy-lifecycle.md](privacy-lifecycle.md)。本页导出接口不修改或删除用户业务记录。注销后会话立即失效；已经下载的私有文件不会随服务器删除自动收回，须由持有人管理。最新开发和实际验证见 [协作流程](process.md) 与 [acceptance.md](acceptance.md)。
