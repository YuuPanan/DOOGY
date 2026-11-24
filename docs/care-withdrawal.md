# 照护记录编辑、撤回与当前状态

照护记录支持带原因的软撤回。撤回后记录不再出现在默认列表和看板中，体重按仍有效的体重记录回算；原记录、修改快照和撤回信息保留在历史与授权导出中。SQLite/PostgreSQL、offline/API 使用相同业务合同，无新增外部服务或环境变量。

## 接口与权限

下列路径统一前缀 `/api/v1`，使用当前用户的 Bearer 登录令牌：

| 方法与路径 | 用途与权限 |
| --- | --- |
| `GET /pets/{id}/care-records?status=active` | 当前家庭成员读取照护列表；`status` 可选 `active`、`withdrawn`、`all`，默认 `active` |
| `GET /care-records/{id}` | 当前家庭成员读取单条记录的最新状态，包括撤回标记 |
| `POST /care-records` | owner/caregiver 创建记录，可选 `Idempotency-Key` |
| `PATCH /care-records/{id}` | owner/caregiver 修改有效记录，可选 `Idempotency-Key`；保存修改前快照 |
| `POST /care-records/{id}/withdraw` | 当前有写权限的原作者或家庭 owner 撤回记录，原因必填，可选 `Idempotency-Key` |
| `GET /care-records/{id}/history` | 当前家庭成员读取当前记录和按顺序保存的历史快照 |
| `POST /care-records/{id}/attachments` | owner/caregiver 给有效记录上传附件，可选 `Idempotency-Key` |
| `GET /care-records/{id}/attachments` | 当前家庭成员读取附件元数据列表，撤回记录仍可读 |
| `GET /care-attachments/{attachment_id}/content` | 当前家庭成员下载附件原始字节，撤回记录仍可读 |

普通 caregiver 可以继续编辑其他成员的有效记录，但撤回其他成员记录时返回 `403 CARE_AUTHOR_OR_OWNER_REQUIRED`；owner 可以撤回本家庭成员创建的记录。viewer、已退出或被撤权的成员无法写入；曾经创建记录或持有成功请求的键也不能恢复已经失去的家庭权限。读权限随当前家庭关系判断。撤回原因 `reason` 先去掉两端空白，规范化后为 1–500 个字符。

撤回请求示例：

```http
POST /api/v1/care-records/{record_id}/withdraw
Authorization: Bearer {access_token}
Idempotency-Key: {本次撤回意图的唯一键}
Content-Type: application/json

{"reason":"重复录入，保留另一条记录"}
```

记录响应包含 `withdrawn_at`、`withdrawn_by` 和 `withdrawal_reason`。有效记录的三个字段为 `null`；撤回记录保存撤回时间、操作者 UUID 和原因。`history.current` 返回当前记录，`revisions` 保留修改或首次撤回前的快照、修改人和时间。看板 `/pets/{id}/overview` 的 `care_records` 只返回有效记录，列表的时间和类型筛选继续适用。

如厕 `toileting` 与自定义 `custom` 沿用同一编辑、撤回和历史流程。自定义名称 `custom_type` 属于单条记录，编辑名称前的快照和撤回前快照保留原名称；不批量改变其他记录。PATCH 提供的 `value` 完整替换原对象，如厕仍需合法的 `kind`；记录 `type` 保持不变。列表可叠加 `type`、精确 `custom_type`、状态和时间筛选，完整示例见 [如厕与自定义照护](care-types.md)。

当前照护响应的 `attachments` 为附件元数据数组。上传也属于一次可追溯修改：同一事务保存上传前的父记录快照、新附件、父记录 `updated_at` 和上传审计；后续编辑、撤回快照继续保留当时的附件元数据。撤回不删除文件，当前有读权限的家庭成员仍能从历史和附件接口查看、下载；撤回后不能再上传，曾成功上传的旧键也不能绕过。接口、容量及文件示例见 [照护记录附件](care-attachments.md)。

## 重试与冲突

编辑和撤回的可选键沿用默认 24 小时的数据库幂等缓存；同一用户、接口、键和规范化内容在有效窗口内返回首次成功回执，不重复新增修订或审计。同键异内容返回 `409 IDEMPOTENCY_CONFLICT`。当前权限在读取缓存前检查，具体期限、清理与例外见 [command-idempotency.md](command-idempotency.md)。

