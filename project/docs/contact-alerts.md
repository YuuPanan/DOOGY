# 联系人通知：文字请求与逐人结果

本批落实 当前需求文档 §21.5 的显式收件人、请求状态和逐人结果。复用家庭联系人资料，独立于现有家庭成员的安全事件推送队列；联系人不因此成为家庭成员或获得宠物读取权。

当前只处理用户提交的文字，`content_scope=message_only/location_link_included=false`。offline由现有Worker产生明确的模拟结果，api未接渠道时逐人失败，不发送短信、邮件或推送，不自动附加坐标、位置正文或分享链接。真实渠道和分享投递合同留待后续接入。

## 请求与读取

```text
POST /api/v1/pets/{id}/contact-alerts
GET  /api/v1/pets/{id}/contact-alerts
GET  /api/v1/contact-alerts/{id}
POST /api/v1/contact-alerts/{id}/retry
POST /api/v1/contact-alerts/{id}/cancel
```

创建示例：

```json
{
  "message": "请协助查看宠物的情况。",
  "consent": true,
  "expires_in_seconds": 900,
  "recipients": [
    { "contact_id": "联系人UUID", "expected_version": 1, "method": "email" }
  ]
}
```

owner/caregiver可创建、重试和取消，viewer可读；每次操作复核当前宠物家庭权限。message去首尾空白后1–1000字符，1–10位显式收件人，同一联系人不能重复；空选择返回400。期限默认15分钟，允许60–3600秒，按创建时保存的expires_at执行。不得用缺省主联系人代替显式选择。

联系人必须属于同一家庭，expected_version须为当前版本，method为email或phone且该方式确实存在。跨家庭404、旧版本或所选方式不可用409；校验通过后返回202待处理请求。consent=true表示本次操作者确认提交该文字，不代表系统已核验接收人本人同意。

接收同意继续采用联系人资料中的成员报告，`consent_source=household_member_reported/consent_verified=false`。未知或撤回可产生待处理请求，Worker逐人明确失败RECIPIENT_CONSENT_REQUIRED；reported_granted也仅能支撑当前模拟流程，不能据此声称本人已核验或真实发送授权已完成。

请求保存用户原文及created_by/requested_by，收件记录仅保存contact_id、contact_version和method，不自动复制电话、邮箱、联系人姓名或分享秘密。用户自行写入的正文原样保留；删除联系人只清系统关联，不改写用户原文。

详情GET返回当前请求、逐人状态和counts：total/pending/simulated/failed/cancelled，并独立检查期限，将确实到期的pending结束为失败。父status从实际逐人记录推导：有pending为pending，全部模拟为simulated，有模拟及其他终态为partial，无模拟且有失败为failed，全部取消为cancelled。每人记录本次attempt、queued_at/processed_at、error_code与execution_source，不能将simulated显示为真实发送成功。

## 通知历史与 App 入口

`GET /api/v1/pets/{id}/contact-alerts`返回`{pet_id,items,next_cursor}`。查询严格只接受`limit`和`cursor`：limit为1–200的整数，默认50；cursor须使用上一页返回值。空或畸形游标、无效UUID/时间、跨用户或跨宠物游标均返回400，未知查询字段也返回400；当前没有status或日期筛选。游标是严格校验的base64url，不由客户端自行拼装或修改。

列表按`created_at DESC,id DESC`排序，同毫秒以ID稳定分页。重试更新attempt和updated_at，不改变创建排序；新插入的较新请求不会使后续页重复已有记录。每页重新核对当前宠物及其当前家庭成员资格，owner/caregiver/viewer均可读取家庭共享历史，不限请求作者；跨家庭、成员撤权或宠物不可读返回404，旧游标不能绕过。

items是父请求当前字段及状态摘要，包含原文、attempt、作者和时间、status/counts，以及`content_scope=message_only`、`location_link_included=false`、`recipient_consent_verified=false`。列表不返回recipients明细，不动态展开地址或复制令牌、链接；逐人结果继续通过`GET /api/v1/contact-alerts/{id}`读取。列表与详情均返回`Cache-Control: no-store`。

