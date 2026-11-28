# 账号注销、共享数据删除与自动保留

本功能对应 [Doggy_final.md](../Doggy_final.md) §16。SQLite/PostgreSQL 与 offline/API 使用同一业务合同，不依赖云端供应商。现有 `.env` 保留；生命周期阶段 SQLite `016-data-lifecycle.sql` / PostgreSQL `005-data-lifecycle.sql` 增加账号注销时间、家庭保留策略和删除重放记录。后续库存增量为 SQLite 017/PostgreSQL 006，见 [无家庭归属遥测保留](inventory-retention.md)；当前完整结构见 [数据库说明](database-dataflow.md)。

## 账号注销与共享数据归属

账号注销清除登录会话、密码、原邮箱、推送凭据、本人通知、偏好、幂等缓存、反馈、本人提交的客服工单与诊断、分享及个人审计内容，退出仍存在的共享家庭。原访问/刷新令牌不能继续使用；原邮箱可用于注册新账号，新账号不会继承旧 UUID、家庭权限或共享作者身份。

其他成员仍在使用的照护事实和修订记录不会因为作者注销而全部删除。`users` 保留原 UUID、创建时间及 `closed_at`，邮箱替换为不可登录的关闭标识，密码清空；共享作者引用仍指向该关闭身份。共享照护备注、值和修订原文仍可见，若其中含姓名等自由文本，不保证完成匿名化；需要删除共享资料时，由家庭 owner 显式删除对应宠物或家庭。

单条照护记录可由仍有家庭写权限的原作者或家庭 owner 带原因软撤回；撤回隐藏默认列表和看板，保留原文、修订、操作者与原因供历史/授权导出读取，不作为共享资料删除或匿名化。其他 caregiver 可以编辑有效记录，但不能撤回他人记录。撤回及体重回算合同见 [care-withdrawal.md](care-withdrawal.md)。

注销预览列出阻断项及范围：

- 本人为多成员家庭的 owner：先将所有权转移给现有、未注销的家庭成员。
- 本人拥有的设备仍绑定在继续保留的共享家庭：先解绑并释放设备，或在转移家庭所有权时一并交接适用设备。
- 仅本人一名成员且本人为 owner 的家庭：注销时删除整户业务资料。
- 其他共享家庭：只退出家庭，不删除其他成员仍在使用的宠物和照护资料。

注销会释放其余自有设备、清除绑定码与缓存、吊销并替换设备秘密。硬件库存记录保留；重新使用需要设备管理员重新签发凭证与绑定码。

## HTTP 接口

以下路径统一前缀 `/api/v1`，全部要求 Bearer 用户登录。注销和删除/转移在数据库事务内再次验证当前密码与权限。预览为读取操作，不代表已删除。

| 方法与路径 | 权限与请求 |
| --- | --- |
| `GET /auth/account-deletion` | 本人读取 `can_close`、`blockers`、待删除家庭、待退出家庭和设备范围 |
| `DELETE /auth/account` | 本人；`{"password":"当前密码","confirmation":"DELETE"}` |
| `GET /pets/{id}/deletion-preview` | 家庭 owner；读取共享成员数和关联业务行数 |
| `DELETE /pets/{id}` | 家庭 owner；`{"password":"当前密码","confirmation":"该宠物UUID"}` |
| `GET /households/{id}/deletion-preview` | 家庭 owner；读取成员数、宠物 ID 和影响范围 |
| `DELETE /households/{id}` | 家庭 owner；`{"password":"当前密码","confirmation":"该家庭UUID"}` |
| `POST /households/{id}/owner` | 当前 owner；`{"password":"当前密码","new_owner_user_id":"现有家庭成员UUID"}` |

账号或预览响应中的 `OWNER_TRANSFER_REQUIRED`、`DEVICE_RELEASE_REQUIRED` 需要先处理，不能靠重复提交注销绕过。caregiver/viewer 不能删除家庭共享资料。错误确认值不执行删除。

所有权转移同时更新家庭 owner 字段与角色：原 owner 变为 caregiver，目标变为 owner。该家庭当前绑定、且由原 owner 拥有的设备一并转给新 owner；库存或其他家庭的设备不会随之转移。接口返回 `transferred_devices`，调用方应明确展示交接范围。

## 共享资料删除的实际范围

