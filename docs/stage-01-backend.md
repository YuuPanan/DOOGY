# stage_01 第一批后端联调

本页为账号、引导和每日输入的接口合同。公共前缀 `/api/v1`，用户接口携带 Bearer；运行时路由与字段入口为根地址 `/docs` 和 `/openapi.json`。整体调用顺序见 [fb.md](../fb.md)。

## 1. 账号、头像与引导

注册可选 `display_name` 和 `consent`。旧客户端不传新字段仍可注册，未填写显示名/未接受的版本返回 `null`，不伪造默认条款。

```json
{
  "email": "your-account@example.invalid",
  "password": "replace-with-your-password",
  "display_name": "宠物主人",
  "consent": {
    "terms_version": "实际展示的条款版本",
    "privacy_version": "实际展示的隐私版本",
    "source": "registration-form"
  }
}
```

接受时间由服务端生成。`GET /auth/me` 和登录结果返回 `display_name/profile_version/consent`。`PATCH /auth/me` 接收 `expected_version` 以及显示名或新接受记录；显示名允许显式 `null` 清除。条款接受记录逐版保存，可在本人导出中读取。

`PUT /pets/{id}/avatar` 使用 multipart：`file` 与 `expected_version`。支持 JPEG/PNG/WebP，最大 5MiB，同时检查 MIME 与文件头。首次提交版本为 0，成功返回唯一 ID、摘要、大小、新版本及 `content_path`。`GET /pets/{id}/avatar/content?version=N` 校验当前家庭权限和版本；被替换版本返回 404。替换仅保留当前正文，通过删除日志阻止旧备份恢复旧头像。

`GET /auth/onboarding` 返回本人保存的选择、版本、下一步、真实绑定与设备接收状态；蓝牙状态始终由客户端提供，后端标为 `unknown`。`PATCH /auth/onboarding` 示例：

```json
{ "pet_id": "已获准读取的宠物UUID", "collar_choice": "skipped", "completed": true, "expected_version": 0 }
```

`collar_choice` 支持 `skipped/completed/null`，`completed` 可撤销。标为连接完成必须存在当前绑定。更换宠物重置旧选择；删除宠物或撤销访问后不再返回旧宠物信息。绑定、设备已接收上报和手机蓝牙分别展示。

## 2. 显式目标与运动计划

`GET /pets/{id}/goals?date=2026-11-24&timezone=Asia/Shanghai` 返回当日有效目标和步数/活动进度。无有效目标返回 `goals:null`；缺少活动时 `actual/percent:null`。不设置设计稿中的默认目标。

`PUT /pets/{id}/goals` 保存一个完整目标快照，而非局部合并：

```json
{
  "effective_date": "2026-11-24",
  "expected_version": 0,
  "targets": { "active_minutes": 45, "steps": 5000, "intake_kcal": null },
  "source": "user_provided",
  "plan": {
    "name": "主人选用的计划",
    "content_version": "user-plan-v1",
    "walk_minutes": 25, "play_minutes": 10, "training_minutes": 10
  }
}
```

目标值为显式正数或 `null`；省略的目标也保存为 `null`。计划可省略/清除，不自动改变目标或假设完成运动。客户端提交前展示计划总时长与活动目标各自的值。名称和内容版本由提交者提供，当前未提供审核内容目录。

版本按 `(pet_id,effective_date)` 计数：新生效日用 0，修改同一天用其最新版本。GET 的 `effective_date_version` 是查询日期对应的编辑版本；`goals.version` 是返回的有效历史目标版本，两者在回落到较早目标时不同。读取选择不晚于查询日的最近生效日期及其最新修订；全部历史修订保留供授权导出。没有默认生效点，必须提交 `effective_date`。

## 3. 四项身体观察

用户已确认先保存原始文字，暂不评分。`GET/PUT /pets/{id}/body-check-ins?date=2026-11-24&timezone=Asia/Shanghai` 按宠物、当地日期和时区保存版本。

```json
{
  "expected_version": 0,
  "observed_at": "2026-11-24T04:00:00Z",
  "values": { "appetite": "比平时吃得少", "energy": null, "movement": "正常散步", "stool": null },
  "notes": "主人的原始描述",
  "toileting_record_id": null
}
```

四项允许 `null` 或 1–200 字原文；省略项保存为未知。PUT 是完整快照，修订时需要再次提交要保留的字段。观察时间必须在所选当地日期内且不晚于当前时间；省略时使用服务端现在，补历史日需明确传时间。可选排便引用必须是本宠物当天有效的 `toileting` 排便/两者记录；只保存关联，不新增照护事实。引用记录后来撤回时读取返回 `toileting_record_status:"withdrawn"`。保存新版本不覆盖旧行，不推断疾病或状态分。

## 4. 体重和喂食

沿用 `POST /care-records`、`PATCH /care-records/{id}`、修订历史与撤回。体重旧 `value:{"weight_kg":12}` 继续可用；新原值合同如下：

```json
{ "pet_id": "宠物UUID", "type": "weight", "value": { "weight": 26.4554714622, "unit": "lb" }, "recorded_at": "2026-11-24T04:00:00Z" }
```

