# 第二批后端：内容、课程与健康观察历史

2026-11-24 在第一批基础上增加内容目录、版本化课程、本人学习记录，以及已有活动评估的历史、详情和本人已阅。日常状态分的正式公式和缺项策略仍待确认，当前不生成评分。真实审核内容需由内容负责人提供，普通安装和演示不会自动播种已审核指导文案。

## 1. 内容维护与发布

内容复用三张表：`content_items` 保存当前目录状态和并发版本，`content_versions` 保存不可覆盖正文、来源、审核资料及各版本发布状态，`learning_progress` 保存本人的课程版本和自报进度。`kind` 支持 `plan/tip/guidance/lesson`，不重复建立另一套课程主数据。

维护者通过本地受控命令导入 JSON，不开放普通用户编辑/审核接口，也不复用客服或设备管理员身份来审核内容：

```powershell
# 使用明确的环境文件；先构建最新源码，再执行一次性导入。
./start.bat .env content-import ./catalog.json

# 也可使用普通配置；命令同样先构建。
npm.cmd run content:import -- ./catalog.json
```

维护目录示例（草稿，不会向普通用户发布）：

```json
{
  "items": [{
    "id": "4f6b63e4-5341-4fa9-a917-2223b482dbe5",
    "kind": "lesson", "content_version": 1, "expected_revision": 0, "status": "draft",
    "content": {
      "title": "待审核课程", "category": "待维护分类", "summary": "内容负责人填写",
      "body": "待提供正式正文", "applicability": "待明确适用范围", "sources": [],
      "review": { "status": "pending" },
      "lesson": { "video": null, "steps": [{ "id": "step-1", "title": "待维护步骤", "body": "待提供正式步骤" }] }
    }
  }]
}
```

`status` 为 `draft/published/withdrawn`。发布必须有实际来源列表，以及 `review:{status:"reviewed",reviewer:"实际审核人",reviewed_at:"实际UTC时间"}`；审核时间不能晚于服务端现在。导入仅记录维护者声明的资料，不代表后端独立核验了资质或内容结论。视频可为空；填写时仅接受 HTTPS 元数据，后端在任何模式均不下载视频或抓取来源网站。

目录首次导入 `expected_revision:0`，后续使用上次返回的 `revision`；版本不符返回409。相同内容版本的正文、来源、审核资料不可覆盖，编辑时提交递增 `content_version`。草稿待审核后发布也需用新版本保存审核事实。同版本可在保持正文不变的前提下更新发布状态；切为草稿或撤回时撤回此前可见历史版本。直接发布新版本时，实际发布过且未撤回的旧版本可按版本读取；从未发布或已撤回的旧正文不会因后续新版本发布而恢复可见。

整份文件最多200项，在同一事务内保存，任一项失败则整批回滚。默认目录为空，不会返回设计稿中的课程数量或生成审核人。

## 2. 内容、课程与本人学习

所有读取和学习接口使用 Bearer 登录令牌：

| 接口 | 行为 |
| --- | --- |
| `GET /content?kind=&category=&q=&limit=&cursor=` | 当前已发布且已审核目录；q是标题字面子串，通配符作为普通字符匹配 |
| `GET /content/{id}?version=` | 当前版本，或指定确实发布且未撤回的审核版本 |
| `GET /lessons?category=&q=&limit=&cursor=` | 复用目录，固定kind=lesson，带本人的该版本进度 |
| `GET /lessons/{id}?version=` | 视频元数据、步骤、来源、适用范围和对应本人进度 |
| `PUT /lessons/{id}/progress` | 保存本人当前课程版本的完整进度快照 |
| `GET /learning-progress?limit=&cursor=` | 本人各版本历史进度和当前目录的完整学习计数 |

保存进度示例：

```json
{ "content_version": 2, "completed_step_ids": ["step-1"], "learned": true, "expected_version": 0 }
```

步骤必须属于提交版本，重复或无效步骤拒绝。步骤勾选和 `learned` 相互独立；`learned` 仅表示本人主动标记，不推断实际掌握或自动由勾选数量生成。PUT是完整快照，取消标记可提交 `learned:false`。首次完成时间在持续标记期间保持，取消后再次标记使用新的时间。

