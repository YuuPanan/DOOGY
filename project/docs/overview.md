# 宠物概览与当前待办

`GET /api/v1/pets/{id}/overview` 聚合宠物档案、所选日期的活动和照护、当前设备与位置、围栏有效状态，以及当前家庭风险和本人未读通知。SQLite/PostgreSQL、offline/API 使用相同合同，不需要额外配置或外部服务。

## 调用与时间范围

使用当前家庭成员的 Bearer 登录令牌；owner、caregiver 和 viewer 均可读取。其他家庭或已经退出的成员返回 404，未登录返回 401。

```http
GET /api/v1/pets/{pet_id}/overview?date=2026-11-17&timezone=Asia%2FShanghai
Authorization: Bearer {access_token}
```

`date` 可选，默认宠物有效时区中的今天；`timezone` 可覆盖本次活动和照护查询使用的时区，默认按宠物覆盖、家庭设置、Asia/Shanghai 的顺序解析。活动仍以 `activity.period_start/period_end` 为当地自然日边界，照护仅包含该日期内仍有效的记录，已撤回记录不出现。

`current_state_at` 标记本次读取当前状态的服务端时间。设备、位置、围栏、策略与走失、风险待确认和本人未读始终反映读取时的当前状态；选择历史 `date` 不会把这些字段变成历史快照。原有 `pet/activity/device/location/care_records/safety_events` 字段继续保留。

`location_wait` 在当前有设备绑定且没有可展示的定位时返回 `{ status, elapsed_seconds }`。等待时长取当前绑定至服务端读取时间。小于 600 秒为 `waiting`，达到 600 秒为 `delayed`。解绑或有定位记录时为 `null`。已有位置精度不足或过期时继续按原位置质量字段显示。等待状态只用于提示，查询不会生成位置或事件。

## 围栏与设备状态

`geofences.items` 沿用围栏列表的展示合同。界面判断当前状态应使用 `state.effective_status`：停用、最后判断已过期或最后一次判断为 uncertain 时为 unknown。`state.status` 保留内部已确认状态，不应单独据此显示当前位置安全。没有定位或有效围栏依据时，也不推断宠物仍在安全区。

设备继续通过现有 `device.reporting` 返回期望策略、已应用版本、执行来源、命令状态、走失会话与时间阈值。pending 表示等待回执，applied 才表示所记录的执行回执；offline 的 simulator 回执不表示真实硬件执行。会话到期可显示已停用，概览读取不代替 Worker 的到期维护，也不触发下行命令。没有当前绑定设备时 `device=null`。

## 当前待办

`attention` 的总数覆盖当前宠物的全部相关记录，不受所选日期或原 `safety_events` 最近 10 条限制。两个明细数组各最多 5 条，分别按事件发生时间或通知创建时间、ID 倒序排列：

| 字段 | 口径 |
| --- | --- |
| `open_event_count` | 当前仍为 open 的安全事件总数，已人工确认但风险未关闭的事件仍计入 |
| `unacknowledged_open_event_count` | 当前 open 且尚无家庭人工确认的事件总数 |
| `unacknowledged_open_events` | 上述待确认事件的前 5 条，含 `id/type/status/occurred_at` |
| `unread_notification_count` | 当前宠物相关、属于当前登录用户且 `read_at=null` 的通知总数 |
| `unread_notifications` | 上述本人未读通知的前 5 条，含 `id/event_id/status/created_at/type/occurred_at` |

人工确认是家庭共享的处置事实；其他成员完成首次确认后，事件不再出现在待确认数组，风险仍可能保持 open。未读是当前用户的独立状态，不包含其他成员的通知；已关闭事件的通知仍可能未读，pending、sent、dead 等发送状态也不会自动改变已读状态。

## 数据缺口

`data_gaps` 分开说明所选活动日期与当前状态，返回稳定代码供客户端解释。缺口只反映已记录数据，不把缺失当作零活动或不佩戴：

| 数组与代码 | 含义 |
| --- | --- |
| `activity_period: activity_missing` | 所选活动日期没有活动区间 |
| `activity_period: activity_partial` | 所选活动日期的整体区间覆盖不足 |
| `current_state: device_unbound` | 当前没有绑定设备 |
| `current_state: device_status_unknown` | 已绑定设备尚无可判定在线状态 |
| `current_state: device_offline` | 设备超过现有动态在线阈值 |
| `current_state: location_missing` | 当前没有可展示的最新定位 |
| `current_state: location_unusable` | 最新位置不可用于当前跟踪；即使存在 `last_usable_location` 回退，仍提示最新位置缺口 |
| `current_state: geofence_unconfigured` | 没有启用的围栏，全部停用也属于此情况 |
| `current_state: geofence_state_unknown` | 至少一个启用围栏的当前有效状态为 unknown |
| `current_state: reporting_unconfigured` | 有当前绑定设备，但尚未配置上报策略 |

整体活动覆盖与各指标覆盖不同。`activity_period` 只概括原 `activity.data_status`；某个指标未上报时仍查看原 `metric_sample_counts`、`metric_coverage_seconds` 和指标的 null 值，不能仅凭缺口数组为空判定全部指标完整。

## 读取与后续操作

查看概览不自动确认风险或标记通知已读，也不为策略到期排入新命令或写入操作者审计；原活动汇总缓存仍可按来源版本写入。风险确认与事件关闭是独立状态；通知未读也不表示推送尚未送达，服务商接受推送不能证明手机已经收到。

需要继续查看时使用原有详情和分页接口；写操作仍按各接口检查当前权限：

| 操作 | 接口 |
| --- | --- |
| 围栏列表及规则 | `GET /pets/{id}/geofences` |
| 安全事件列表与详情 | `GET /pets/{id}/safety-events`、`GET /safety-events/{id}` |
| 人工确认风险 | `POST /safety-events/{id}/ack`，owner/caregiver 可操作 |
| 本人未读通知 | `GET /notifications?unread=true` |
| 标记本人通知已读 | `PATCH /notifications/{id}/read` |
| 策略及走失状态 | `GET /devices/{id}/reporting-policy` |
