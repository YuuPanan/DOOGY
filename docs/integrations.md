# 离线与 API 两种数据模式

`DATA_MODE=offline` 为默认模式：设备模拟器通过 `POST /api/v1/ingest/events` 上报标准事件，携带每台设备独立的 `x-device-token`。数据写入同一持久化队列并由 Worker 处理；演示与真实接入使用相同的定位、围栏、活动和通知业务逻辑。

`DATA_MODE=api` 启用供应商 Webhook 入口；每设备令牌入口依然可用，适合供应商允许直连的网关。API 模式不会为你申请设备、购买 SIM 或自动连接云端。

配置示例：

```dotenv
DATA_MODE=api
VENDOR_WEBHOOK_SECRET=replace-with-at-least-24-random-characters
PUSH_WEBHOOK_URL=https://your-authorized-push-adapter.example/notifications
PUSH_WEBHOOK_TOKEN=your-adapter-token
```

供应商标准入口为 `POST /api/v1/integrations/vendor/events`，请求体直接使用设备事件 Envelope，字段定义参见主 README 与 OpenAPI。**无需向供应商传递单设备长期令牌**；入口使用独立的服务端 HMAC 密钥认证。供应商必须在发送前把自有协议映射为此标准事件，并采用已预置的 `device_id`。`received_at` 由 DOOGY 服务端生成。

每次请求携带：

| Header | 内容 |
| --- | --- |
| `Content-Type` | `application/json` |
| `x-doogy-timestamp` | 当前 Unix 时间戳，单位为秒 |
| `x-doogy-signature` | `HMAC-SHA256(secret, timestamp + "." + 原始请求体字节)` 的 64 位十六进制字符串 |

时间允许相差 5 分钟。签名后不可重新格式化 JSON；空格、换行和属性顺序都会改变签名。签名验证后仍会检查设备是否预置、凭证是否有效、Envelope 字段以及事件幂等性。重试须保持同一业务 `event_id`；跨越 5 分钟窗口时重新生成时间戳与签名。

使用现成的 `event.json` 签名并发送（PowerShell，已设置 `VENDOR_WEBHOOK_SECRET` 环境变量）：

```powershell
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
$signature = node -e "const fs=require('node:fs'),c=require('node:crypto'); process.stdout.write(c.createHmac('sha256',process.env.VENDOR_WEBHOOK_SECRET).update(process.argv[1]+'.').update(fs.readFileSync('event.json')).digest('hex'))" $timestamp
curl.exe -X POST http://127.0.0.1:3000/api/v1/integrations/vendor/events `
  -H "Content-Type: application/json" `
  -H "x-doogy-timestamp: $timestamp" `
  -H "x-doogy-signature: $signature" `
  --data-binary '@event.json'
```

`202` 表示已接收至队列，业务处理结果由后续查询确认。相同事件重试不会重复生成定位或告警。`offline` 模式访问供应商入口返回 `404 INTEGRATION_DISABLED`；`api` 模式缺少密钥返回 `503 INTEGRATION_NOT_CONFIGURED`，不会悄悄接受未认证数据。

登录后调用 `GET /api/v1/integrations/status` 可查看模式、入口与供应商/推送是否配置，不返回密钥。配置状态不等同于已通过真实供应商验收。

## 设备令牌轮换与吊销

设备所有者可通过凭证维护接口轮换或吊销设备长期令牌。轮换立即使旧 `x-device-token` 失效，新令牌仅在本次响应提供；直连遥测、设备命令轮询与回执都使用当前有效令牌。设备管理员使用独立 `DEVICE_ADMIN_USER_IDS` 白名单，默认没有设备维护权限，与客服白名单分开。

供应商 HMAC 密钥和单设备令牌是不同凭证。HMAC 入口仍不要求供应商携带单设备令牌，但会检查该设备的吊销状态；有效签名不能绕过吊销。单设备令牌轮换不自动修改供应商 HMAC 密钥。

吊销阻止新的设备访问，已经持久化接收的消息继续经过原绑定快照、时间和质量检查，不会因本地吊销而追溯清空队列或撤回已发命令。维护权限、一次性响应和离线步骤见 [device-credentials.md](device-credentials.md)。真实设备新密钥安全下发、证书烧录、供应商平台侧吊销和 KMS 仍需后续接入与验证。

推送 Webhook 是你方实现的推送适配器合同，不能直接填 FCM/APNs 地址并视为接入完成。接收器需要使用自己的授权凭据调用移动推送服务，成功响应才确认发送。离线模拟通知标记为 `simulated`，不代表手机收到消息。

当前没有实现任何特定硬件供应商的私有字段映射、MQTT 证书烧录或 APNs/FCM SDK，也没有验证真实硬件、供应商响应和移动端送达。
