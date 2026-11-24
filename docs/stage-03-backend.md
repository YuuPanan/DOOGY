# 第三批后端：媒体读取、行为任务与本人问答

当前推进 当前需求文档 §21.6–21.8 的本地后端：媒体授权读取/播放/删除、人工行为记录、异步解释状态、本人问答及上下文引用。模型供应商未确定，当前没有真实音视频识别或LLM回答；offline固定演示与api未配置失败分别记录。

本页规定媒体授权读取、行为解释、本人会话和反馈合同。`POST /pets/{id}/media` 和 `GET /pets/{id}/media/capabilities` 的真实上传及能力门控详见媒体上传合同。媒体支持60秒/20MiB、常见M4A/MP3/WAV/MP4并保留至主动删除或删宠；App前台录音或系统导入、服务端真实容器/编码/时长解码校验见 [媒体上传](media-upload.md)。合成种子素材不替代真实上传验收，真实模型仍需接入。

## 1. 已有媒体的授权读取与删除

| 方法与路径（省略/api/v1） | 行为 |
| --- | --- |
| `GET /pets/{id}/media?limit=&cursor=` | 按当前家庭权限读取媒体元数据，游标绑定本人和宠物 |
| `GET /media/{id}` | 归属、采集开始时间、时长、来源、类型、大小、摘要及验证元数据 |
| `GET /media/{id}/content` | Bearer授权原字节，支持HEAD及单段Range |
| `DELETE /media/{id}` | owner/caregiver删除媒体及派生引用，viewer不能删除 |

普通读取200；`Range: bytes=0-99`、`bytes=100-`、`bytes=-100`返回206及准确的 `Content-Range/Content-Length`。范围错误、多段或不可满足返回416及 `bytes */总大小`。响应使用 `Accept-Ranges: bytes`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。每次读取检查当前家庭权限，不提供永久公开播放链接。

媒体ID不可变，正文只存一份。删除后旧ID读取404；手工行为标签和问题原文保留，相关媒体引用断开，解释/问答的派生上下文、证据和结果清除，标记 `MEDIA_SOURCE_DELETED`。清除所有用户的关联幂等/审计副本，并保存 `pet_media` 删除日志，恢复旧备份后复用同一删除流程。

## 2. 人工行为记录与解释任务

```text
POST /pets/{id}/behavior-records
GET  /pets/{id}/behavior-records?from=&to=&label=&media_id=&limit=&cursor=
GET  /behavior-records/{id}
POST /pets/{id}/interpretations
GET  /interpretations/{id}
POST /interpretations/{id}/retry
POST /interpretations/{id}/cancel
```

行为记录示例：

```json
{
  "labels": ["主人记录的吠叫"],
  "start_at": "2026-11-24T03:00:00Z", "end_at": "2026-11-24T03:01:00Z",
  "notes": "原始观察说明", "media_id": null
}
```

标签为有长度限制的主人原文，每条最多10项，每项最多100字符；不冻结完整行为分类。`source`由服务端固定为 `owner_annotation`，不能冒充项圈算法或模型。起止时间使用UTC、含起不含止，最多31天且不得晚于服务端现在。媒体可不关联；若引用，必须属于同一宠物。列表按时间窗、精确标签/媒体筛选，返回稳定游标及原始来源。owner/caregiver写，viewer读。

解释请求必须有有效媒体，可选相同宠物的行为记录和背景：

```json
{
  "media_id": "已存在且授权的媒体UUID",
  "behavior_record_id": null,
  "from": "2026-11-24T03:00:00Z", "to": "2026-11-24T03:01:00Z",
  "background": ["routine_changed"], "notes": "主人的补充"
}
```

from/to同时提供；省略时使用媒体采集开始和所存时长。background支持 `routine_changed/not_sure_yet`。返回202并持久化pending任务，由现有Worker处理。状态为pending/processing/succeeded/failed/cancelled，保存尝试编号、模式、处理时间及实际执行来源；本地事务中完成状态转换，崩溃回滚后保留待处理状态。

- offline：固定演示 `offline_demo`，`model_version:null`、`claims:[]`，明确没有识别媒体、健康或情绪。活动和媒体引用是已准备上下文，标为 `evidence_usage:prepared_not_model_analyzed/used_by_model:false`。
- api：一次结束为 `failed/MODEL_NOT_CONFIGURED`，没有外部调用，也不自动循环重试。
- 创建和执行模式不同：原尝试失败 `DATA_MODE_CHANGED`，不把旧离线任务自动当成API结果。

重试正文为 `{"expected_attempt":1}`，复用任务ID并增加attempt。显式重试按本次请求者和模式处理，审计保留原请求者/尝试信息；旧尝试不能重置新尝试。取消仅对待处理任务有效，已结束任务返回冲突。创建、取消、重试支持可选 `Idempotency-Key`，重放前复核权限及来源。媒体已删除后不能重试复活旧任务。解释反馈及任务历史见第6节，真实模型适配尚未接入。

