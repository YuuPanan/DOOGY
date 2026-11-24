# DOOGY 前后端数据接口与协作约定

核对日期：2026-11-25。适用于当前 Android 优先的 React Native + Expo 客户端和 NestJS 后端。API 业务版本为 `/api/v1`；后端包版本与 App 安装包版本分别管理，不用安装包版本替换 API 路径。

本文依据当前控制器、Zod 校验、移动端实际调用和模块合同整理。它描述现有软件接口，不表示真实项圈、模型、地图、第三方登录或外发渠道已经接入。产品范围见 [主需求](Doggy_final.md)，页面入口与保存／返回／重读条件见 [51 画板闭环表](docs/app-closed-loop.md)。历史阶段文档中的“待实现”以当前源码和本表为准。

## 1. 运行边界与接口入口

| 项目 | 约定 |
| --- | --- |
| App | 负责交互、显式录入、当前范围草稿、会话恢复和授权请求；不运行数据库、NestJS、Worker或设备模拟器 |
| API | 验证身份／角色／数据归属，接收业务操作，返回当前持久化结果 |
| Worker | 处理已接收的异步事件、任务和模拟通知；`202` 仅表示已受理 |
| 服务根地址 | App 填 `http(s)://host:port`，不附 `/api/v1`；现有客户端统一补此前缀 |
| HTTP API | 下文路径均省略 `/api/v1`；`{id}` 替换为对应资源响应的实际 ID |
| Swagger | 服务根 `/docs`，不在 `/api/v1/docs` 下 |
| OpenAPI JSON | 服务根 `/openapi.json`；可用于路由和字段联调，跨资源业务语义仍需看本文和源码 |
| 仓库内接口快照 | [docs/openapi.json](docs/openapi.json)，从同批纯净源码实际导出：129个路径、158个操作；部署后仍核对运行实例的版本 |
| 兼容 Web | 服务根 `/app/`；移动 App 与 Web 使用同一业务 API |

`DATA_MODE=offline` 表示业务不调用真实外部服务，App 仍须能连接后端；不是断网后在手机内运行后端。`api` 模式也不代表所有供应商已配置。读取 `GET /health` 和 `GET /integrations/status` 的实际能力，缺配置显示明确原因。

## 2. 统一数据规则

### 2.1 身份与客户端封装

私有用户接口使用 `Authorization: Bearer <access_token>`。注册、登录、刷新、密码找回／重置及健康检查是公开入口。设备入站使用独立设备凭据，不能混用用户 Bearer。

直接复用 [ApiClient](mobile/src/lib/client.ts)、[MobileApi](mobile/src/lib/mobileApi.ts) 与 [AppContext](mobile/src/state/AppContext.tsx)：

- access token 在内存；refresh token 由原生安全存储适配器保存。`POST /auth/refresh` 轮换两种 token，前端须保存新 refresh token。
- 并发 `401` 共用一次刷新，再以新 access token 重发原请求；明确失效才清会话。临时网络／身份读取失败保留有效恢复材料，并提供恢复重试。
- 退出先清本机与旧页面，再尝试服务端撤销；切换服务器、区域、用户后，旧请求不能改变新会话。
- 不把 Bearer、refresh token、设备永久密钥放到 URL、页面日志、公开配置或 Git 仓库。

### 2.2 成功、错误与分页

**没有统一的 `{code:0,data:...}` 成功封装。** 单资源直接返回业务对象；列表一般为 `{items:[...],next_cursor:null}`，家庭／宠物等不分页列表可能只有 `items`。不要凭接口路径统一解包 `response.data`。

校验失败示例（具体 `issues` 路径取决于实际字段）：

```json
{
  "code": "VALIDATION_ERROR",
  "message": "请求参数不正确",
  "issues": [{ "path": ["expected_version"], "message": "字段校验说明" }],
  "request_id": "服务端请求追踪ID"
}
```

响应带 `x-request-id`；错误正文带 `request_id`。保留业务 `code` 供提示和排查，不只判断 HTTP 状态。常见处理：

| 状态／错误 | 前端行为 |
| --- | --- |
| `400 / VALIDATION_ERROR / INVALID_CURSOR` | 显示字段或范围问题；切换范围后清旧游标重读 |
| `401` | 交给现有客户端刷新逻辑；明确失效后重新登录 |
| `403 / READ_ONLY / OWNER_REQUIRED` | 当前角色不能执行，不能靠隐藏按钮代替后端授权 |
| `404` | 资源不存在、来源已删除或当前无权访问；跨家庭资源通常不暴露是否存在 |
| `409 / VERSION_CONFLICT / ATTEMPT_CONFLICT` | 保留草稿，显式重读当前版本／尝试，再由用户重新确认 |
| `409 / IDEMPOTENCY_CONFLICT` | 同一个幂等键被用于不同内容，必须纠正业务意图，不能盲目重试 |
| `413 / BODY_TOO_LARGE` | 文件／请求过大，提示用户重新选择或裁剪 |
| `416` | 媒体 Range 无效或不可满足 |
| `429` | 请求受限，停止立即循环重试 |
| `5xx` 或客户端 `NETWORK_ERROR` | 保存状态可能未确认，保留可重试内容并到列表核对 |

支持分页的接口多用 `limit/cursor`，共用 `pageQuery` 默认50、范围1–200；部分接口有自己的限制，以上线 Schema 为准。`next_cursor:null` 才表示没有下一页；游标视为不透明字符串，不自行拆解、排序或拼造。继续分页时保持原用户、宠物、筛选、时间范围及排序。范围变化清游标；不能把 A 宠物游标用于 B，也不能把第一页动态“现在”重新计算后带入续页。

### 2.3 幂等、版本与保存范围

支持幂等的写接口在下文标明或在 Swagger声明 `Idempotency-Key`。同一次意图及不确定的网络重试沿用同一键；内容改变或用户主动新建时换键。并非所有写接口都实现服务端幂等，不因客户端附了头就假定可安全重放。

`expected_version` 是编辑版本，不是时间戳；新资源常为0，但联系人更新／删除需要当前正版本。`expected_attempt` 是异步任务的当前尝试编号，不能与编辑版本混用。PUT 目标、身体观察和学习进度是**完整快照**；省略字段可能保存为 `null`、空数组或默认值，前端修订时须带回需要保留的字段。

保存成功后使用返回的资源 ID／版本，重读实际结果。若 POST 已成功、后续刷新失败，只重试读取，不能再创建第二条。Goal 与 Body 同宠物／日期／时区的草稿分别保存；一项保存或普通刷新不覆盖另一项未保存内容。

### 2.4 时间、单位与缺失值

