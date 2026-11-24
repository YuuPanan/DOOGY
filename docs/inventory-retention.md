# 无家庭归属遥测保留与设备状态隔离

本功能补齐 [隐私生命周期说明](privacy-lifecycle.md) 中未绑定设备遥测的保留范围。SQLite/PostgreSQL 与 offline/API 使用同一规则，不依赖供应商接口。SQLite `017-inventory-retention.sql` / PostgreSQL `006-inventory-retention.sql` 增加全局 `inventory_retention` 策略及设备 signal 来源，当前全库为61张业务表。

## 范围与权限

库存策略按**消息接收时没有家庭归属**判断，即 `device_events.pet_id IS NULL`，不以设备当前是否仍在库存判断。设备后来被认领，先前无归属消息仍按库存窗口到期；有宠物归属的消息继续按家庭策略处理，不转入库存策略。

HTTP 策略读取、预览、修改和执行都要求当前登录用户属于 `DEVICE_ADMIN_USER_IDS` 且账号仍活动。家庭 owner、caregiver 或客服身份不会自动取得此权限。先登录取得用户 UUID，再由服务端配置设备管理员名单；现有 `.env` 不会被程序覆盖。修改及立即执行还需当前密码确认。

接口统一前缀 `/api/v1`：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /admin/retention/inventory` | 读取全局库存策略，未配置时返回默认关闭状态 |
| `PATCH /admin/retention/inventory` | 保存 enabled、telemetry_days 和当前密码 |
| `POST /admin/retention/inventory/preview` | 零写入预览已保存策略的匹配范围 |
| `POST /admin/retention/inventory/run` | 提交当前密码，立即执行已启用策略 |

默认 `enabled=false`、`telemetry_days=7`，可调整为 1–3650 的整数天。7 天是当前开发默认参数，不是统一法定期限。建议先保存关闭策略，再预览，最后确认启用：

```json
{
  "password": "当前密码",
  "enabled": false,
  "telemetry_days": 7
}
```

关闭策略可以预览，执行及 Worker 仍跳过关闭状态；未配置时没有待执行策略。启用时再次提交已核对的窗口。PATCH 省略 telemetry_days 使用默认 7 天，不表示沿用旧值。

## 清理与状态隔离

原始消息按 `received_at` 计算到期上界，清除窗口外无归属消息的 payload/envelope。到期 pending/retry 终止为 dead，不再由 Worker 处理已清内容；event ID、device/boot/seq 等去重元数据保留，旧包再次提交仍返回 `409 EVENT_DATA_EXPIRED`。共享删除已生成的空原文 `DATA_DELETED` 墓碑不重复改写。

设备绑定转换清理上一阶段的上报缓存。Worker 在写入状态前核对接收时捕获的绑定与当前绑定；旧库存或已解绑消息不能在设备重绑后更新新家庭的 signal、电量、固件和上报时间。新家庭当前上报保持自己的来源，库存原文到期不连带清除这些新状态。

`device_state.signal_event_id` 记录 signal 最后一次实际更新的消息来源；后续未携带 signal 的心跳不能延长旧 signal 的保存时间。来源为到期无归属消息时，清理相应 signal 副本；当前家庭新来源不被旧库存消息连带清除。此字段是内部保留依据，不出现在设备状态及业务导出中。

旧版本已有 signal 可能没有来源 ID，无法可靠反推真实保存时间。库存策略明确启用后，只对**当前没有活跃绑定**的此类未知来源 signal 清空，不等待其 reported_at 变旧；预览会计入匹配数。已绑定家庭的未知来源 signal 不由库存策略清除，避免把来源不明当成库存归属。

Worker 复用现有周期，每分钟检查库存策略，自动执行后至少冷却一小时；策略更新重置冷却时间。手动执行可跳过冷却，但不能绕过关闭状态。清理及运行时间更新在同一事务中提交，失败回滚，不新增后台服务或 npm 依赖。

返回的 counts 包含 `telemetry_payloads`（原文清空或到期积压终止）与 `device_signal`（signal 副本清空）的匹配行数，不能相加当作独立业务记录数量。配置和清理审计只记录策略、范围及计数，不记录密码、坐标、signal 或原始 payload。

## 本地维护

```powershell
# 默认 SQLite；PostgreSQL 使用独立配置，保留原 .env。
./start.bat .env privacy inventory-preview
./start.bat .env.postgres privacy inventory-preview
./start.bat .env.postgres privacy inventory-run
```

`start.bat` 先同步依赖和构建，再执行维护并退出，不启动 API/Worker。CLI 直接使用所选数据库访问权限，不使用用户 Bearer；API 仍要求设备管理员及密码。预览不删除业务数据，但正常打开数据库会应用待执行迁移。

恢复旧备份后，先隔离使用并核对家庭和库存保留策略，再按 [数据库操作说明](database-operations.md) 重放最新删除日志、核对设备凭证，最后开放 API/Worker。库存策略和 signal 来源随当前备份/导入保留；旧 37/39 表来源按已知版本兼容升级，新增库存策略默认不启用。

## 适用边界

库存原文清理不物理删除去重身份，不改写历史归档或召回已下载文件。真实供应商删除、介质擦除及生产容量另行验收。
