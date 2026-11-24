# 密码找回：本地投递与一次性重置

本页规定密码找回申请、验证和完成流程。offline 使用受控的本地命令提供验证材料，不发邮件；api 尚无邮件供应商，明确报告not_configured。没有新增外部调用或运行依赖，Web找回页面尚未接入。

## 申请与本地投递

```text
POST /api/v1/auth/password-recovery
{ "email": "owner@example.invalid" }
```

接口公开，返回202及 `accepted/request_id/delivery_status`。同一运行模式下，已注册、未知或已注销邮箱的响应结构一致，不返回用户ID、token或投递目标。offline状态为pending_local_delivery，api为not_configured；受理不表示邮件已经发出，也不改变密码或撤销现有会话。

每个规范化邮箱的SHA-256摘要独立限速：15分钟内最多5次申请，超出返回429；已知/未知邮箱采用同一规则。新申请15分钟有效，不能靠重复投递延长。请使用返回的request_id，在能访问所选数据库的本地终端执行：

```powershell
./start.bat .env recovery-deliver "<request-id>"
```

命令先同步依赖、构建最新源码，再执行投递，不启动额外API或Worker。指定隔离环境或PostgreSQL时，将.env换成对应环境文件。也可使用默认环境：

```powershell
npm.cmd run recovery:deliver -- "<request-id>"
```

本地命令仅在当前模式和申请捕获模式均为offline、申请及账号有效时生成32字节随机token，输出一次JSON。数据库只保存SHA-256，不保存原始token；审计、HTTP响应、通用幂等缓存和个人导出都不返回它。再次投递没有token，未知/已注销账号为skipped，api不投递。token仅应从本次本地输出取用，不能从数据库或重复调用中取回。

这是开发环境的受控本地投递入口，需要已有数据库访问权；不是面向匿名浏览器的验证码读取接口，也不等于已验证邮箱归属或邮件送达。

## 验证并完成重置

```text
POST /api/v1/auth/password-reset
{
  "request_id": "申请UUID",
  "token": "本地投递的一次性材料",
  "new_password": "符合现有8至128字符规则的新密码"
}
```

验证与完成在同一事务中进行，分别保存verified_at和consumed_at，不另发临时登录会话。到期等号、已消费、已失效、模式变化、账号关闭或错误token均拒绝；同一申请最多5次错误验证，失败次数会提交，不因错误响应回滚。无效申请不锁住用户的正常登录，也不撤销会话。

成功后更换密码散列、清验证材料、消费本次申请、使其他未完成申请失效，并撤销该用户全部访问/刷新会话；清原登录错误计数，保留找回申请的限速额度。响应不自动登录，需用新密码正常登录。并发提交同一token只能成功一次。

现有登录在签发会话的事务内复查已验证的密码散列；若等待期间密码被重置，旧密码预检结果不能签发新会话。失败回执、token及新密码不进入通用幂等缓存。

## 导出、注销与备份恢复

`password_recovery_requests` 导出仅限本人元数据，不含email_hash、token_hash或原始材料。注销删除本人申请并清相关找回节流键；Worker每分钟清过期验证散列及过时的本用途限速计数，各接口也独立检查到期，不依赖Worker及时运行。

成功重置写入无秘密payload的password_reset恢复日志。恢复旧备份并重放该日志时，如果备份尚未包含这次重置，会撤销旧会话和旧申请，并将恢复出的旧密码替为不可知的随机散列；用户需要重新申请找回。日志不携带真实新密码或新密码散列，不能用它把新密码写回旧备份。备份已含该日志则跳过，不破坏已保存的新密码；重复重放无副作用。恢复流程仍须在重新开放服务前应用最新恢复日志。

SQLite `033-password-recovery.sql`、PostgreSQL `022-password-recovery.sql` 增加一张业务表，该批目标59表；后续增量以 [最新数据库结构](database-dataflow.md) 为准。只读源导入和原生备份清单保留旧58表阶段，旧归档按保存版本核验后再升级。没有修改用户.env、密码或业务数据库；测试仅使用自建的隔离库和合成账号。

本批实际构建、默认回归、实库尝试和BAT记录见 [协作流程](process.md)。真实邮件供应商、地址核验、Web页面及生产运行仍未验收。

安全约束参考 [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)：公开申请采用一致消息，验证材料通过另一路径提供，随机、到期且一次使用，完成后重新登录。
