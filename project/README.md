# DOOGY 前后端协作源码

## 当前阶段：0.1.7/code8 Windows Android 原生验收

Windows本机Android模拟器已实际通过已执行的核心链路（配置合成API、注册/建宠、Today、照护保存返回重读、force-stop后会话恢复）、独立AVD的code7→code8覆盖升级、媒体技术样本，以及切号切宠、只读/撤权和实际断网恢复路径。人耳可听仍待确认，不代表全部65页原生或完整组合通过；详见 [Android模拟器原生验收记录](docs/Android模拟器原生验收记录.md)。仅默认ADB认证资料获C盘.android例外，其余受审项目路径保持E、后端仅127.0.0.1。复用既有0.1.7/code8双ABI包，本轮不重打包，无新增业务源码、依赖、接口或迁移；以下65页、26组Web与319项保留前阶段验证层级。

## 前阶段基线（2026-11-28）：Pawch 全流程前端

当前移动源码为 **0.1.7 / Android code8**，已覆盖七组 **51主界面＋14补充状态**，不止前三页。布局、导航和静态素材取本机Figma交接包，独立RN组件实现动态表单/图表/状态，继续使用既有API、鉴权、权限和数据逻辑。逐页路由、跳转、素材及状态见 [65画板验收表](docs/pawch-65-acceptance.md)，实施、实际流程、截图和原生边界见 [全流程验收记录](docs/Pawch全流程前端验收记录.md)。新增精确锁定的expo-image用于原SVG曾要求fresh构建，已由现有code8完成；本轮复用，不再次重打，不新增权限或业务API/迁移。

仍用 `E:\Doogy_ma\Start-PawchDesktop.cmd`，fresh编译、类型检查和Web导出成功才启动仅127.0.0.1的合成API/Worker。此前Web基线阶段因认证路径条件未启动ADB/模拟器；授权后的当前原生核心/升级结果见顶部记录，Web证据不转记为Android。无真机、iOS、云构建或发布。以下0.1.6三页与历史数字保留原范围。

## 历史：0.1.6/code7 Pawch 三页电脑预览

本轮范围为电脑端 Android 模拟/预览，不做或等待手机验收。源码版本为 **0.1.6 / Android code7**；Today → Pet → Care 使用真实 React Native 页面、既有 API 和权限，实现档案编辑/取消/保存、照护保存返回和焦点重读，未知资料不补零。实际已运行的是 **React Native Web 的桌面 headless-shell 浏览器预览**，不是 Android 原生模拟器。

本机使用 `E:\Doogy_ma\Start-PawchDesktop.cmd`：先 fresh 编译后端、移动类型检查并导出 Web，再启动既有 API/Worker；只监听 `127.0.0.1`，地址以终端输出为准，按 Enter 关闭本次服务。可用 `-Resume` 加本项目已验证的 `demo.env` 绝对路径恢复同一次合成演示。该入口及缓存/产物均在 E 盘；下方通用手机/LAN 操作和阶段二手机安装条款保留为历史或其他条件下的说明，本轮不执行。

本轮定向 UI 回归 64/64、后端预览守卫 10/10；真实浏览器通过登录、建宠、照护返回重读、断网恢复不重复提交、只读写入 403、撤权移除旧宠物 6 个场景，页面错误 0、外部 origin 0。另一个真实浏览器草稿场景先复现同宠物外部更新覆盖未提交草稿，再验证修复：`profile-draft-93835fd5.json`失败 → `profile-draft-1564dfc7.json`通过，合计6+1场景；焦点权限重读保留。原生未运行；全 E 路径的 ADB 认证目录仍受 Windows `CSIDL_PROFILE` 限制，E SDK 缺 emulator/images，已知镜像为 API34/x86_64。双 ABI QA 包的最终静态结果见下方本机验收记录，不作为原生通过。旧 187 项为阶段二历史基线。

启动、证据与边界见 [本机 Pawch 电脑验收记录](../docs/Pawch电脑验收记录.md) 和 [协作流程](docs/process.md#2026-11-28-pawch-电脑预览)。证据目录为 `E:\Doogy_ma\evidence\pawch-desktop-20261128`，最终浏览器报告为 `desktop-ui-flow-ecf2fdc9.json`。

Android 优先的 React Native + TypeScript + Expo App，以及 TypeScript/NestJS API 和独立 Worker。保留现有软件流程、SQLite/PostgreSQL 双库迁移和硬件标准接入接口；iOS 与真实硬件、模型、地图、消息渠道按后续接入条件推进。

本目录是独立源码副本，不包含原业务数据库、真实环境配置、历史 APK、构建缓存、依赖目录或本机验收日志。`offline` 表示不调用外部业务服务，手机仍需要连接后端。

## 从这里开始

| 文档 | 用途 |
| --- | --- |
| [项目交接文档](项目交接文档.md) | 接收顺序、从零启动、代码定位、联调打包、验证和接收清单 |
| [项目需求与开发任务](项目需求与开发任务.md) | 已确定需求、功能实现状态、后续任务与完成标准 |
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

APK构建交付同时生成 `source-manifest.json`，记录运行源码/资源摘要、可获得的Git来源、构建脚本摘要和公开API地址输入；`receipt.json`关联清单摘要及fresh生成的版本/code。运行输入在复制或构建期间改变会停止交付；三份制品写齐后整体移入新交付目录，失败暂存保留在本次快照内。独立验签与终端运行仍需另验。

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
npm.cmd run check
npm.cmd test
# 根目录：有独立 PostgreSQL 测试环境时执行
cd ..
npm.cmd run test:postgres
```

PostgreSQL 条件跳过不能记为通过；SDK 桩不能代替真机、权限、音视频和硬件验收。每次交付的实际执行范围见 [验证清单](docs/acceptance.md) 和 [协作流程](docs/process.md)。

GitHub Actions 在 push / pull_request 时分别执行后端默认回归、移动类型与回归、PostgreSQL 三个 job。移动 job 安装根目录及 `mobile/` 的锁定依赖；Ubuntu 上原有的 5 项 Windows 专用测试按条件跳过，不构建 APK。配置必需检查需另在仓库分支保护中设置。

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