## 3. 本人会话与上下文问答

```text
POST /pets/{id}/assistant-conversations
GET  /pets/{id}/assistant-conversations?limit=&cursor=
POST /assistant-conversations/{id}/messages
GET  /assistant-conversations/{id}/messages?limit=&cursor=
GET  /assistant-messages/{id}
POST /assistant-messages/{id}/retry
POST /assistant-messages/{id}/cancel
```

创建会话 `{"title":"本人的问题"}`；会话固定宠物和本人。即使同一家庭，其他用户也不能读取；viewer有权读取宠物时可以保存本人的问答，这不授予其修改共享行为的权限。

问题示例：

```json
{
  "question": "今天有什么活动记录？",
  "context": { "kind": "activity", "date": "2026-11-24", "timezone": "Asia/Shanghai", "background": [], "notes": "" }
}
```

按显式context选择资料，不调用模型猜测问题意图：

| kind | 准备的依据 |
| --- | --- |
| `activity` | 所选自然日实际活动汇总、覆盖率、来源修订及样本ID；无数据保留未知 |
| `body_check_in` | 当前保存的当地日期/时区身体观察版本，原文与可选照护引用 |
| `nutrition` | 当日已知/未知摄入、原始餐食ID及目标ID/版本/生效日期，不推测缺失能量 |
| `lesson` | 必须提供lesson_id/lesson_version，只引用已发布且未撤回课程的版本/来源元数据 |
| `behavior` | 必须且仅提供behavior_record_id或interpretation_id之一，且属于本宠物；未关联媒体、也没有媒体删除标记的人工记录可按原文引用；关联媒体的记录要求媒体仍有效，解释还须成功并绑定原attempt |

问题最多4000字符。date/timezone对自然日资料生效；body输入不足、活动缺失和未知餐食能量各自给出缺项，不补零。每条消息保存问题、请求背景、准备时间、实际数据窗口、版本和引用；不将媒体正文复制进任务。

无媒体人工观察可显式作为原始文字上下文：

```json
{
  "question": "请结合我记录的原文回答，哪些背景还需要补充？",
  "context": { "kind": "behavior", "behavior_record_id": "本宠物的人工行为记录UUID" }
}
```

仅当该记录的 `media_id` 和 `media_deleted_at` 都为null时走此路径。服务端保存 `reference.kind:owner_annotation`、记录ID、原始标签、起止时间和notes，`media:null`，缺项标为 `media_not_provided/no_model_inference`；仍使用 `used_by_model:false/evidence_usage:prepared_not_model_analyzed`，不宣称识别或分析了媒体，也不将人工观察当成模型结论。真正的媒体解释任务仍必须提供有效media_id。若记录因媒体删除而留下 `media_deleted_at`，不能将其改走“无媒体原文”路径绕过来源失效；已有消息读取及执行时也复核行为来源和媒体关联。

POST消息返回202，Worker读取pending。offline只返回固定且明确标记 `simulated:true` 的演示，没有实际模型分析；api为 `MODEL_NOT_CONFIGURED`。记录的是“已准备上下文”，不会将其伪装为模型已使用的证据。问题与答复状态作为同一消息资源读取，列表保存历史消息及各自上下文。

取消、重试与解释相同，重试要求expected_attempt。本人权限和当前宠物访问权在读取、排队处理及重放时复核。创建幂等只缓存消息ID，之后重新读取当前状态，不缓存完整问答快照。切换宠物不会改变既有会话归属。失效的原始上下文不通过retry恢复，需要引用有效数据重新提问。

## 4. 来源更正、删除与恢复

- 媒体删除：清直接及通过行为/解释间接引用的派生结果、上下文和回执，保留主人原文。
- 活动保留清理：仅使依赖活动及关联解释的任务失效，不清无关课程、体况问答。
- 照护内容或时间更正/撤回：仅影响实际引用该记录的营养或身体观察问答；包含体况关联的如厕记录。不影响另一餐食或没有该引用的体况记录。
- 课程撤回或转草稿：即刻清引用该课程的问答派生快照及回执，直接导出也不能拿到旧标题/来源副本。
- 本人注销：删除个人会话/消息；家庭共享媒体和行为匿名化作者，取消其未完成共享解释请求。
- 删除宠物/家庭：清该宠物的媒体、行为、解释，以及所有人的该宠物私人会话。问答导出同时要求本人身份和当前家庭权限。

来源失效在事务中清理，恢复重放使用相同业务函数；不是仅删媒体表而留下旧备份中的解释。任务当前只执行本地固定演示/明确失败，结果写入与来源检查使用同一事务；真实外部模型接入时仍需另行实现领取租约、实际调用与完成回执。

## 5. 迁移和运行

