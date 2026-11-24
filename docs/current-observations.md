# 今日同进度活动观察

`GET /api/v1/pets/{id}/observations/current` 回答“今天截至现在的上报活动，与最近七天走过相同时长时相比有什么变化”。它在请求时读取已入库活动，不需要等自然日结束，便于在今日看板显示步数、活动分钟数、比较依据和暂时无法比较的原因。

原 `GET /api/v1/pets/{id}/observations?date=&timezone=` 继续用于完整自然日观察；不传日期时仍选择最近完整自然日，原规则和缓存保持。

## 完整自然日观察的证据与反馈

Web「活动趋势」允许查看已结束日期的观察证据。页面显示参与比较的日期与覆盖率、数据来源、规则版本和聚合版本。主人或照护者可填写说明并选择「有用」或「不准确」。只读成员可查看观察证据；数据不足或变化未达门槛时，该指标没有可反馈的观察。

提交使用 `POST /api/v1/pets/{id}/feedback`。在原 `feature_date`、`assessment`、`comment` 字段上添加 `observation: { id, evidence_id }`，分别填写完整自然日观察的结果 ID 与该指标观察的证据 ID。服务端校验宠物、日期、证据及家庭写权限，保存所引用的观察、指标、规则版本、时区和生成时点。同一幂等键可重试同一次关联反馈。迟到样本重新生成观察后，仍可引用保留中的原证据。反馈随提交者本人的导出分区提供；现有通用反馈请求仍可沿用原格式。