- 时间点使用带时区 ISO 8601，服务端归一为 UTC；自然日使用 `YYYY-MM-DD` 和有效 IANA 时区，例如 `Asia/Shanghai`。不使用固定 `+08:00` 代替 IANA 时区字段。
- 宠物有效时区依次使用请求指定值、宠物设置、家庭设置及服务端缺省。页面展示所用日期、时区和返回的实际边界。
- 常见 `from/to` 为 `[from,to)`，最多31天；趋势是当地日期窗口；安全历史无边界时保留全部历史。不能把各接口默认范围假定相同。
- `null`／`missing`／未知表示无可靠数据，不转换为0或“健康正常”。体重归一 kg、距离 m、活动与睡眠汇总分钟；设备活动入站使用秒，不能混淆。
- 位置服务端标准坐标为 WGS84。供应商或地图坐标转换在适配层完成；不能把 GCJ-02／BD-09 当作 WGS84 直接入库。
- 四项身体观察保存原文，**不评分**；目标达成百分比不等于宠物健康分。

### 2.5 权限与作用域

| 范围 | 读取 | 写入及例外 |
| --- | --- | --- |
| 家庭／宠物共享事实 | 当前 owner、caregiver、viewer | 通常 owner/caregiver；viewer只读 |
| 家庭成员、所有权及共享数据删除／保留 | 依具体接口 | owner专属；设备所有权另有本人校验 |
| 课程学习、健康已阅 | 本人记录，仍校验必要资源权限 | viewer可保存本人的学习／已阅，不获得共享事实写权限 |
| 问答会话与消息 | 仅本人且当前仍有该宠物读权限 | viewer可提交本人问答；同家庭其他用户不能读本人会话 |
| 解释反馈 | 本人且当前成功、来源有效、attempt相同 | owner/caregiver提交；降为viewer后可重读本人旧反馈，不能再写 |
| 客服／设备管理员 | 配置了对应管理身份才可用 | 家庭owner不自动成为平台管理员 |

服务器、用户、家庭、宠物、角色或当前内容／任务版本改变时，前端丢弃旧范围的迟到回包与播放器来源。A→B→A 也属于新的范围生命周期，不能仅比较最终 ID 相同就恢复旧结果。

## 3. 注册、登录、个人资料与引导

| 方法与路径 | 主要请求 | 结果／用途 |
| --- | --- | --- |
| `GET /health` | 无 | `status/mode/database/demo/time`；明确 `demo:true` 时才显示合成账号填入入口 |
| `POST /auth/register` | `email/password`；可选 `household_name/timezone/display_name/consent` | `user/household` 与会话材料，默认创建本人家庭 |
| `POST /auth/login` | `email/password` | `user/access_token/refresh_token/token_type/expires_at/refresh_expires_at` |
| `POST /auth/refresh` | `refresh_token` | 轮换会话材料；HTTP200 |
| `GET /auth/me` | Bearer | 本人 ID、邮箱、显示名、资料版本、条款接受记录及客服身份标记 |
| `PATCH /auth/me` | `expected_version` 与 `display_name` 或 `consent` | 更新本人资料，支持幂等 |
| `POST /auth/logout` | 旧 access Bearer | `logged_out:true`，撤销相应会话 |
| `GET /auth/onboarding` | Bearer | 本人选择、`version/next_step/binding/device_report/bluetooth` |
| `PATCH /auth/onboarding` | `expected_version`；可选 `pet_id/collar_choice/completed` | 保存并返回当前引导状态，支持幂等 |
| `POST /auth/password-recovery` | `email` | HTTP202，`accepted/request_id/delivery_status`；不返回重置秘密 |
| `POST /auth/password-reset` | `request_id/token/new_password` | HTTP200；成功后旧会话失效 |

注册示例。邮箱使用保留测试域，ID、密码和示例日期均需替换为本次测试输入：

```json
{
  "email": "frontend@example.invalid",
  "password": "example-password-change-me",
  "household_name": "合成联调家庭",
  "timezone": "Asia/Shanghai",
  "display_name": "联调用户"
}
```

密码8–128字符。显示名可省略或显式 `null`，空字符串不能作为已填写显示名。`consent` 只有真实展示并接受了条款版本才发送，例如 `{"terms_version":"实际版本","privacy_version":"实际版本","source":"registration-form"}`；接受时间由后端生成。

登录成功响应的字段结构节选如下；省略字段不表示服务端不返回，token示意字符串不能用于实际请求：

```json
{
  "user": { "id": "77777777-7777-4777-8777-777777777777", "email": "frontend@example.invalid", "display_name": "联调用户", "profile_version": 1 },
  "access_token": "<本次响应签发的访问材料>",
  "refresh_token": "<本次响应签发的刷新材料>",
  "token_type": "Bearer",
  "expires_at": "2026-11-25T03:15:00.000Z",
  "refresh_expires_at": "2026-12-25T03:00:00.000Z"
}
```

示例时间仅展示ISO格式，不声明部署实例的token期限；以本次实际返回为准。

登录后并行读取本人、家庭、宠物和引导。`next_step` 为 `create_or_select_pet/connect_collar/finish/done`。选择或建宠后保存选择；可明确 `collar_choice:"skipped"` 后完成；标记 `completed` 的真实绑定路径需要当前绑定存在。成功完成请求才进入 Main，失败留在原页可重试。`device_report.status=waiting/received/unbound` 与 `bluetooth.status=unknown` 不能合并为“连接成功”。

密码恢复的 offline 投递通过受控后端 CLI完成；`delivery_status` 不能显示为真实邮件已发。api未配置投递也不能伪造成功。详见 [密码恢复](docs/password-recovery.md)。

## 4. 家庭、宠物档案与头像

| 方法与路径 | 主要字段／结果 |
| --- | --- |
| `GET /households` | `{items:[...role,timezone...]}` |
| `PATCH /households/{householdId}` | `name/timezone`；家庭owner管理 |
| `GET /households/{householdId}/members` | 本家庭成员列表，包含 `user_id/role/email` |
| `POST /households/{householdId}/invitations` | `email/role`；role为caregiver或viewer；返回短期邀请凭据及到期时间 |
| `POST /invitations/{token}/accept` | 接受与本人邮箱匹配的邀请；HTTP200 |
| `PATCH /households/{householdId}/members/{userId}` | `role:caregiver|viewer`；仅owner管理 |
| `DELETE /households/{householdId}/members/{userId}` | 撤销共享权限 |
| `GET /pets` | 当前本人可访问的宠物 `items` |
| `POST /pets` | `household_id/name`；可选 `species/breed/birth_date/weight_kg/timezone`；支持幂等 |
| `GET /pets/{petId}` | 档案及 `timezone/effective_timezone/avatar` |
| `PATCH /pets/{petId}` | 档案字段局部更新；支持幂等 |
| `PUT /pets/{petId}/avatar` | multipart `file/expected_version`，支持幂等 |
| `GET /pets/{petId}/avatar/content?version=N` | 当前授权版本的图片字节 |