SQLite `028/029/030`、PostgreSQL `017/018/019` 增加五表：`pet_media/behavior_records/interpretations/assistant_conversations/assistant_messages`，源码目标56表。增量导入仍只读SQLite源并要求空PostgreSQL目标，备份识别51/52/54/56表阶段；媒体正文按单条分页和核对。媒体自动保留期限仍待确认，当前未将遥测期限套用到媒体。

没有新增运行依赖、环境变量或独立服务。现有Worker先处理遥测/安全维护与通知，再处理小批解释和问答，保留原空闲等待及异常退出语义。`start.bat` 继续先构建/预检，已使用随机SQLite/offline环境验证真实Worker完成问答并正常退出。

真实上传、解码和App采集入口见 [媒体上传合同](media-upload.md)。Web录音、真实模型和生产/硬件集成按各自接入条件验收。

## 6. 解释任务历史与反馈

```text
GET  /pets/{id}/interpretations?from=&to=&status=&media_id=&limit=&cursor=
POST /interpretations/{id}/feedback
GET  /interpretations/{id}/feedback?expected_attempt=&limit=&cursor=
```

历史按任务创建时间筛选，UTC含起不含止，默认最近31天且单次最多31天。status支持pending/processing/succeeded/failed/cancelled，media_id限定本宠物媒体引用；每页重新检查当前家庭权限，viewer可读。排序为created_at、id倒序，游标固定本人、宠物、首次时间窗及筛选条件，默认查询续页不随时钟改变。列表提供任务摘要、attempt、处理状态、时间及实际执行来源，不携带完整result/evidence，详情继续用 `GET /interpretations/{id}`。列表展示当前尝试，不保留已被同ID重试覆盖的旧结果正文。

反馈示例：

```json
{ "expected_attempt": 1, "assessment": "incorrect", "comment": "这次演示说明未回答我的问题" }
```

assessment支持helpful/incorrect/other，说明去首尾空白后1–4000字符。沿用既有反馈写权限，owner/caregiver可提交；viewer不能提交，只能按下述GET合同重读本人的已有反馈。任务必须成功、媒体仍有效且expected_attempt为当前尝试；待处理、失败、取消、源失效或旧attempt均拒绝。接口不接受自填evidence、feature_date或模型来源，旧通用反馈入口也不能伪造 `source=interpretation`。

服务端从成功任务生成最小引用，保存interpretation_id、attempt、实际evidence_id、media_id、execution_source、model_version及完成时间；确实存在时附processing_version/is_demo。feature_date取实际输入窗口及时区。复用behavior_feedback，不复制任务正文、活动原始数据或媒体字节。offline演示反馈继续标明演示，不能当成真实识别准确率或训练标签。

可选Idempotency-Key只缓存反馈ID，重放前再次检查当前权限、任务状态、attempt及媒体来源，同键重试不重复记录，变更正文返回冲突。历史反馈保留原attempt引用，不自动挂到后来的尝试。

GET反馈仅返回当前登录者为该解释当前尝试提交的记录，不是家庭共享评论列表。查询必填正整数 `expected_attempt`；`limit`为1–200，默认50；可选cursor，其他查询字段拒绝。每页都重新检查当前宠物的读取权限，以及任务成功、结果存在、当前attempt匹配、媒体和证据引用仍有效；证据ID须对应实际任务ID与attempt，媒体ID及SHA256须匹配。成员降为viewer后，只要仍有当前宠物读取权且来源有效，可以重读自己此前保存的反馈；撤权后返回404，不能凭旧游标继续读取。任务尝试改变或成功来源失效时拒绝读取，不能用该端点查看已被覆盖的旧尝试。

响应为 `{interpretation_id,attempt,items,next_cursor}`，items含本人的assessment、comment、保存时间及服务端生成的最小evidence引用，不展开解释正文或媒体字节。按 `created_at DESC,id DESC` 排序；base64url游标绑定本人、解释ID、attempt及末项位置，游标格式错误或跨用户/解释/尝试复用返回400。无本人反馈时items为空、next_cursor为null，但仍须通过前述任务与来源检查。响应使用 `Cache-Control:no-store`。客户端可在保存后重新GET、重新进入页面或重新登录后读取，不依赖上一页的内存状态。

本人反馈通过原feedback导出分区读取，导出还要求当前宠物家庭权限。媒体删除清关联解释反馈evidence及跨用户缓存，保留assessment和原始comment；无关媒体删除不影响其他解释反馈或旧普通反馈。活动源到期延续既有反馈证据清理策略，并清关联解释反馈的旧回执。账号注销删除本人反馈，宠物/家庭删除清所属反馈及仅保存ID的回执。恢复媒体删除日志执行同一清理，旧证据不会复活。

源失效后保留的本人原始反馈说明仍可按导出权限读取；上述任务反馈GET要求当前成功有效尝试，因此不会借“保留评论”返回已清空的旧解释证据。

解释反馈使用既有实体；当前全库为61张业务表，SQLite034/PostgreSQL023。数据库结构见 [数据流](database-dataflow.md)，协作与验证要求见 [协作流程](process.md)。