按 `1 lb = 0.45359237 kg` 保存 `weight_kg`，同时保留 `weight/unit`。若调用者同时给出的 kg 与换算值冲突则拒绝。编辑和撤回重新选择最近有效体重。`PATCH /pets/{id}` 提交非空 `weight_kg` 也生成照护记录；存在有效称重历史时直接清空档案体重会返回 409，需要按原流程撤回记录。创建档案时的旧手填基线保持兼容，不伪造其称重历史。

旧喂食 JSON 保持兼容，不从任意旧字段推测能量。新版明确携带 `schema_version:"feeding-v1"`：

```json
{
  "pet_id": "宠物UUID", "type": "feeding", "recorded_at": "2026-11-24T04:00:00Z",
  "value": {
    "schema_version": "feeding-v1", "food_name": "标签上的食物名称", "category": "dry",
    "amount": 100, "unit": "g", "meal_type": "meal",
    "label_energy": { "kcal": 360, "per_amount": 100, "unit": "g", "source": "用户抄录包装标签" }
  }
}
```

单位支持 `g/kg/ml/portion`；标签密度必须同量纲（g/kg 可互换），不假设 ml 与 g 或 portion 的换算。`meal_type` 为 `meal/snack`，每条事实计一次。缺少标签时能量为未知。计算版本 `label-energy-v1` 使用 `amount / per_amount * kcal`，保留标签来源、单位及估算标记，不用宠物重量生成饮食处方。

`GET /pets/{id}/nutrition/daily?date=&timezone=` 返回有效喂食明细、`known_kcal/target_kcal/goal_version`、未知数量和完整性。无已知能量返回 `known_kcal:null`；明确零能量返回 0。`completeness_scope:"recorded_feeding_only"` 表示只检查已记录行是否都有标签，不能说明全天实际摄入完整。读取实时重算，编辑和撤回后立即更新。

## 5. 时段与趋势

`GET /pets/{id}/activity/intervals?from=2026-11-23T00:00:00Z&to=2026-11-24T00:00:00Z&bucket=hour&timezone=UTC&limit=24`：时间范围含 from、不含 to，最多 31×24 小时，支持 `hour/day` 与游标。小时桶从请求起点按真实一小时推进，末桶截短；自然日桶按指定时区的午夜切分。返回实际 UTC 起止、逐指标覆盖秒数、样本数、来源和区间比例分摊的估算标记。跨 DST 的自然日可为 23/25 小时。分页继续传原 from/to/bucket/timezone，尤其使用默认范围后应传响应中的固定边界。

`GET /pets/{id}/trends?metric=steps&from=2026-11-17&to=2026-11-24&timezone=Asia/Shanghai`：from/to 是当地日期，含 from、不含 to，最多31天，按日分桶并分页。支持 `steps/active_minutes/sleep_minutes/distance_m/weight_kg`。

活动/睡眠逐指标返回实际值、覆盖、样本数和历史目标；缺失为 `null/missing`。体重桶返回当天最近有效称重及全部有效记录，无称重不向前填充，手工记录覆盖秒数为 `null`。不生成“稳定”等健康结论。

比较使用等长前一个当地日期窗口（7天请求对应此前7天），规则 `equal-calendar-window-v1`。活动比较要求两个自然日已结束、真实时长一致、同一指标来源一致，且各自覆盖不少于50%；未满足返回 `incomplete_day/unequal_day_duration/different_sources/insufficient_coverage`。当前值/基线缺失或基线为零也返回原因和空百分比。50%沿用现有活动观察的工程覆盖门槛，仅用于可比性；未来产品规则变更需升级版本。迟到样本与照护更正直接影响下次读取。

## 6. 权限、迁移与运行

家庭 owner/caregiver 写，共享 viewer 读，跨家庭拒绝。本人资料/引导按本人保存。新写接口支持 `Idempotency-Key`；同键重试返回原回执，不同内容返回409。带 `expected_version` 的写入在版本变化时返回409；重读后再提交新业务意图。

SQLite `024-profile-onboarding.sql/025-wellness.sql` 与 PostgreSQL `013-profile-onboarding.sql/014-wellness.sql` 增加六张业务表。新导出分区为 `user_profiles/user_consents/user_onboarding/pet_avatars/pet_goals/body_check_ins`，头像分区每页至多一份。所有目标/身体观察修订均导出。注销删除个人资料、接受记录和引导；共享记录保留事实并清除退出者作者标识。宠物/家庭显式删除清除所有关联版本及正文，恢复继续重放删除日志。遥测保留策略不自动删除新增手工事实；保留预览列出其保留计数。

新功能无新增依赖、环境变量、外部调用或常驻服务，`.env.example` 与启动脚本沿用原合同。`start.bat` 继续先构建、预检迁移，再启动 API/Worker。现有 `.env`、数据模式及用户数据库未被本次开发覆盖或切换。使用自己的库前按原流程备份并核对迁移；本地测试与真实设备、推送或生产验收分开记录。

内容与健康历史见 [第二批合同](stage-02-backend.md)，行为、媒体和本人问答见 [第三批合同](stage-03-backend.md) 与 [媒体上传](media-upload.md)。身体观察保持原文不评分；真实SSO、消息投递和硬件动作按能力门控。
