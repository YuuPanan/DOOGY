# 配置变更历史与家庭联系人后端

本批落实 当前需求文档 §21.5 的配置历史和联系人资料。沿用现有 NestJS、家庭权限、事务和幂等机制，没有新增外部调用、运行依赖或后台服务。接口统一前缀 `/api/v1`，已注册 Swagger，Web 新页面尚未接入。

## 配置变更历史

```text
GET /pets/{id}/configuration-history?from=&to=&kind=&resource_id=&limit=&cursor=
```

当前家庭 owner、caregiver、viewer 均可读；每次翻页重新检查宠物权限。`kind` 为 `geofence` 或 `reporting_policy`，`resource_id` 分别为围栏ID或设备ID。from/to 是UTC时间，含起不含止，最长31天；省略时查询最近31天。默认窗口会写入游标，续页可只传 cursor 和原筛选条件，不会随当前时间漂移。返回 `from/to/items/next_cursor`，按单宠物递增的 `version` 倒序，保证同一毫秒修改的实际顺序。

每条包含 `actor_kind/actor_user_id/action/reason/changed_at`、资源及绑定/命令引用、`before_version/after_version`、配置 `before/after` 和 `changed_fields`。快照只保存配置，不复制设备密钥、位置状态或告警判断状态。接口使用 `Cache-Control: no-store`。

- 围栏创建、实际改名、规则修改和停用均记录。改名不改变 `rule_version`；实际规则修改沿用既有版本递增及状态重置。空修改、相同字段值、重复停用不增加历史。
- 普通上报策略、走失开启、手动关闭后的恢复、自动到期恢复，按实际生成的命令记录期望策略和版本。`policy_requested` 表示已请求，设备是否执行仍以既有命令/策略回执读取；历史不把请求写成已应用。
- 同一幂等键重放不重复生成命令或历史；重新发起的独立策略请求可以产生新命令版本，即使策略字段相同，此时 `changed_fields` 可以为空。
- 自动到期恢复为 `actor_kind=system/actor_user_id=null`；人工请求和解绑记录实际操作者。解绑清策略保存 `cleared`，历史归属原宠物，设备换绑不会让新家庭读到旧宠物的历史。

不回填上线前未记录的修改。`scope=recorded_changes_only` 明示这是开始记录后的变更，不是完整的既往操作史。

## 家庭联系人

```text
GET   /households/{id}/contacts?limit=&cursor=
POST  /households/{id}/contacts
PATCH /contacts/{id}
DELETE /contacts/{id}
```

联系人属于家庭，与登录账号或成员角色分别管理。owner/caregiver 可增改删，viewer 可读取；其他家庭返回404。列表按创建时间及ID倒序，游标绑定当前用户和家庭。读取、修改和幂等重放都复核当前权限，响应不缓存到浏览器。

创建示例：

```json
{
  "name": "家人",
  "role_description": "日常协助照护",
  "purpose": "需要联系时由客户端拨号",
  "phone": "+44 (0) 20-1234",
  "email": null,
  "is_primary": true,
  "consent": { "status": "reported_granted", "note": "家庭成员报告已取得联系同意" }
}
```

name必填，phone/email至少一项。电话保留用户输入文本，仅校验长度和基本字符，不猜测国家区号；邮箱转小写。角色说明和用途默认为空。POST/PATCH支持可选 `Idempotency-Key`，只缓存资源ID，重放读取当前授权记录和当前主联系人，不返回旧联系方式快照。

同意状态为 `unknown/reported_granted/reported_revoked`，默认unknown。返回 `consent.source=household_member_reported` 和 `verified=false`；报告者及时间由服务端填写。它是家庭成员提供的资料，不是联系人本人核验、条款接受或通知发送授权。修改phone/email后自动重置为unknown并清旧报告，除非同次PATCH显式提交新的consent。姓名/说明修改保留原报告。

每个家庭最多一个主联系人，也可以没有；第一条不自动成为主联系人。设置新的主联系人在同一事务中取消旧主联系人，并递增被取消记录的版本。删除或取消主联系人不会自动指定继任者。允许仅有邮箱的主联系人，客户端发起电话前仍需检查phone。

PATCH必须带当前 `expected_version`，例如：

```json
{ "expected_version": 1, "phone": "+44 (0) 20-5678" }
```

DELETE同样要求正文 `{"expected_version":2}`，避免删除其他终端已经修改的记录。旧版本返回409，需要重读。响应中的 `primary_contact_id` 是家庭当前实际值；删除主联系人后可以为null。

## 导出、删除与迁移

`pet_configuration_history` 随宠物按家庭授权导出，`household_contacts` 按家庭授权导出。账号注销会匿名化操作者/联系人报告者和创建修改者，保留家庭共享资料；删除宠物清配置历史，保留家庭联系人；删除家庭清两者。联系人删除清所有用户的相关幂等/审计副本，并写入 `household_contact` 删除日志，旧备份恢复后用同一函数重放，防止联系方式复活。

家庭保留预览通过独立 `retained_related_counts` 返回两表数量；遥测到期不会自动删联系人或配置历史。没有新增联系人自动过期策略。

SQLite `031-configuration-history.sql/032-household-contacts.sql` 与 PostgreSQL `020-configuration-history.sql/021-household-contacts.sql` 增量增加两表，源码目标58张业务表。SQLite源导入继续只读且目标必须为空，备份新增56/57/58阶段兼容，旧归档先按保存版本核验后再升级。

继续使用 `start.bat` 先构建、预检，再启动API和Worker。保留已有环境配置、数据模式和业务库；验证要求见 [协作流程](process.md)。

后续已提供 [联系人通知本地请求、逐人结果与重试](contact-alerts.md)：offline明确模拟、api渠道未配置则失败。接收人本人核验、真实短信/邮件投递、位置链接投递、客户端拨号或Web联系人页面仍未接入。