```json
{
  "household_id": "22222222-2222-4222-8222-222222222222",
  "name": "合成宠物",
  "species": "dog",
  "breed": null,
  "birth_date": null,
  "timezone": "Asia/Shanghai"
}
```

`species=dog/cat/other`；体重正数且不超过300kg。档案提交非空 `weight_kg` 会生成可追溯称重事实；已有有效称重历史时不能通过把档案体重设null来隐藏历史。头像支持JPEG/PNG/WebP、最多5MiB，真实文件头与MIME校验；首次版本0，替换后旧版本404。头像、媒体和附件都通过授权请求读取，不提供永久公开正文地址。

## 5. 首页、照护记录与附件

| 方法与路径 | 请求／返回要点 |
| --- | --- |
| `GET /pets/{petId}/overview?date=&timezone=` | 当前宠物、设备、活动、照护、待办与数据缺口聚合；不由前端补出未知指标 |
| `GET /pets/{petId}/care-records` | `type/custom_type/status/from/to/limit/cursor`；status默认active，可选withdrawn/all |
| `POST /care-records` | 完整新事实，支持幂等；返回记录对象 |
| `GET /care-records/{recordId}` | 当前记录，`value/attachments` |
| `PATCH /care-records/{recordId}` | `value/recorded_at/notes/custom_type`；支持幂等，保留修订 |
| `GET /care-records/{recordId}/history` | 历史修订 |
| `POST /care-records/{recordId}/withdraw` | `reason`1–500字，支持幂等；不以物理删除代替撤回 |
| `POST /care-records/{recordId}/attachments` | multipart `file`，可选 `filename`；支持幂等 |
| `GET /care-records/{recordId}/attachments` | 附件 `items`，含授权下载路径 |
| `GET /care-attachments/{attachmentId}/content` | 授权附件原字节 |

`type` 为 `weight/feeding/medication/grooming/note/toileting/custom`；`value` 是对象。`toileting.value.kind` 必须是 `urination/defecation/both`；`custom` 必须提供顶层 `custom_type`1–100字，非custom不传此字段。`recorded_at` 是事情发生时间；`source=owner/vet` 是录入者声明，不代表后端核验兽医来源。

```json
{
  "pet_id": "11111111-1111-4111-8111-111111111111",
  "type": "feeding",
  "recorded_at": "2026-11-24T03:00:00Z",
  "source": "owner",
  "notes": "合成联调餐食",
  "value": {
    "schema_version": "feeding-v1",
    "food_name": "合成示例食物",
    "category": "dry",
    "amount": 100,
    "unit": "g",
    "meal_type": "meal",
    "label_energy": { "kcal": 360, "per_amount": 100, "unit": "g", "source": "合成包装标签" }
  }
}
```

喂食单位 `g/kg/ml/portion`，餐别 `meal/snack`。没有标签能量就保持未知；不推测ml与g或portion换算。`weight` 可用 `{"weight":12,"unit":"kg"}`、lb原值，或兼容 `{"weight_kg":12}`；后端保留原值并归一kg。旧喂食JSON编辑时保留原数量／单位键，不静默改造成新版记录。

附件最多10个／记录、每个5MiB，支持JPEG/PNG/WebP/PDF及实际格式校验。撤回会影响有效汇总和派生证据，撤回后的附件不可继续作为有效事实读取。详见 [照护类型](docs/care-types.md)、[附件](docs/care-attachments.md)、[撤回](docs/care-withdrawal.md)。

## 6. 活动、营养、目标与身体观察

| 方法与路径 | 参数／主要结果 |
| --- | --- |
| `GET /pets/{petId}/activity/daily` | `date/timezone`；实际日窗口、指标值、来源、样本、覆盖及修订 |
| `GET /pets/{petId}/activity/weekly` | `date/timezone`；实际周窗口与每日数据 |
| `GET /pets/{petId}/activity/intervals` | `from/to/bucket=hour|day/timezone/limit/cursor`；逐桶覆盖，窗口最多31天 |
| `GET /pets/{petId}/trends` | `metric/from/to/timezone/limit/cursor`；metric为steps/active_minutes/sleep_minutes/distance_m/weight_kg，日期窗口最多31天 |
| `GET /pets/{petId}/nutrition/daily` | `date/timezone`；明细、known_kcal/target_kcal、未知数量与完整性口径 |
| `GET /pets/{petId}/goals` | `date/timezone`；`goals/effective_date_version/progress` |
| `PUT /pets/{petId}/goals` | 完整目标快照，支持幂等与expected_version；返回新目标版本 |
| `GET /pets/{petId}/body-check-ins` | `date/timezone`；无记录时version0、四项values全null |
| `PUT /pets/{petId}/body-check-ins` | 查询date/timezone加完整正文，支持幂等与expected_version |
| `GET /pets/{petId}/features` | `date/timezone`；带版本和来源的特征汇总，不能当作模型已分析 |

目标保存示例：

```json
{
  "effective_date": "2026-11-24",
  "expected_version": 0,
  "targets": { "active_minutes": 30, "steps": null, "intake_kcal": null },
  "source": "user_provided",
  "plan": {
    "name": "合成联调计划",
    "content_version": "33333333-3333-4333-8333-333333333333@1",
    "walk_minutes": 20, "play_minutes": 5, "training_minutes": 5
  }
}
```

`targets.active_minutes`正数≤1440，`steps`正整数≤1000000，`intake_kcal`正数≤100000，均可null。计划分钟非负且合计≤1440；plan可为null。选内容计划只预填草稿，用户确认才PUT，计划总时长不自动修改活动目标。Goal版本按 `(pet_id,effective_date)` 计数；查询日回落到较早生效目标时，编辑应使用 **effective_date_version**，不能直接拿历史 `goals.version` 写另一天。

身体观察保存到 `PUT /pets/{petId}/body-check-ins?date=2026-11-24&timezone=Asia%2FShanghai`：

```json
{
  "expected_version": 0,
  "observed_at": "2026-11-24T03:00:00Z",
  "values": { "appetite": "主人的原始食欲描述", "energy": null, "movement": null, "stool": null },
  "notes": "合成观察，暂不评分",
  "toileting_record_id": null
}
```

四项为null或1–200字原文。观察时间必须落在所选当地日期内且不晚于服务端现在；补历史日须传实际时间。排便引用必须是本宠物当天有效的排便／两者照护记录，保存引用不会再新增排便事实。后续引用撤回时返回 `toileting_record_status`，前端不能保留“仍有效”的旧展示。

