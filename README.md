# DOOGY 前后端协作源码

Android 优先的 React Native + TypeScript + Expo App，以及 TypeScript/NestJS API 和独立 Worker。保留现有软件流程、SQLite/PostgreSQL 双库迁移和硬件标准接入接口；iOS 与真实硬件、模型、地图、消息渠道按后续接入条件推进。

本目录是独立源码副本，不包含原业务数据库、真实环境配置、历史 APK、构建缓存、依赖目录或本机验收日志。`offline` 表示不调用外部业务服务，手机仍需要连接后端。

## 从这里开始

| 文档 | 用途 |
| --- | --- |
| [fb.md](fb.md) | 前后端接口、请求和响应、权限、状态与联调规则 |
| [OpenAPI JSON](docs/openapi.json) | 随源码提供的接口定义；运行时以 `/openapi.json` 为准 |
| [Doggy_final.md](Doggy_final.md) | 当前功能需求、App 范围和外部能力边界 |
| [51 画板操作表](docs/app-closed-loop.md) | 页面入口、提交/取消、保存返回和重读条件 |
| [需求状态](docs/requirements-status.md) | 已有软件能力及后续工作 |
| [移动工程](mobile/README.md) | App 源码结构、开发与构建 |
| [协作约定](AGENTS.md) / [协作流程](docs/process.md) | 修改范围、启动与数据保护规则 |

## 后端启动

需要 Node.js 24 和 npm。Windows PowerShell 首次在本目录执行：

```powershell
npm.cmd ci
if (!(Test-Path ".env")) { Copy-Item ".env.example" ".env" }
./start.bat
```

`start.bat` 始终先构建最新源码，再启动 API 和 Worker；失败不会继续运行旧编译结果。地址以控制台输出为准，终端按 Enter 或 Ctrl+C 关闭本次服务。普通启动沿用自己的配置和数据库。

启动后可访问后端根地址的 `/docs`（Swagger）、`/openapi.json`（OpenAPI JSON）和 `/app/`（兼容 Web 体验台）；业务接口统一使用 `/api/v1`。App 配置后端根地址时不附加 `/api/v1`。

## 独立合成演示

```powershell
./start-app-demo.bat
```

该入口新建独立 SQLite/offline 环境，包含合成主人、只读账号、宠物、课程、运动计划和媒体等资料，不向普通业务库自动导入。手机填写控制台打印的可达根地址，检查连接后填入演示账号并显式登录。详细步骤和复用同一次演示数据的方法见 [App 演示](docs/app-demo.md)。

## App 开发

先安装根目录依赖，再进入移动工程：

```powershell
cd mobile
npm.cmd ci
if (!(Test-Path ".env")) { Copy-Item ".env.example" ".env" }
npm.cmd run android
```

配置 `mobile/.env` 的区域 API 根地址，使设备能够访问后端。首次原生开发需安装 JDK 17、Android SDK 37 和适合本机的设备/模拟器；已有开发构建后可用 `npm.cmd start` 启动 Metro。开发包、内嵌 JS 的 APK 和正式签名发布分别处理，见 [移动说明](mobile/README.md)、[工具链](mobile/docs/android-toolchain.md) 和 [APK 构建](mobile/docs/android-apk.md)。

## 保留的硬件接口

| 接口（前缀 `/api/v1`） | 用途 |
| --- | --- |
| `POST /ingest/events` | 设备令牌认证的标准事件接收，持久化后由 Worker 处理 |
| `POST /integrations/vendor/events` | api 模式的供应商 HMAC Webhook 接收 |
| `GET /device-ingress/:id/commands` | 设备轮询下行命令 |
| `POST /device-ingress/:id/commands/:commandId/ack` | 设备提交版本化执行回执 |

设备库存、绑定/解绑、凭据维护、上报策略、走失会话及状态读取保持。App 不保存长期设备密钥；手机 BLE、设备独立联网、供应商云/MQTT 接入以及声响/召回等能力只有真实合同和样机验证后才启用。[硬件接入说明](docs/integrations.md)。

## 数据、媒体与测试

- 默认 SQLite；PostgreSQL/PostGIS 使用独立环境文件。当前 61 张业务表，最新 SQLite 034 / PostgreSQL 023 增量迁移；升级保留已有数据，导入只读源库、使用空目标。[双库说明](docs/postgres.md)
- 媒体校验需要服务端 FFmpeg/ffprobe，放入 `.tools/media/` 或通过 `MEDIA_TOOLS_DIRECTORY` 配置；源码包不附可执行文件，缺工具时上传能力明确关闭。[媒体合同](docs/media-upload.md)
- 身体观察保存原文，不生成未确认评分；offline 解释/问答和投递明确标注演示，不能作为真实模型或第三方送达验收。

```powershell
# 根目录：构建和默认离线回归
npm.cmd test
# mobile 目录：类型与移动端回归（需要根目录依赖）
cd mobile
npm.cmd test
# 根目录：有独立 PostgreSQL 测试环境时执行
cd ..
npm.cmd run test:postgres
```

PostgreSQL 条件跳过不能记为通过；SDK 桩不能代替真机、权限、音视频和硬件验收。每次交付的实际执行范围见 [验证清单](docs/acceptance.md) 和 [协作流程](docs/process.md)。

## 目录

| 目录 | 内容 |
| --- | --- |
| `mobile/` | App 与移动回归 |
| `src/` | API、业务服务、Worker |
| `db/` | SQLite/PostgreSQL 增量迁移 |
| `scripts/` | 启动、演示、导入、设备模拟和数据维护 |
| `test/` | 服务、HTTP、数据库和启动回归 |
| `fixtures/` | 软件演示与离线标准事件 |
| `web/` | 现有兼容 Web 客户端 |
| `docs/` | 模块合同、开发与验收说明 |

共享配置使用环境模板和独立联调账号；实际 `.env`、业务库、备份和签名私钥不纳入 Git。