今日同进度结果按请求重新计算，反馈引用面向已保存的完整自然日观察。操作见 [观察活动](workbench.md#5-观察活动)。

## 请求

```powershell
$baseUrl = 'http://127.0.0.1:3000/api/v1'
$petId = '宠物 ID'
$token = '登录取得的访问令牌'
Invoke-RestMethod -Method Get `
  -Uri "$baseUrl/pets/$petId/observations/current?timezone=Asia%2FShanghai" `
  -Headers @{ Authorization = "Bearer $token" }
```

沿用当前家庭成员的宠物读取权限。只有可选 `timezone` 参数；省略时依次采用宠物、家庭、`Asia/Shanghai` 时区。无效 IANA 时区返回 400；`date`、`as_of` 或其他额外参数也返回 400。历史日期继续使用原完整自然日观察接口。

`as_of` 由服务器时钟确定，客户端不能指定。`local_date` 是该时点在所选时区的今天，`generated_at` 与 `as_of` 相同。

## 时间窗口与比较方法

目标区间为当地今天零点到 `as_of`，采用 `[period_start, period_end)`。`elapsed_seconds` 是这个区间的真实经过秒数。最近七个当地自然日各从零点开始，截取同样的经过时长作为基线。

例如，上海今天 10:00 请求时，比较今天 00:00–10:00 与前七天各自 00:00–10:00 的上报总量。不会拿今天十小时的累计值与历史全天总量比较，也不会推算今日全天结果。

夏令时按真实经过时长对齐，并不保证历史结束时刻具有相同钟表读数。例如回拨日从零点到当地中午可能已经经过 13 小时，历史普通日就取零点后的 13 小时。若某个历史自然日比目标经过时长更短，其 `period_end` 截止于该日实际结束，标为 `eligible=false`、`exclusion_reason=shorter_calendar_day`，不参与基线计算。自然日边界使用真实时区规则，不能固定按 24 小时换算。

恰在当地零点请求时，`elapsed_seconds=0`，返回 `status=period_not_started`；没有活动值时仍为 `null`，不会把尚未开始的时段当成零活动。

## 指标、覆盖率与估算

只比较 `steps` 和 `active_minutes`。每个指标独立判断是否可以比较：

1. 目标指标有上报值，且其覆盖时长达到目标经过时长的 50%。
2. 前七天中，至少三个可用日期的同指标有值，且各自覆盖率达到 50%。
3. 取这些合格日期上报总量的中位数，计算 `(目标值 - 中位数) / 中位数 × 100%`。

`steps` 使用 `metric_coverage_seconds.steps`；`active_minutes` 使用 `metric_coverage_seconds.active_seconds`。覆盖率分母为本次截取区间的真实时长。覆盖时长按区间并集计算，不能把其他指标的覆盖率借给缺失指标。上报总量不按覆盖率补齐；例如覆盖 60% 的 600 步不会换算为 1,000 步。

活动样本跨越零点或请求截止时刻时，沿用按区间重叠时长分摊总量的计算方式，并标记 `estimated=true`。这假设该样本内活动均匀分布，细粒度活动仍以设备提供的区间为限。某指标没有上报值则为 `null`；上报值确实为 0 时保留 0。

`comparisons` 为两个指标分别提供 `observed`、`coverage_fraction`、`baseline_days`、`status` 和 `reason`。可比较时附 `baseline_median`、`delta_percent` 与 `evidence_id`。常见状态如下：

| 结果 | 含义与展示方式 |
| --- | --- |
| 指标 `status=ready` | 当前指标满足覆盖与基线门槛，可以展示中位数和变化百分比 |
| `reason=missing_metric` | 目标区间没有该指标的上报值，展示“暂无该指标数据” |
| `reason=insufficient_coverage` | 目标指标覆盖不足 50%，展示实际覆盖率并等待后续数据 |
| `reason=insufficient_baseline` | 合格历史日期不足三个，展示已有天数 |
| `reason=baseline_zero` | 合格基线中位数为 0，`delta_percent=null`，不显示除零得出的百分比 |
| 顶层 `status=ready` | 至少一个指标可比较；另一个指标仍可能不可用 |
| 顶层 `status=insufficient_data` | 当前没有可比较指标，保留各指标具体原因 |
| 顶层 `status=period_not_started` | 当前自然日刚开始，尚无经过时长 |

满足比较条件也可能没有 `observations` 文案。只有变化百分比的绝对值至少 30% 时，才生成对应指标的上报活动变化描述；中位数为 0 时不生成百分比变化文案。

## 看板读取与依据

建议看板同时展示 `as_of`、目标指标、该指标覆盖率、`baseline_days` 和同进度基线中位数。可以将业务提示写成“截至 10:00，已上报步数比近期同进度中位数减少 35%”；变化描述只说明记录差异，佩戴情况、环境和日常安排仍可能影响结果。

返回内容包括：

| 字段 | 用途 |
| --- | --- |
| `comparison_basis=equal_elapsed_since_local_midnight` | 明确本次采用自当地零点起相同经过时长的比较口径 |
| `rule_version=activity-current-v1` | 标识当前观察规则 |
| `target` | 今日零点至 `as_of` 的区间摘要，含 `period_start/end`、`sample_count`、指标值、逐指标覆盖时长、`estimated`、`source_revision`、`generated_at`，聚合版本为 `interval-v1` |
| `baseline_window` | 最近七天的起止当地日期 |
| `baseline` | 七个历史区间摘要及各自 `eligible`、`exclusion_reason`；入选日期仍须逐指标满足覆盖门槛 |
| `comparisons` | 各指标的可比状态、数值、中位数与变化百分比 |
| `evidence` | 指标结果对应的目标和实际入选历史区间、来源版本与覆盖依据 |
| `observations` | 达到 30% 变化门槛时的描述，以及对应 `evidence_ids` |
| `minimum_coverage_fraction`、`minimum_baseline_days` | 固定为 `0.5` 和 `3`，便于展示本次门槛 |
| `missing_context`、`model_output` | 保留缺少的上下文说明；当前 `model_output=null`，不调用模型生成解释 |

例如，目标有 650 步且覆盖率合格，合格历史同进度步数为 900、1,000、1,100，则中位数为 1,000，变化为 -35%。若活动分钟数只有两个合格历史日期，该指标仍显示 `insufficient_baseline`，顶层可因为步数可比而返回 `ready`。

该接口每次请求重新计算，结果 `id` 可变化；它不读写完整日汇总或旧观察缓存。即使没有新样本，经过时长和覆盖率也会随请求时点变化。迟到、补传、更正或删除的活动在入库后会反映到后续请求；仍在遥测队列中等待 Worker 处理的数据尚未进入本次结果。这里的“当前”指截至服务器时点可读取的已入库记录。

本次沿用 API 与 Worker，无新依赖、环境变量、CLI、常驻服务、数据库迁移或业务表；SQLite 019/PostgreSQL 008、40 表保持。启动仍使用 [start.bat](../start.bat)，先编译最新源码再启动。实际测试与启动结果见 [本地验收记录](acceptance.md)。