首次撤回在同一事务内保存旧快照、撤回标记、审计和恢复日志。已经撤回后，用同一规范化原因再请求不会重复产生这些记录；使用同一未过期键但换用另一原因，先返回 `409 IDEMPOTENCY_CONFLICT`；不带键或换用新键但原因不同，则返回 `409 CARE_RECORD_ALREADY_WITHDRAWN`。撤回记录不再接受 PATCH，即使提供的是曾成功编辑过该记录的旧键，也返回 `409 CARE_RECORD_WITHDRAWN`。

缓存保存首次回执，不是实时状态。创建照护记录的旧键在缓存有效期内仍可返回创建当时的响应，但不会重建或重新启用后来撤回的记录；需要确认当前事实时读取 `GET /care-records/{id}`。缓存过期、隐私删除或保留清理后不再保证返回原回执，客户端应为新的意图生成新键。

## 体重与数据含义

创建、编辑或撤回体重记录后，系统从同一宠物仍有效的体重记录中，按 `recorded_at DESC, created_at DESC, id DESC` 选择最新值更新 `pets.weight_kg`。撤回旧体重不覆盖仍有效的新记录；没有有效体重记录时设为 `null`，表示未知。撤回其他类型的照护记录不改体重。

宠物档案曾经手填且后来被照护记录覆盖的体重没有独立历史基线，不能在撤回后自动还原；程序不会猜测旧值。`source=owner|vet` 是录入者声明的来源，系统没有核验兽医资质；这些记录和撤回状态不构成诊断或治疗建议，缺失数据也不表示健康正常。

## 导出、共享删除与恢复

授权导出的 `care_records` 分区包含有效及撤回记录，并带上述三个字段和 `custom_type`；非自定义类型的名称为 `null`，修订继续由 `care_record_revisions` 导出。升级前的旧快照可能没有 `custom_type` 或 `attachments`，不补造历史内容。新增 `care_attachments` 分区导出文件元数据和 base64 正文，撤回后的文件继续保留；分区以当前导出清单为准，附件页最多 1 条，权限和分页合同见 [account-export.md](account-export.md)。软撤回保留原文和历史，需要清除整只宠物或家庭的共享资料时使用 owner 的显式共享删除，关联附件一并清理，见 [privacy-lifecycle.md](privacy-lifecycle.md)。已下载的导出文件不自动收回。

SQLite `019-care-withdrawal.sql` / PostgreSQL `008-care-withdrawal.sql` 只给 `care_records` 增加三个可空字段。旧 SQLite 源只读导入时缺少的字段采用 `NULL`；旧归档按保存的迁移版本核验后，正常打开时升级，不假设旧库已经存在撤回信息。

后续 SQLite `020-care-types.sql` / PostgreSQL `009-care-types.sql` 扩展类型并增加可空 `custom_type`；SQLite 表重建保留原撤回字段、记录标识及修订关联。照护新类型不会改变上述撤回权限、恢复日志内容或体重回算规则。

附件迁移 SQLite `021-care-attachments.sql` / PostgreSQL `010-care-attachments.sql` 新增 `care_attachments`；元数据与 base64 文件正文保存在同一个数据库，原生备份和只读导入一起携带文件。旧源没有附件表时新增表为空，不会从旧修订或备注推造文件。恢复旧快照后重放撤回日志只补父记录状态；快照本身没有保存的后来附件无法通过日志恢复。

`start.bat` 仍是 API/Worker 一键入口，正常启动先编译最新源码并应用所选数据库的增量迁移。本功能没有额外 CLI、常驻进程或演示库要求；联调通过上述 HTTP 接口完成，原环境文件和数据模式保持。

撤回写入 `privacy_deletions` 的 `care_withdrawal` 日志，只记录资源 ID 和顺序时间，不保存自由文本原因或操作者。当恢复的是撤回之前的旧快照时，应在停止 API/Worker、设置 offline 的恢复副本上重放源库最新日志。重放将存在的有效记录标为撤回，`withdrawn_by=null`，固定 `withdrawal_reason="恢复撤回记录"`，时间取原日志；已经撤回或已不存在的记录不重复处理。由于日志无法还原原操作者及原因，重放不伪造这些身份或撤回前修订，只保留旧历史并补充状态和系统审计。操作步骤见 [数据库恢复重放](database-operations.md#恢复后的删除重放)。

新原生快照保存当时真实的撤回字段、原有修订和操作者；它与恢复旧快照后补状态的证据范围不同。旧归档不会自动改写，源库和最新日志均丢失时，程序无法知道备份之后发生的撤回。