`nutrition.completeness_scope=recorded_feeding_only` 只说明已记录餐食的标签完整性，不说明全天摄入已完整。自然日可以因DST为23／25小时；覆盖不足、来源不同、基线为零等比较必须展示返回的不可比原因。详见 [第一批业务合同](docs/stage-01-backend.md)。

## 7. 健康观察、已阅与反馈

| 方法与路径 | 行为 |
| --- | --- |
| `GET /pets/{petId}/observations/current?timezone=` | 今日同进度比较，不是完整日健康历史，不产生评分 |
| `GET /pets/{petId}/observations?date=&timezone=` | 生成或重读指定自然日已有活动规则评估 |
| `GET /pets/{petId}/health-observations` | `from/to/timezone/read_status/limit/cursor`；已保存完整日评估历史 |
| `GET /health-observations/{observationId}` | 当时的版本、覆盖、比较和证据；不拿新事实覆盖旧证据 |
| `PATCH /health-observations/{observationId}/read` | 标记本人已阅，支持幂等；重复保留首次read_at |
| `POST /pets/{petId}/feedback` | 活动／健康观察反馈；`feature_date/assessment/comment/evidence`，可绑定 `observation:{id,evidence_id}` |

历史默认最近31×24小时，按评估生成时间过滤；`read_status=all/read/unread`。列表只包含已保存、已结束日的活动评估，`scope=saved_completed_day_activity_assessments`；空列表不是“宠物无异常”。status可能为 `day_in_progress/ready/insufficient_data`；已阅不关闭风险，也不替代诊疗判断。输入更正会产生新证据版本，旧已阅不会自动代表新证据已阅。详见 [今日观察](docs/current-observations.md)、[内容与健康历史](docs/stage-02-backend.md)。

## 8. 内容、课程、本人学习与选用计划

| 方法与路径 | 参数／结果 |
| --- | --- |
| `GET /content` | `kind=plan|tip|guidance|lesson/category/q/limit/cursor`；已发布且已审核目录 |
| `GET /content/{contentId}?version=N` | 可见当前或指定可见历史版本 |
| `GET /lessons` | `category/q/limit/cursor`；固定lesson，带本人进度 |
| `GET /lessons/{lessonId}?version=N` | 课程正文、视频元数据、步骤、来源及本人该版本进度 |
| `PUT /lessons/{lessonId}/progress` | 完整本人进度；支持幂等与expected_version |
| `GET /learning-progress?limit=&cursor=` | 本人各版本进度与全当前目录计数 |

```json
{ "content_version": 1, "completed_step_ids": ["read", "try"], "learned": true, "expected_version": 0 }
```

步骤ID必须来自当前课程响应，不能发送示例ID代替真实步骤。`learned`是本人主动报告，与勾选数量独立，不推断掌握。新课程版本不继承旧版学习；当前目录升级返回409、下架返回404，应提示重读。`counts.scope=all_current_published_lessons` 的计数不受当前页长度影响。

内容返回 `id/kind/content_version/current_version/catalog_revision/title/category/summary/body/applicability/sources/review/lesson` 等；plan可带 `exercise_plan:{walk_minutes,play_minutes,training_minutes}`。仅结构化分钟用于选用，不从任意旧文字正文推导运动处方。视频是外部HTTPS元数据，不表示服务端已经下载或验证可播放；普通用户没有内容审核／发布API。正式目录默认空，独立演示内容必须显示“合成演示”。

## 9. 媒体采集、真实上传、授权播放与删除

| 方法与路径 | 请求／结果 |
| --- | --- |
| `GET /pets/{petId}/media/capabilities` | `upload_enabled/max_size_bytes/max_duration_seconds/supported_formats/reason` |
| `POST /pets/{petId}/media` | multipart `file/captured_at`；支持Idempotency-Key，成功返回媒体元数据 |
| `GET /pets/{petId}/media?limit=&cursor=` | 媒体元数据分页 |
| `GET /media/{mediaId}` | `id/pet_id/filename/content_type/size_bytes/sha256/duration_seconds/captured_at/source/validation/content_path` 等 |
| `GET /media/{mediaId}/content` | Bearer授权原字节，支持HEAD／单段Range |
| `DELETE /media/{mediaId}` | 删除媒体与派生引用，当前owner/caregiver才可写 |

首版限制 **60秒、20MiB**。支持WAV PCM、MP3、M4A AAC、MP4 H.264（可带AAC）；实际probe与decode验证，不信任客户端MIME、扩展名或声明时长，改名MOV也拒绝。服务端缺FFmpeg/ffprobe时能力原因是 `MEDIA_VALIDATOR_NOT_CONFIGURED`；只读角色为 `READ_ONLY`，不得仍显示可上传成功。

前台录音使用M4A/AAC，原生59秒停止为编码尾部留余量；用户实际点击才申请麦克风。不开放相机、后台录音／播放和手机定位。导入须由用户填写真实采集起点，不能以导入时刻代替；采集起点加实际时长不能晚于服务端现在。上传成功不会自动创建解释或外发。

现有移动调用示例：

```ts
const media = await api.upload(
  `/pets/${petId}/media`,
  { uri: selectedCacheUri, name: originalFilename, mimeType: selectedMime },
  draftIdempotencyKey,
  { fields: { captured_at: userReportedCapturedAt } }
);
// 校验返回 pet_id 属于当前范围，再用 media.id 选择详情并刷新列表。
```

Expo58默认 `expo/fetch` 不接受旧 `{uri,name,type}` 文件表单。必须沿用 `MobileApi.upload` 的 FileBlob `bytes()` 实现，保留原文件名／MIME／字段／方法／幂等键；不要在页面另写旧式FormData或手工指定缺boundary的multipart Content-Type。首次上传固定文件、时间和键；网络未确认时按同一草稿重试。取消或切范围清本模块缓存，不删除系统提供方原文件。

播放先重读授权元数据，再向 `content_path` 附加Bearer；原生 `VideoView.nativeControls` 管理播放／暂停／进度，保留“停止并清除来源”。离页、后台、退出、切宠清播放器来源，不设永久公开URL。`Range:bytes=0-99`／开放尾／后缀可返回206，错误／多段返回416；正文 `no-store/nosniff`。授权下载与系统分享入口不表示已向第三方发送。

`validation`可含 `version:ffmpeg_decode_v1/decoded/container/codecs/actual_duration_seconds/captured_at_source:user_reported/model_analyzed:false`；这是解码事实，不是AI识别。媒体保存至主动删除或删宠；删除后旧ID404，相关解释／问答证据失效。详见 [媒体完整合同](docs/media-upload.md)。