删除宠物清除其档案、绑定关系、位置与活动样本、围栏和判断、风险事件及通知/确认、照护与修订、反馈、工单及回复/诊断、分享、策略/命令/走失、已保存日摘要和观察，以及关联幂等缓存与审计副本。当前绑定被解除，相应设备缓存清空；硬件库存与拥有者身份保留，后续凭证/绑定码维护沿用 [device-credentials.md](device-credentials.md)。

原始 `device_events` 不直接移除全部去重身份：清空 payload/envelope，移除宠物/绑定关联并标记 `DATA_DELETED`，保留事件 ID、设备启动序列及处理元数据，避免旧消息重试重新建立已删除业务数据。这些最小元数据仍不是物理全删或不可关联匿名数据。

删除家庭对其全部宠物执行相同清理，再删除邀请、成员关系、设置、保留策略及家庭本身。其他成员的账号和其他家庭继续存在。已经转移并在其他家庭重新绑定的硬件，其当前业务状态不会随旧宠物删除而清空。

## 家庭自动保留策略

策略按家庭保存，默认 `enabled=false`；不会仅因升级程序就开始删除历史位置。拟议默认窗口为遥测 90 天、结构化活动 365 天、安全事件与通知 365 天；这些是可调整的产品参数，不是所有市场通用的法定保留要求。天数必须为 1–3650 的整数。

| 方法与路径，前缀 `/api/v1` | 用途 |
| --- | --- |
| `GET /households/{id}/retention` | 当前家庭成员读取策略；未配置时返回关闭状态和默认窗口 |
| `PATCH /households/{id}/retention` | owner 提交当前密码、enabled 和三个窗口，保存完整策略 |
| `POST /households/{id}/retention/preview` | owner 读取已保存策略预计匹配的清理/去标识类别及时间上界，已关闭策略也可预览，不执行清理 |
| `POST /households/{id}/retention/run` | owner 提交 `{"password":"当前密码"}`，立即执行已启用策略 |

设置示例：

```json
{
  "password": "当前密码",
  "enabled": true,
  "telemetry_days": 90,
  "activity_days": 365,
  "safety_days": 365
}
```

建议先以 `enabled=false` 保存窗口，再调用 preview 评估范围，最后以当前密码和 `enabled=true` 启用。已保存的关闭策略允许零写预览；未配置家庭的预览返回 disabled 和空 counts，真实执行及 Worker 始终跳过关闭策略。PATCH 省略天数字段时使用默认值，不是保留该字段先前值；启用时应再次提交核对后的三个窗口。保存 `enabled=true` 后 Worker 即可在下一轮检查执行。关闭策略可提交 `enabled=false`，已经清理的资料不会因此恢复。

Worker 每分钟检查一次已启用家庭，每个家庭自动执行后至少冷却一小时；策略更新会清空冷却时间。API 手动执行及运维命令可跳过冷却，但仍只处理已启用家庭。每个家庭的清理使用独立事务，多个 Worker 通过现有事务机制协调，不新增后台服务。

| 类别 | 清理口径 |
| --- | --- |
| 精确位置与围栏判断 | 按位置 `device_ts` 清除窗口外记录，清理指针、相关围栏状态及安全详情中的位置副本 |
| 原始遥测 | 按消息 `received_at` 清空到期 payload/envelope，保留最小去重元数据；到期 pending/retry 变为 dead/`RETENTION_EXPIRED`，不再投影已清内容；同一事件重接收或人工重试返回 `409 EVENT_DATA_EXPIRED` |
| 设备 signal 与活动原始 metrics | 清除到期原始字段，不把结构化活动的较长窗口等同原始遥测长期保存 |
| 结构化活动 | 按 `end_at` 清除；同步清除受影响宠物的已存摘要、观察和反馈证据，使后续读取依据剩余数据回算 |
| 风险事件、通知与确认 | 按 `occurred_at` 及通知创建时间清除到期记录，包含仍为 open 的旧事件；相关围栏状态重置 |
| 分享与诊断 | 清除已到期/撤销的分享记录和诊断快照；原诊断到期维护仍有效 |
| 缓存与审计副本 | 按 JSON 中的当前家庭、宠物及到期资源 ID 清除相关幂等缓存，清空关联审计 metadata；不会仅因同一用户也属于该家庭而清除其其他家庭缓存 |

返回的 `counts` 包含删除、字段清空和状态重置的匹配行数，同一业务对象可能涉及多个类别，不能相加当作独立删除记录总数。日摘要和照护没有独立的永久保留承诺：照护当前随账号/家庭归属规则与显式共享删除处理，摘要随活动清理及共享删除处理。

