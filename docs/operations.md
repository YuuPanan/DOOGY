# 家庭运行简报与遥测失败处理

本页对应 [Doggy_final.md](../Doggy_final.md) §17.2 的运行简报及 §17.4 的重放、死信处理要求。接口沿用现有账号、家庭角色、设备绑定和 Worker，SQLite/PostgreSQL 与 offline/api 共用业务逻辑。

Web 入口位于「设备与安全」→「运行与排障」。简报展示当前绑定与最近 24 小时数据，失败列表支持状态筛选和分页。具有写权限的成员可填写理由重新排队，并再次读取简报查看后台处理结果。[Web 操作步骤](workbench.md#家庭运行简报与失败处理)

## 接口与权限

统一前缀为 `/api/v1`，使用用户 Bearer 令牌：

| 接口 | 用途 |
| --- | --- |
| `GET /households/{id}/operations?hours=24` | 查看家庭设备状态和限定时间窗的处理摘要 |
| `GET /pets/{id}/telemetry-failures` | 分页查询当前绑定设备的失败消息元数据 |
| `POST /ingest/events/{id}/retry` | 在当前授权范围内将失败消息重新排队 |

读取遵循当前家庭访问权限，重新排队要求 owner/caregiver 写权限。viewer 只能读取；撤权、解绑或换绑后不能通过旧链接或旧幂等键重新操作原绑定的消息。简报生成期间绑定发生变化时返回 `409 BINDINGS_CHANGED`，重新读取即可。

运行简报和失败列表不返回原始 Envelope、消息 payload、设备密钥、登录令牌或精确坐标。可凭 `event_id` 关联现有 `GET /ingest/events/{id}` 状态接口，定位接收和处理阶段。

## 运行简报的口径

`hours` 默认为 24，可取 1–168 的整数。读取时生成当前设备状态和选定窗口内的处理摘要；当前位置年龄、设备在线状态与窗口内的消息统计需要分别理解。

| 响应部分 | 含义与范围 |
| --- | --- |
| `household_id/generated_at/mode/window` | 家庭、生成时间、业务模式和实际查询时间窗 |
| `devices`、`totals` | 当前绑定设备的状态及在线、离线、低电等数量 |
| `queue` | 当前绑定下所有未处理完成的 pending/retry/dead 消息；不受 `hours` 裁剪，含最早接收时间及年龄 |
| `telemetry` | 时间窗内收到的消息状态、设备时钟超前数与各阶段延迟样本 |
| `location_quality` | 时间窗内接收且已经投影至位置表的点数、合格点数与合格比例；没有点时比例为 null |
| `notifications` | `scope=current_user`，按通知 `created_at` 统计窗口内本人的通知状态，并按当前设备/宠物及绑定开始时间截断 |
| `open_safety_events` | 当前设备/宠物且发生时间不早于绑定开始的开放安全事件，按类型计数，不受 `hours` 裁剪 |

家庭成员可以共同排查设备处理状态，但每位成员的推送偏好、令牌和通知状态不同，因此运行简报不汇总其他成员的个人通知。

遥测、位置、失败列表和重试按事件保存的 `binding_id` 精确隔离。现有安全事件和通知表没有该字段，相关计数使用当前 `device_id+pet_id` 及绑定开始时间下界；同一宠物在同一毫秒解绑重绑时可能混入旧事件/通知，不能将这两项计数描述成同样严格的绑定身份隔离。

`location_quality.basis=projected_locations_received_in_window`。其中 `received_points` 是已经生成位置记录的点数，尚在 pending/retry/dead 且未完成位置投影的原始上报不进入该分母；`good_points` 要求 GNSS、精度不超过 100 米且质量标记为空。

合格比例只描述这批已投影样本。没有明确的期望采样计划与完整接收记录时，不能将该比例称为设备采样覆盖率，也不能用缺失数据替代为零活动。当前 `devices[].location` 则表示当前绑定的最新位置状态，返回时间、年龄、新鲜度与质量标记，不附坐标。

各阶段延迟使用服务端已保存的时间：

| 指标 | 来源 |
| --- | --- |
| 接收延迟 | `received_at - device_ts` |
| 排队延迟 | `processing_started_at - received_at` |
| 接收到投影结束 | `processed_at - received_at` |

没有对应时间的消息不能成为该指标的有效延迟样本。设备时钟超前需要单独解释；`processed_at` 在投影事务中写入，不能把它当成单独测得的 WAL 落盘或提交确认耗时。

每个延迟指标返回 `samples` 和 `p95_ms`；缺失或负向时差不进入该指标样本，没有有效样本时 P95 为 null。队列最早未完成消息的年龄从首次接收时间计算，可能包含等待重试或人工处理的时间。

offline 模式的通知仍为 `simulated`。API 模式未配置推送适配服务时，通知保持 `pending`；站内处理或模拟状态不能证明手机收到提醒。

## 查看失败消息并重新排队

先从家庭简报确认受影响的设备，再按宠物查询失败列表。列表支持 `status=dead|retry`、`limit` 和 `cursor`，未指定 status 时同时查询两种失败状态。分页默认 20 条，最大 100 条，按 `received_at,event_id` 倒序，响应为 `items/next_cursor`。

每条记录只包含事件 ID、设备 ID、类型、设备/接收时间、当前处理状态、次数、下次尝试时间、受限错误码及处理时间。游标锚点保留原事件接收时间，即使该消息已重新排队或处理完成，也可继续翻页；不属于当前绑定或其他宠物的游标返回 `INVALID_CURSOR`。

重新排队请求示例：

```http
POST /api/v1/ingest/events/{event_id}/retry
Authorization: Bearer <access_token>
Content-Type: application/json
Idempotency-Key: operator-retry-20261117-001

{"reason":"已修复处理故障，重新验证原始消息"}
```

只允许当前有效绑定中处于 `dead` 或 `retry` 的原消息重新排队；`pending` 和 `processed` 不进入新的人工重试周期。消息身份和原始内容保持不变，重试通过原 Worker 投影链路处理。

`reason` 去除前后空白后为 1–500 字符。成功返回 HTTP `202`，响应包含 `event_id`、`status=pending` 和 `requeued_at`。重新排队会重置当前处理次数和处理时间、设置新的待处理时间，并记录操作者、原因与原失败状态/次数的审计。

原 `device_ts`、`received_at`、身份及消息内容不变。因此重新处理后的 `processed_at - received_at` 仍包含从首次接收起的等待，也包括人工处置耗时，不能将它当成新一轮 Worker 的净排队或执行时间。前一轮失败次数保留在审计中。

同一用户和作用域下，相同 `Idempotency-Key` 与相同请求重放首次结果；同键不同原因返回冲突。重放仍检查当前权限和绑定，不恢复已撤销的访问权。首次重新排队的确认响应可能在 Worker 处理完成后再次重放；需要最新状态时调用事件状态接口。

返回重新排队成功只代表请求已受理。随后使用事件状态接口检查 Worker 是否处理完成；原消息仍违反业务约束时可能再次失败。重试不修改 Envelope 来绕过重复身份、时间、绑定或活动重叠规则。

## 运行与后续边界

使用原有 `start.bat` 或独立 PostgreSQL 配置启动 API/Worker，再通过 Swagger 调用上述接口。该增量没有新增外部服务；offline 可在未拿到供应商 API 时继续完成软件联调。

运行简报是按需读取的 JSON API。真实设备采样、手机推送送达、现场误报漏报、长期生产可用性，以及自动值守或外部告警平台仍需相应链路和验收证据。