保存支持 `Idempotency-Key` 和乐观版本；同键同内容重放不增加完成次数，旧编辑版本返回409。发布状态与当前内容版本在重放前重新校验：课程升级后旧请求返回409，下架后返回404。新内容版本不继承旧版进度，旧学习事实仍可读取和导出。

`counts.scope=all_current_published_lessons`：`available_count` 统计整个当前可见课程目录，`learned_count` 只计本人当前版本的learned，一门课只计一次。这些计数不受进度分页长度影响，也不声称旧版本完成仍等同新版本完成。目录为空时返回真实的0/0。个人记录不绑定家庭或宠物，切换宠物不改变归属；注销清个人记录，系统目录与其他用户进度保留。

## 3. 健康观察历史与本人已阅

当前健康资源为 `kind:activity_assessment`，复用既有 `activity_observations` 的完整自然日评估，包括其比较、基线、覆盖、缺项原因、规则版本及证据。输入不足或没有显著变化的评估也可查，`finding_count` 如实返回0；没有建立心率、疾病或其他新的健康规则。

```text
GET   /pets/{id}/health-observations?from=&to=&timezone=&read_status=&limit=&cursor=
GET   /health-observations/{id}
PATCH /health-observations/{id}/read
```

历史只读取已经生成、保存的完整日评估，不自动补齐未请求过的日期。沿用 `GET /pets/{id}/observations?date=&timezone=` 生成或重读某日评估；今日 `observations/current` 的临时ID及未结束日快照不进入健康历史。响应注明 `scope=saved_completed_day_activity_assessments`，空列表不意味着宠物没有健康异常。

from/to按评估生成时点筛选，含from、不含to，默认最近31×24小时，单次最多31天；`timezone` 可选过滤评估采用的时区。`read_status` 为all/read/unread。游标绑定本人、宠物及全部过滤条件，分页继续使用响应中的固定from/to。按生成时间和ID倒序分页，保留全部评估版本；`superseded` 根据该宠物/日期/时区的评估插入顺序判断，避免把同毫秒UUID排序当成事实先后。

有效输入未改变时复用当前评估ID，增加无关日期或仅睡眠样本不重置已阅。步数、活动分钟、对应覆盖、来源或估算属性变化后创建新的证据版本；A→B→更正回A也产生新版本，旧ID和已阅不复活。步数和活动分钟分别记录来源及估算属性，睡眠或另一个指标的来源不混入其证据。旧评估和关联反馈继续可读取，证据里的source_revision是当时生成依据。

详情返回原证据，历史版本不会被新事实覆盖。owner/caregiver/viewer均可读取获准宠物，并标记**本人**已阅；重复已阅保留首次时间，可传 `Idempotency-Key`。已阅表示本人知晓，不关闭观察、不改变安全事件、不替代诊疗判断。每次读取及旧请求重放均检查当前家庭访问权，撤权后拒绝。审核内容关联目前返回空列表，不填入未经审核的指导。

## 4. 数据与运行配套

SQLite `026-content.sql/027-health-observation-reads.sql` 与 PostgreSQL `015-content.sql/016-health-observation-reads.sql` 增加四表，当前全库为61张业务表。PostgreSQL的观察表增加内部序列以对应SQLite插入顺序，不改变业务JSON合同。

本人导出新增 `learning_progress/health_observation_reads`；已阅导出还校验其关联宠物的当前家庭权限。课程进度与已阅在注销时清除；宠物/家庭删除、活动保留清理删除评估时级联清理已阅和缓存回执。删除及保留预览通过独立 `related_counts.health_observation_reads` 给出关联数量。目录不作为个人资料删除，全部内容版本随整库备份保存。

导入继续只读SQLite源且要求空PostgreSQL目标。备份按清单保存的实际迁移版本与表集验证，已知旧归档验证后再升级。没有新增运行依赖、环境变量、外部业务调用或常驻服务；环境示例补充内容维护说明，`start.bat` 的内容导入分支同样先构建再执行，执行完成不启动额外服务。