家庭保留仅处理明确关联该家庭宠物的数据。没有 `pet_id` 的库存或未绑定设备遥测使用独立、默认关闭的 [库存策略](inventory-retention.md)，由设备管理员管理，不由任意家庭 owner 决定。设备后来被认领不会使先前无归属消息转入该家庭；原文仍按库存窗口清理，当前家庭状态保持隔离。

## 本地维护与恢复删除重放

`start.bat` 先同步依赖和构建，再运行维护并退出，不启动 API/Worker。运维命令直接读取所选数据库，权限来自本地数据库访问，不使用用户 Bearer；API 则始终按家庭角色和密码控制。

```powershell
# 默认 SQLite；PostgreSQL 将 .env 换为 .env.postgres。
./start.bat .env privacy retention-preview
./start.bat .env privacy retention-run
./start.bat .env privacy export-log ./data/backups/privacy-log-20261117.json

# 只指向隔离的恢复副本，配置 DATA_MODE=offline。
./start.bat .env.recovery privacy replay-log ./data/backups/privacy-log-20261117.json
```

不带子动作时默认 `retention-preview`。CLI 预览遍历全部已保存家庭策略，包括关闭策略；不删除业务数据，但工具正常打开数据库会应用待执行迁移。`retention-run` 只对启用家庭执行清理，不能向生产库误用测试配置。

删除/注销/所有权转移和照护撤回写入 `privacy_deletions`。日志导出采用不存在的新文件，不覆盖旧文件，格式 `doogy-privacy-log-v1`，含生成时间、receipts 和覆盖序列化 receipts 的 SHA-256。记录只有动作、资源/账号/设备 UUID、顺序时间及转移目标，不含坐标、备注、密码和令牌；`care_withdrawal` 也不保存原操作者或自由文本原因。UUID 日志仍需受控保管。摘要发现内容损坏，不能证明来源或替代签名。

密码找回增量另写无payload的 `password_reset` 日志。旧备份尚无该日志时，重放撤销目标用户会话、旧找回申请及关联审计/回执，并将恢复出的旧密码替为不可知的随机散列，用户需重新申请恢复；日志不包含真实新密码或散列。备份已含该receipt则跳过，不破坏已保存的新密码。注销会删除本人找回申请、专用节流计数和匿名投递审计，授权导出只含本人非秘密元数据。合同及真实恢复验证见 [密码找回](password-recovery.md)。

联系人通知增量记录无payload的 `household_contact_changed`：旧快照缺少该变更时，重放失效旧收件选择并重置恢复出的联系人同意为unknown、递增版本，须重新确认；它不重建修改后的地址。已模拟历史保留原结果，联系人删除只断系统引用；正文由用户填写并作为家庭共享原文保留。详情见 [联系人通知与恢复边界](contact-alerts.md)。

恢复旧快照前，从源库导出**最新**删除日志；停止恢复副本的 API/Worker，保持 loopback/offline，在重新开放访问前重放。工具校验格式和摘要，在事务中按时间顺序执行，已存在 receipt ID 不重复应用；仅 `DATA_MODE=offline` 允许执行重放。所有权转移按日志顺序先于后续注销执行，以免旧 owner 关系阻断注销；目标成员缺失或注销仍有阻断项时会失败，不随机重选 owner。家庭 owner 已不再是日志中的原 owner 时，不强行覆盖现有所有权，仍需人工核对恢复结果。

恢复、日志重放和正式切换是分开的运维步骤。旧归档不会自动改写或清除，缺失源库最新日志时不能声称删除已经完整重放；仍须核对恢复库中的保留策略、设备轮换/吊销与待处理任务。此前已下载的导出文件也不会因服务器删除自动消失。原生备份恢复步骤见 [database-operations.md](database-operations.md)。

照护撤回重放只补上旧快照缺失的状态：按原日志时间标为撤回，`withdrawn_by=NULL`、原因固定为“恢复撤回记录”，保留旧修订并写系统审计，不伪造原操作者、原原因或撤回前新修订。已经撤回或已不存在的记录不重复处理，体重按剩余有效记录回算。撤回后的新快照则保存当时真实字段与完整历史；恢复旧快照加最新日志不能获得同样的原始上下文。

## 适用边界

本地删除、日志重放和保留策略不召回已下载文件、外部副本或历史备份，不等同物理介质擦除；真实供应商删除与法规流程需按部署环境另外核对。