一次有效PCM WAV上传的响应结构节选：

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "pet_id": "11111111-1111-4111-8111-111111111111",
  "filename": "synthetic.wav",
  "content_type": "audio/wav",
  "size_bytes": 16044,
  "duration_seconds": 1,
  "captured_at": "2026-11-24T03:00:00.000Z",
  "source": "owner_upload",
  "content_path": "/api/v1/media/44444444-4444-4444-8444-444444444444/content",
  "validation": { "version": "ffmpeg_decode_v1", "decoded": true, "container": "wav", "codecs": ["pcm_s16le"], "actual_duration_seconds": 1, "captured_at_source": "user_reported", "model_analyzed": false }
}
```

## 10. 人工行为、解释任务与本人反馈

| 方法与路径 | 请求／结果 |
| --- | --- |
| `POST /pets/{petId}/behavior-records` | `labels/start_at/end_at/notes/media_id`；人工原文，支持幂等 |
| `GET /pets/{petId}/behavior-records` | `from/to/label/media_id/limit/cursor` |
| `GET /behavior-records/{recordId}` | 人工记录及原媒体是否已删除 |
| `POST /pets/{petId}/interpretations` | 有效 `media_id`，可选行为引用、时间窗、背景与说明；HTTP202，支持幂等 |
| `GET /pets/{petId}/interpretations` | `from/to/status/media_id/limit/cursor`；历史摘要，点选后读详情 |
| `GET /interpretations/{taskId}` | `status/attempt/captured_mode/execution_source/model_version/result/evidence/error_code`等 |
| `POST /interpretations/{taskId}/retry` | `expected_attempt`；显式新尝试，支持幂等 |
| `POST /interpretations/{taskId}/cancel` | 空正文；取消未结束任务，支持幂等 |
| `POST /interpretations/{taskId}/feedback` | `expected_attempt/assessment/comment`；本人写，支持幂等 |
| `GET /interpretations/{taskId}/feedback` | 必传 `expected_attempt`，可选limit/cursor；本人反馈分页 |

```json
{
  "media_id": "44444444-4444-4444-8444-444444444444",
  "behavior_record_id": null,
  "background": ["not_sure_yet"],
  "notes": "合成联调任务，明确未接真实模型"
}
```

时间窗from/to同时提供且有效；省略时取媒体实际采集起点和所存时长，不能只填一侧。背景仅 `routine_changed/not_sure_yet`，不重复。人工记录的单个标签是1–100字文本、最多10个且不重复，标签数组可为空；时间窗必须为正、非未来，最多31天。媒体与行为引用均须属于当前宠物。

```json
{ "expected_attempt": 1, "assessment": "helpful", "comment": "合成联调反馈" }
```

assessment为 `helpful/incorrect/other`，comment去空白后1–4000字。只可反馈当前成功且来源有效的attempt；本人历史GET同样核对当前attempt和宠物读权限，不返回同家庭他人的评论。任务已重试或媒体已删时旧反馈不能被当作当前有效证据。

解释和问答的共用状态机：`pending → processing → succeeded|failed|cancelled`。前端以GET返回的status更新界面，不能把POST202直接显示为解释完成。retry复用资源ID、增加attempt；旧attempt请求409。原始来源已失效时，不能通过retry恢复旧证据。

offline结果明确 `execution_source:offline_demo`、`model_version:null`，不识别媒体、不推断健康／情绪；api未配置模型时任务失败 `MODEL_NOT_CONFIGURED`，不自动无限重试。实际排队模式和执行模式不同可能失败 `DATA_MODE_CHANGED`。详见 [行为、任务与反馈](docs/stage-03-backend.md)。

## 11. 本人会话与显式上下文问答

| 方法与路径 | 请求／结果 |
| --- | --- |
| `POST /pets/{petId}/assistant-conversations` | `title`1–200字；本人会话，支持幂等 |
| `GET /pets/{petId}/assistant-conversations` | `limit/cursor`；仅本人当前可访问宠物的会话 |
| `POST /assistant-conversations/{conversationId}/messages` | `question/context`；HTTP202，支持幂等 |
| `GET /assistant-conversations/{conversationId}/messages` | `limit/cursor`；按消息读取问题、状态和引用 |
| `GET /assistant-messages/{messageId}` | 当前消息任务详情与结果，包含宠物归属 |
| `POST /assistant-messages/{messageId}/retry` | `expected_attempt`，支持幂等 |
| `POST /assistant-messages/{messageId}/cancel` | 空正文，支持幂等 |

```json
{
  "question": "请说明这节合成课程包含哪些步骤",
  "context": {
    "kind": "lesson",
    "lesson_id": "33333333-3333-4333-8333-333333333333",
    "lesson_version": 1,
    "background": [],
    "notes": "合成联调"
  }
}
```

question去空白后1–4000字。上下文由用户显式选择：

| context.kind | 必要字段／语义 |
| --- | --- |
| `activity` | 可选date/timezone；当日真实活动与覆盖 |
| `body_check_in` | 可选date/timezone；已保存身体观察版本与原文 |
| `nutrition` | 可选date/timezone；已记录餐食、已知／未知能量及目标版本 |
| `lesson` | 必须lesson_id及lesson_version，引用可见已发布版本 |
| `behavior` | behavior_record_id／interpretation_id必须且仅选一个；属于当前宠物，解释须成功且来源有效 |

没有关联媒体、也没有媒体删除标记的 `owner_annotation` 人工记录可作为原始文字上下文；后端明确 `used_by_model:false/evidence_usage:prepared_not_model_analyzed`。已因媒体删除而失效的记录不能绕成“无媒体原文”继续引用。会话归属不随切宠自动改变，不能将A会话带到B；即使同家庭也不能读取他人会话。offline固定演示使用 `simulated:true`，不展示为真实模型回答。

## 12. 设备库存、绑定与远程策略

| 方法与路径 | 请求／操作约定 |
| --- | --- |
| `GET /devices?limit=&cursor=` | 本人所有权库存；`binding_status/credential`仅元数据，不暴露原家庭宠物、遥测、永久token或绑定码 |
| `POST /devices/claim` | `device_id/pet_id/claim_code`；使用有效短期码绑定到可写宠物 |
| `GET /devices/{deviceId}` | 当前授权设备详情、绑定宠物、状态和凭据元数据 |
| `POST /devices/{deviceId}/unbind` | 本人设备解绑，返回短期claim_code及到期时间；不等同释放所有权 |
| `POST /devices/{deviceId}/claim-code` | 本人未绑定设备续发短期码；填入绑定草稿，不自动claim |
| `POST /devices/{deviceId}/release` | 释放本人未绑定设备供其他用户按流程认领 |
| `GET /devices/{deviceId}/reporting-policy` | 期望策略、已应用策略、走失会话及命令状态 |
| `PUT /devices/{deviceId}/reporting-policy` | `mode/interval_seconds/expires_in_seconds`；支持幂等 |
| `POST /devices/{deviceId}/lost-mode` | `enabled/expires_in_seconds`；支持幂等 |
| `GET /devices/{deviceId}/commands/{commandId}` | 读取具体命令回执；使用前一步实际返回的command_id |
| `GET /pets/{petId}/configuration-history` | `from/to/kind/resource_id/limit/cursor`；只返回已记录修改 |

```json
{ "device_id": "55555555-5555-4555-8555-555555555555", "pet_id": "11111111-1111-4111-8111-111111111111", "claim_code": "由受控流程取得的有效短期码" }
```

普通策略mode支持 `home_idle/home_active/boundary_watch/alert/low_power`，interval_seconds为15–86400整数，命令有效期30–3600秒。走失有效期60–86400秒；走失开启时先关闭再修改普通策略。接口受理与设备真实执行分开，必须显示 desired/applied、命令状态、时间及实际来源；offline模拟回执不显示为真实固件执行。

设备身份不等于宠物访问权。解绑／换绑后不得显示旧家庭遥测；读取来源、连接新鲜度、采样时间与接收时间均以服务端实际返回为准。BLE连接、软件claim、后端收到上报分别展示，不互相代替。凭据维护另见 [设备凭据](docs/device-credentials.md)，属于受控维护流程，不向普通App配置嵌入永久设备密钥。

## 13. 定位、围栏、位置分享与安全事件

| 方法与路径 | 请求／结果 |
| --- | --- |
| `GET /pets/{petId}/location/latest` | 当前位置及最近可用位置、采样／接收时间、精度、新鲜度、质量与追踪／围栏可用性 |
| `GET /pets/{petId}/locations` | `from/to/limit/cursor`；默认24小时、最多31天；续页固定首屏边界 |
| `GET /pets/{petId}/geofences` | 当前围栏列表 |
| `POST /geofences` | `pet_id/name/geometry`及可选缓冲／精度／确认规则，支持幂等 |
| `PATCH /geofences/{fenceId}` | 配置字段局部更新 |
| `DELETE /geofences/{fenceId}` | 停用围栏，不冒称删除全部历史 |
| `GET /pets/{petId}/safety-events` | `from/to/limit/cursor`；边界必须成对，最多31天；不传边界为全部历史 |
| `GET /safety-events/{eventId}` | 原风险、位置证据、确认记录及本人通知状态 |
| `POST /safety-events/{eventId}/ack` | `note`≤1000字，支持幂等；确认不关闭风险 |
| `POST /pets/{petId}/location-shares` | `consent:true/expires_in_seconds`，需当前绑定且有效走失会话 |
| `GET /pets/{petId}/location-shares` | 管理列表；此分享管理流程要求写角色，viewer不以此列举分享 |
| `DELETE /location-shares/{shareId}` | 创建者或家庭owner撤销 |
| `GET /location-shares/{token}` | 持有效短期分享token公开解析；绑定／走失结束／权限撤销后失效 |

```json
{
  "pet_id": "11111111-1111-4111-8111-111111111111",
  "name": "合成围栏",
  "geometry": { "type": "circle", "lat": 31.23, "lon": 121.47, "radius_m": 200 },
  "enabled": true,
  "buffer_m": 10,
  "accuracy_limit_m": 100,
  "confirm_points": 2,
  "dynamic_buffer": false,
  "min_buffer_m": 15,
  "min_exit_seconds": 0,
  "min_enter_seconds": 0
}
```

圆形geometry使用lat/lon/radius_m；polygon使用 `coordinates:[[lon,lat],...]`，注意顺序不同。半径正数≤100000m；精度阈值正数≤500m，confirm_points为2–10；复杂区域坐标合法性由后端继续校验。位置质量不合格不能用设计示例点替代；“最近可用位置”必须标出其历史时点。风险确认与风险解除分别表示，`delivery_status:unknown` 不显示为手机已收到。位置分享token只在创建时获取，不自动附入联系人消息，不写入普通日志。详见 [安全历史](docs/safety-history.md)、[配置与联系人](docs/configuration-contacts.md)。

## 14. 家庭联系人与显式联系请求

| 方法与路径 | 请求／结果 |
| --- | --- |
| `GET /households/{householdId}/contacts` | `limit/cursor`；当前授权家庭联系人 |
| `POST /households/{householdId}/contacts` | `name/phone/email/role_description/purpose/is_primary/consent`；支持幂等 |
| `PATCH /contacts/{contactId}` | `expected_version`及变化字段，支持幂等 |
| `DELETE /contacts/{contactId}` | 必传当前expected_version |
| `POST /pets/{petId}/contact-alerts` | 显式消息与逐个版本化收件人、`consent:true`；HTTP202，支持幂等 |
| `GET /pets/{petId}/contact-alerts` | `limit/cursor`；摘要历史、数量、当前status；不展开收件明细 |
| `GET /contact-alerts/{alertId}` | 本次消息与逐收件人状态、attempt、来源和错误 |
| `POST /contact-alerts/{alertId}/retry` | `expected_attempt`；HTTP202，支持幂等 |
| `POST /contact-alerts/{alertId}/cancel` | `expected_attempt`；HTTP200，支持幂等 |

```json
{
  "name": "合成联系人",
  "email": "contact@example.invalid",
  "phone": null,
  "role_description": "联调联系人",
  "purpose": "软件流程演示",
  "is_primary": false,
  "consent": { "status": "reported_granted", "note": "合成演示声明" }
}
```

phone/email至少一个非空；联系人同意为家庭成员报告 `unknown/reported_granted/reported_revoked`，`verified:false`，不是平台已经核验的本人授权。新版本、撤销或删除会影响已排队请求，前端重读版本再选择。

```json
{
  "message": "合成通知，不含位置链接",
  "consent": true,
  "recipients": [{ "contact_id": "66666666-6666-4666-8666-666666666666", "expected_version": 1, "method": "email" }],
  "expires_in_seconds": 900
}
```

最多10个不重复联系人，method为email/phone，消息1–1000字，有效期60–3600秒。前端让用户确认本次内容、收件人与联系方式；不自动带位置、真实地址或额外联系人。摘要status为 `pending/simulated/partial/failed/cancelled`；`counts`与逐人结果应分别显示。offline由真实Worker处理为模拟终态，不能标记为真实短信／邮件发送成功。api渠道未配置必须如实失败，重试不自动恢复失效同意或旧版本联系人。详见 [联系人通知合同](docs/contact-alerts.md)。

## 15. 通知中心、运行简报与客服

| 方法与路径 | 主要参数／用途 |
| --- | --- |
| `GET /notifications` | `unread=true|false/limit/cursor`；本人通知 |
| `PATCH /notifications/{notificationId}/read` | 标记本人已读 |
| `POST /notifications/{notificationId}/retry` | 仅终止失败dead通知可重排，返回pending不等于已发送 |
| `GET /notification-preferences` | `geofence/battery/offline/location`偏好 |
| `PATCH /notification-preferences` | 上述布尔字段局部更新 |
| `POST /push-tokens` | `platform:android|ios/token`；受控真实推送集成时注册 |
| `DELETE /push-tokens/{tokenId}` | 删除本人推送材料 |
| `GET /households/{householdId}/operations?hours=24` | 运行摘要，hours为1–168 |
| `GET /pets/{petId}/telemetry-failures` | `status=dead|retry/limit/cursor`；失败或死信列表 |
| `GET /ingest/events/{eventId}` | 获授权事件处理状态 |
| `POST /ingest/events/{eventId}/retry` | 失败事件重排，正文reason，HTTP202，支持幂等 |
| `POST /support/tickets` | `device_id/category/description/diagnostics_consent`，支持幂等 |
| `GET /support/tickets` | 本人工单，`status/limit/cursor` |
| `GET /support/tickets/{ticketId}` | 本人详情与回复 |
| `DELETE /support/tickets/{ticketId}/diagnostics-consent` | 撤销诊断授权 |
| `GET /admin/support/tickets` | 客服身份才可读，支持status/limit/cursor |
| `GET /admin/support/tickets/{ticketId}` | 客服详情 |
| `PATCH /admin/support/tickets/{ticketId}` | `status:in_progress|resolved/reply`，支持幂等 |
| `GET /admin/devices/{deviceId}/diagnostics?ticket_id=` | 需要管理身份、有效工单及仍有效诊断授权 |

客服category为 `location/notification/binding/battery/wearing/other`。未绑定前只允许无device_id的binding求助，不能同意不存在设备的诊断。description1–4000字；客服回复／解决状态不是设备风险已解除。普通owner不自动有平台客服权限，前端按 `auth/me.support_staff` 显示入口，后端每次重验。通知偏好和系统推送权限、服务商投递、手机实际收到是不同状态。

## 16. 授权导出、注销、删除与保留

| 方法与路径 | 请求／约束 |
| --- | --- |
| `GET /auth/data-export` | 本人导出manifest，声明sections、权限与范围 |
| `GET /auth/data-export/{section}` | `household_id/snapshot_at/limit/cursor`；按manifest逐分区分页，快照和游标不串用 |
| `GET /auth/account-deletion` | 本人注销预览 |
| `DELETE /auth/account` | `password/confirmation:"DELETE"` |
| `GET /pets/{petId}/deletion-preview` | 共享宠物删除预览 |
| `DELETE /pets/{petId}` | owner确认，`password/confirmation:<petId>` |
| `GET /households/{householdId}/deletion-preview` | 家庭删除预览 |
| `DELETE /households/{householdId}` | owner确认，`password/confirmation:<householdId>` |
| `POST /households/{householdId}/owner` | `password/new_owner_user_id`，按当前成员状态转移 |
| `GET /households/{householdId}/retention` | owner读取家庭保留配置 |
| `PATCH /households/{householdId}/retention` | `password/enabled/telemetry_days/activity_days/safety_days` |
| `POST /households/{householdId}/retention/preview` | 仅预览实际范围，HTTP200 |
| `POST /households/{householdId}/retention/run` | owner显式执行，正文password，HTTP200 |
| `GET /admin/retention/inventory` | 设备管理员读取无家庭归属遥测保留策略 |
| `PATCH /admin/retention/inventory` | 设备管理员更新策略，正文password/enabled/telemetry_days |
| `POST /admin/retention/inventory/preview` | 管理员预览 |
| `POST /admin/retention/inventory/run` | 管理员password显式执行 |

保留天数1–3650，默认关闭；不能把进入页面或预览当成执行清理。注销不随意删除其他成员仍需使用的共享事实；删除宠物／家庭的范围以预览和回执为准。授权导出沿用当前用户权限与来源失效规则，不从普通API下载整库。前端复用 `MobileApi.exportAccount` 的分页、摘要和范围校验；系统分享仅表示打开分享入口，不等于已发给第三方。详见 [导出](docs/account-export.md)、[数据生命周期](docs/privacy-lifecycle.md)、[保留](docs/inventory-retention.md)。

## 17. 保留的硬件标准接口

以下是设备／供应商接入面，**不是给普通App嵌入长期密钥后直接调用的用户接口**。这些入口及 TypeScript 端口是后续硬件适配的边界，不因目前没有样机而视为无用代码删除。

| 方法与路径／类型 | 身份与当前边界 |
| --- | --- |
| `POST /ingest/events` | `x-device-token`，HTTP202，接收标准Envelope；event_id和(device_id,boot_id,seq)防重放／冲突 |
| `POST /integrations/vendor/events` | 仅api模式且已配Webhook；HMAC签名与原始正文／时间戳校验，HTTP202 |
| `GET /integrations/status` | 用户Bearer；读取mode、telemetry_endpoint、vendor_endpoint、vendor_configured、push_configured等 |
| `GET /device-ingress/{deviceId}/commands` | `x-device-token`；设备轮询待执行命令 |
| `POST /device-ingress/{deviceId}/commands/{commandId}/ack` | 设备token及 `status:applied|failed/applied_version/error?`；HTTP200，必须使用真实回执 |
| `GET /devices/{deviceId}/credential` | 授权设备维护元数据 |
| `POST /devices/{deviceId}/credential/rotate`、`POST /devices/{deviceId}/credential/revoke` | 受控设备维护，正文reason，不作为公开配置 |
| `POST /admin/devices/{deviceId}/credential/rotate`、`POST /admin/devices/{deviceId}/claim-code` | 设备管理员受控维护，正文reason |
| `HardwareCapabilities/BlePairingPort/TelemetryEnvelopeV1/GatewaySessionReference` | 见[硬件类型](mobile/src/hardware/contracts.ts)；类型定义不等于已实现BLE驱动或网关握手 |

标准事件示例（虚构ID与坐标，真实设备必须使用自己的凭据和真实采样）：

```json
{
  "schema_version": "1.0",
  "event_id": "synthetic-location-0001",
  "device_id": "55555555-5555-4555-8555-555555555555",
  "event_type": "location.reported",
  "device_ts": "2026-11-24T03:00:00Z",
  "seq": 1,
  "boot_id": "synthetic-boot-1",
  "firmware_version": "synthetic-only",
  "transport": "simulator",
  "payload": { "lat": 31.23, "lon": 121.47, "accuracy_m": 10, "source": "gnss", "battery_pct": 80 }
}
```

`event_type` 支持 `location.reported/state.reported/activity.reported`。`device_ts`是采样时间，`received_at`由后端赋值；seq是非负整数，boot_id区分重启。activity payload用 `start_at/end_at`及至少一项真实测量的 `steps/active_seconds/distance_m/sleep_seconds`；区间正数≤一天，活动加睡眠不能超过区间。不把未知指标补为零，不由App伪造设备心率或睡眠阶段。

供应商签名头为 `x-doogy-timestamp`（Unix秒，服务端允许5分钟偏差）和 `x-doogy-signature`（64位十六进制HMAC-SHA256）：`HMAC(secret, timestamp + "." + 原始请求体字节)`。重新序列化JSON后签名可能不同，不能签某对象后传另一串正文。offline供应商入口关闭；api缺密钥返回未配置。

BLE配对、UUID服务、MQTT主题、手机网关授权握手、供应商SDK、地图坐标转换和独立联网参数尚须实际硬件合同，不能在现有类型里编造。`GatewaySessionReference`只是未来短期授权引用，当前没有以device_id即可取得网关权限的业务入口。beep/recall、真实心率、睡眠分段和供应商推送按能力门控，不能显示为已执行。完整接入语义见 [供应商集成](docs/integrations.md)、[命令幂等](docs/command-idempotency.md)。

## 18. 来源失效、界面状态和跨端协作验收

1. 先检查服务根和运行模式，再注册／登录并读取身份、家庭、宠物和引导；成功进入业务页后才加载该范围的数据。
2. 先读版本／具体来源，再编辑；保存返回新ID／版本后选中该结果并刷新。失败保留草稿；冲突由用户明确重读，不能自动覆盖已有输入。
3. 课程／运动计划先展示版本、来源和适用范围。选用计划只形成目标草稿，返回已有目标页时保留其他未保存目标；确认后才提交。
4. 录音／导入 → 明确采集起点 → 上传成功 → 选中媒体 → 授权播放或显式创建解释 → GET任务终态 → 本人反馈 → GET复读。任何202和分享入口都不能提前当作执行／发送成功。
5. 创建问答时展示当前明确上下文及版本，选择本人会话后提交；切宠不把旧会话迁移到新宠物。
6. 删除媒体、撤回／更正照护、课程下架、遥测保留清理或撤权可能使旧解释／问答失效。`MEDIA_SOURCE_DELETED/CARE_SOURCE_CHANGED/CARE_SOURCE_WITHDRAWN/CONTENT_UNAVAILABLE/ACCESS_REVOKED`等错误或失效标记以实际返回为准；保留允许保留的人工原文，不展示已失效派生结果，不用retry复活证据。
7. 每次身份／服务器／角色／宠物／日期范围切换都隔离迟到响应。旧邀请回包、上传回包、保存回包、播放器授权、分页和反馈不能落到新范围。
8. UI验收同时检查成功、空态、未知、只读、无设备、未配置、失败、取消和恢复；记录哪些仅HTTP／组件测试，哪些实走原生，不把模拟fixture或原生SDK桩称为真机或硬件验收。

## 19. 最小联调步骤与交接材料

从项目根运行 `start-app-demo.bat`，启动前编译最新源码，显式创建独立SQLite/offline合成环境和API／Worker；不会把内容自动导入普通业务库。手机填写终端给出的可达服务根地址；模拟器专用 `10.0.2.2` 不是实体手机地址。检查连接后才填入服务端明确声明的合成主人／只读账号并登录。

每次重新运行该演示入口会创建新库。要保留同一次联调记录，用 `start.bat "data\app-demo-该次编号\demo.env"` 复用该环境；不要再加app-demo参数。普通业务环境继续使用自身配置和普通 `start.bat`，不清空、不切换用户数据库。详见 [演示步骤](docs/app-demo.md)。

前端首次联调建议顺序：注册→建宠→跳过项圈→首页；照护／Goal／Body保存复读；课程进度与计划草稿；媒体→解释→反馈；本人课程问答；只读角色限制；最后同库重启与会话恢复。硬件样机、外部模型、短信／邮件、地图和第三方身份验收单列，不用假成功占位。

协作需一起提供：`mobile/`源码及锁文件、后端源码及锁文件、数据库增量迁移、启动脚本、必要合成fixtures、配置模板、本文与模块合同。共享真实配置应通过双方约定的私密渠道，公开仓库不放实际.env、凭据、签名私钥、业务数据库、原始用户数据或构建缓存。API变更同步控制器Schema、前端调用、本文和受影响测试；数据库变更同步SQLite与PostgreSQL增量迁移。

## 20. 源码定位与文档核对范围

| 接口域 | 当前源码 |
| --- | --- |
| 路由注册、OpenAPI、错误结构 | [app.ts](src/app.ts)、[http.ts](src/http.ts) |
| 账号、家庭、宠物、头像、引导、找回 | [identity.ts](src/identity.ts)、[profile.ts](src/profile.ts)、[password-recovery.ts](src/password-recovery.ts) |
| 照护、汇总、Goal／Body、营养、观察 | [care.ts](src/care.ts)、[wellness.ts](src/wellness.ts)、[nutrition.ts](src/nutrition.ts)、[observations.ts](src/observations.ts)、[health-observations.ts](src/health-observations.ts) |
| 内容、媒体、解释、问答 | [content.ts](src/content.ts)、[media.ts](src/media.ts)、[media-validation.ts](src/media-validation.ts)、[behavior.ts](src/behavior.ts)、[assistant.ts](src/assistant.ts) |
| 设备、入站、命令、位置与安全 | [devices.ts](src/devices.ts)、[telemetry.ts](src/telemetry.ts)、[reporting.ts](src/reporting.ts)、[fences.ts](src/fences.ts)、[safety.ts](src/safety.ts)、[shares.ts](src/shares.ts)、[integrations.ts](src/integrations.ts) |
| 联系人、通知、运行与客服 | [contacts.ts](src/contacts.ts)、[contact-alerts.ts](src/contact-alerts.ts)、[notifications.ts](src/notifications.ts)、[configuration-history.ts](src/configuration-history.ts)、[operations.ts](src/operations.ts)、[support.ts](src/support.ts) |
| 导出、删除、保留、设备维护 | [account-export.ts](src/account-export.ts)、[privacy.ts](src/privacy.ts)、[retention.ts](src/retention.ts)、[inventory-retention.ts](src/inventory-retention.ts)、[device-credentials.ts](src/device-credentials.ts) |
| App页面与接口映射 | [迁移覆盖](mobile/docs/migration-coverage.md)、[屏幕源码](mobile/src/screens)、[统一API](mobile/src/lib/mobileApi.ts)、[硬件预留类型](mobile/src/hardware/contracts.ts) |

本文件完成的是源码／Schema／移动调用的静态合同核对，没有因为写文档重新执行全套业务或真实供应商验收。运行实例的OpenAPI和实际返回可帮助核对部署版本；若部署滞后于本文，应先确认前后端版本一致。当前真实硬件、模型和外发能力的未配置边界继续保留。