列表在同一事务内批量读取本页收件人状态，只将**本页**已到期限的pending持久化为failed/REQUEST_EXPIRED，并更新确实发生变化的父请求时间；终态不被重写，不对未返回的其他页做全局清理。摘要与详情共用状态/counts口径，因此列表读取后的详情不会重新显示旧pending。Worker原有到期维护继续独立执行。

App联系人页按当前宠物每页读取10条，可加载下一页并点选请求；点选时重新读取最新详情后再展示逐人结果、重试或取消。创建、重试和取消后刷新列表；切换宠物或家庭不沿用旧范围的分页状态。原有“已知请求ID重读”入口保留，可作为直接读取详情的fallback。

## Worker、取消与重试

Worker每批处理小量请求，同一请求在数据库事务内核对本次操作者的当前写权限、模式、期限、联系人版本、联系方式及接收同意，再产生逐人结果。offline为simulated/offline_demo；api为failed/CHANNEL_NOT_CONFIGURED，不因缺配置永久停留pending。到期的pending终止为REQUEST_EXPIRED，已结束记录的历史结果不被定时维护改写。

retry和cancel正文均为 `{"expected_attempt":1}`，支持可选Idempotency-Key；新的操作校验当前attempt，同键重放只读取当前状态，不回退新尝试。重试只重新排队failed收件人，已simulated或cancelled不重复处理；全部失败目标须仍通过当前权限、版本、同意、方式和期限检查。联系人变更/删除等来源失效必须新建请求、重新显式选择；不能把旧请求转投新地址。显式重试记录新的操作者、模式和attempt，不延长原期限。

取消只影响pending，已模拟或失败的记录保留。没有pending且从未取消过时返回冲突，重复取消不重复改写结果。写入幂等只缓存请求ID，重放先检查当前权限并重新读取当前状态；在现有幂等缓存有效期内，旧键不会自动重建已过期请求或延长期限。

## 联系人变更、删除与恢复

联系人版本变更（含主联系人切换）会使旧待处理/失败选择终止为CONTACT_CHANGED，并清相关请求/收件人回执；已经模拟的历史不被改为“从未处理”。删除联系人先将未完成选择标为CONTACT_DELETED，再断开全部该contact引用并清相关回执；过去的模拟结果只保留无地址的处理元数据。

联系人版本修改同事务写入无地址、无正文的household_contact_changed恢复标记。旧快照缺该标记时，重放失效相关旧选择，并将恢复出的联系人同意重置unknown、递增版本，要求重新确认和选择；不能把旧版本和旧同意一并恢复后直接投递。它不能重建快照之后的新地址或名称。已含标记的新快照跳过，重复重放无副作用；物理删除仍复用household_contact删除日志。

账号注销取消该账号作为本次requested_by的pending记录并匿名化两个作者字段，保留共享原文和终态；其他成员已经接手的尝试不受原作者注销影响。其他活跃成员的仅ID创建回执继续读取原请求的取消状态，避免旧创建重试重新排队。删宠/家庭清请求和收件记录及全用户相关回执。导出按当前家庭权限分两表提供，绝不动态展开联系地址。保留预览单独统计两表，遥测期限不套用到它们；请求过期结束队列，不自动删除历史。

## 迁移与运行

SQLite `034-contact-alerts.sql`、PostgreSQL `023-contact-alerts.sql` 同次增加两表，源码从59增至61表；不存在60表阶段。当前历史列表复用这两张表，没有新增表或迁移，仍为61表、SQLite034/PG023。SQLite源导入继续只读且目标须为空，备份保留59表阶段及旧归档核验后升级。

Worker使用既有运行入口处理联系人请求；启动构建与预检、空闲及异常退出语义保持。联调使用独立配置和合成数据，默认offline，不向真实接收人外发。

尚未接入真实投递服务、接收人本人核验、服务商受理/送达回执、自动位置链接及Web选择/结果页面；本地模拟不构成这些能力的验收。
