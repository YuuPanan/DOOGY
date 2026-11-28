# 纯净源码交付与协作流程

## 当前阶段：0.1.7/code8 已执行原生路径验收

[Android模拟器原生验收记录](Android模拟器原生验收记录.md)为当前接续入口。已在独立E盘AVD实际通过已执行的核心链路（App配置合成API、注册/建宠、Today、照护保存返回重读、force-stop会话恢复）、另一独立AVD的code7→code8覆盖升级、媒体技术样本，以及切号切宠、只读/撤权和实际断网恢复路径。人耳可听仍待确认，不代表全部65页原生或完整组合通过。复用既有code7/code8，本轮不重打包、不新增业务源码/依赖/接口/迁移，不重跑319或26组Web充作原生结果；仅默认ADB认证资料获C盘.android例外，其余受审项目路径保持E，后端只127.0.0.1。

授权前审计基线（保留）：审计脚本只读取组件元数据/哈希、CIM、现有listener和公开源码，并在E创建唯一输出目录，不提供自动启动/解锁。进程Home、AVD或日志指E不等于ADB默认认证目录指E；不得借用认证路径未知的既有5037server。当时更正旧Linux-only adb.<port>泛化，阻塞依据为已审Windows默认key/known-hosts路径。授权后使用独立5039，原5037保持；完整Android边界验收后才进入iOS。无真机、系统或防火墙修改、云构建、上传或发布。

本机稳定入口 `E:\Doogy_ma\scripts\Audit-AndroidNative017.ps1` 支持 `-EvidenceBase <E目录>`，始终不授权/启动原生工具；15项审计复用自检通过，环境条件变化时输出requires_manual_review，不沿用旧缺失结论。新入口没有业务环境变量、依赖或后台服务，既有start/环境模板无需变更。授权前准备的28项原生模板与65页覆盖行当时全部NOT_RUN；当前实际核心/升级和剩余边界以顶部原生记录为准，模板不自动记为已执行。

## 前阶段基线（2026-11-28）：Pawch 全流程前端

本轮将Figma七组51主界面＋14补充状态落实到 `mobile/src/pawch`，独立RN交互复用现有API/状态/权限；[65画板验收表](pawch-65-acceptance.md)逐页记录路由、跳转、素材、状态与原因，[全流程验收记录](Pawch全流程前端验收记录.md)区分自动测试、实际RN Web、APK静态与原生未验。源码0.1.7/code8，新增精确锁定expo-image58.0.18用于原SVG，不新增权限、配置变量、后台服务、业务接口或迁移。

启动入口无需新增步骤：已有 `Start-PawchDesktop.cmd`先fresh根编译、mobile check、Web export，失败即停；APK入口在独立E快照fresh prebuild/Gradle并校验源码指纹。原 `.env`、环境模板、数据模式、API/Worker管理和业务启动保持；SVG依赖expo-image已入mobile锁文件，新增模块曾要求fresh构建，已由现有code8完成，本轮复用、不再次重打。运行变量仍由已有本机入口进程设置，所有项目缓存/产物保持E。

该前阶段仅Windows本地、后端只127.0.0.1；当时未启动ADB/模拟器，完整认证目录E重定向未证实。授权后原生实际结果见顶部记录，未把Web/静态结果改记为Android通过。无真机、iOS、云构建、外发代码/凭据、提交或发布。以下三页记录是0.1.6历史。

## 历史：0.1.6/code7 Pawch 电脑预览

最新任务为电脑端 Android 模拟/预览，不做或等待手机。沿用 [Pawch 对齐需求](项目需求文档-Pawch对齐版.md) 和既有 API/权限合同，本轮源码为 0.1.6/code7，UI 范围仅 Today → Pet → Care：真实 RN 档案概览与编辑/取消/保存、照护保存返回、焦点重读、空态和错误重试；没有新增评分、相机、BLE、外部模型或外发能力，没有新增业务 API、数据库结构或迁移。历史阶段二手机条款及187项基线保留原执行范围，不作为本轮验收或等待条件。

| 实际执行 | 本轮结果与证明范围 |
| --- | --- |
| 受影响 UI 定向回归 | 64/64，0失败/跳过；`affected-ui-final2.log`、`ui-regression-final2.json`，没有重记为全量移动回归 |
| 后端 Web 预览守卫 | 10/10，0失败/跳过；`preview-green.log`，验证显式隔离条件与导出目录限制 |
| 实际桌面浏览器 | RN Web + headless-shell；最终 `desktop-ui-flow-ecf2fdc9.json` passed=true，登录、建宠、照护返回重读、断网恢复不重复提交、只读写入403、撤权移除旧宠物6场景通过；页面错误0、外部origin0 |
| 真实浏览器草稿红绿 | `profile-draft-93835fd5.json`先失败，`profile-draft-1564dfc7.json`修复后通过；同宠物外部更新不再覆盖未提交档案草稿，焦点身份/权限重读继续保留；与核心场景合计6+1，仍不是Android原生 |
| Android 原生 | 未启动ADB/模拟器，未安装、运行或验收原生权限/媒体/前后台；浏览器结果不能替代Android原生 |
| 0.1.6/code7 双ABI QA候选 | 制品、来源清单、ABI/验签等最终静态结果见 [本机电脑验收记录](../../docs/Pawch电脑验收记录.md)，静态核对不代表原生运行通过 |

本机新入口为 `E:\Doogy_ma\Start-PawchDesktop.cmd`，脚本先使用E环境，fresh编译根后端、执行mobile check、导出RN Web，再启动既有API/Worker；任一步失败即退出，不运行旧导出。仅监听`127.0.0.1`，浏览器地址以控制台实际输出为准，终端按Enter关闭本次服务。`-Resume`只接受本项目独立合成演示目录中已验证的`demo.env`，核对其原SQLite库和白名单配置后恢复，不覆盖业务`.env`或导入旧业务数据。本轮不运行通用LAN入口，不开放USB网络或防火墙。

入口自动设置进程变量`DOOGY_MOBILE_WEB_PREVIEW_DIRECTORY`，只指向本次E盘artifacts中的Web导出。后端在打开应用前要求`DATA_MODE=offline`、`DB_DRIVER=sqlite`、`DOOGY_DEMO=1`、`HOST=127.0.0.1`同时成立；导出目录解析真实路径后必须位于本机`E:\Doogy_ma\artifacts`下且包含`index.html`。不满足即停止，不为普通业务库或外部业务模式启用预览。

原生暂缓有具体本机条件：当前Windows ADB默认认证home由`CSIDL_PROFILE`定位，没有已证实受支持的完整E盘覆盖；`ADB_VENDOR_KEYS`不能替代默认用户key。E SDK没有emulator/images，已识别镜像为API34/x86_64，不能把已有ARM64包默认视作该镜像可运行；WHPX实际可用性也未执行原生探针证明。没有修改C盘、系统或认证配置，不以手机解决本轮阻塞；iOS、云构建、推送、发布未进行。

本轮证据集中在`E:\Doogy_ma\evidence\pawch-desktop-20261128`；人工重跑入口与QA包最终静态结果见 [本机 Pawch 电脑验收记录](../../docs/Pawch电脑验收记录.md)。原60项回归与`desktop-ui-flow-ed7600b2.json`及旧失败报告按原名保留历史，不覆盖；最终核心浏览器结果引用`desktop-ui-flow-ecf2fdc9.json`，草稿场景保留上述独立红绿报告。

本源码副本用于前后端协同开发，保留完整软件流程及后续硬件接入合同。原开发目录与原数据独立保留；此副本不携带实际环境文件、业务数据库、历史 APK、缓存或本机验证归档。

## 当前范围

- App：React Native + TypeScript + Expo，Android 优先、iOS 后续；中国大陆与海外地址显式选择，不自动复制账号或数据。
- 后端：NestJS API 与独立 Worker，业务前缀 `/api/v1`，Swagger `/docs`，OpenAPI `/openapi.json`。
- 账号、家庭、宠物、引导、目标/身体观察、照护/营养、活动/健康、课程/计划、媒体、行为解释、本人问答、设备/安全、联系人与数据生命周期保持。
- 保留 61 张业务表及双驱动增量迁移；最新 SQLite 034、PostgreSQL 023。无新结构时不制造空迁移。
- 硬件标准事件、供应商 HMAC、设备令牌、命令轮询和回执保留；真实 BLE、供应商云/MQTT、设备动作与独立联网须按实际协议联调。
- 身体观察仍为可空原文，不评分；offline 固定演示与真实模型、地图、渠道和硬件能力分别呈现。

## 协作顺序

新接手人员先按 [项目交接文档](../项目交接文档.md) 核对环境与同库重读，再从 [需求与任务](../项目需求与开发任务.md) 选择有明确完成标准的一项。本次交接仅更新文档，既有业务代码、环境文件、数据库及安装包未改；2026-11-25 的测试数字仍是原基线，不作为本次重新执行结果。

1. 先核对 [主需求](../Doggy_final.md)、[接口文档](../fb.md)、[51 画板操作表](app-closed-loop.md) 和 [需求状态](requirements-status.md)。
2. 变更前明确输入、权限、成功/失败、取消、重试以及保存后重读条件，先查现有实现和调用方。
3. 沿用 `ApiClient` / `MobileApi`，保留会话刷新、幂等、当前宠物/身份范围和迟到回包隔离。
4. 一次处理可验证的小范围变更；删除函数前检查 API/CLI/Worker、动态调用、测试和硬件预留合同。
5. 接口或业务规则变化同步更新 `fb.md`、对应模块文档、需求状态及实际验证记录。

## 启动约定

`start.bat` 是 Windows 后端启动入口，`scripts/start.ts` 管理 API 与 Worker，启动前始终构建最新源码。构建失败不得使用旧输出；任一服务异常退出时停止本次启动的其他服务，只停止本次创建的进程。

新增或变更依赖、环境变量、构建步骤、入口或后台服务时，同步维护启动脚本、环境模板、README 和本文件；没有变化的步骤不重写。`start-app-demo.bat` 只为合成联调创建独立数据库；复用已有演示需用该次 `demo.env` 正常启动，不能再次新建演示冒充持久性复读。

## 数据保护与接口边界

- 保留已有 `.env`，不覆盖密钥，不擅自切换数据模式或清空数据库。联调默认 offline，无外部业务调用。
- 数据库变更提供 SQLite 与 PostgreSQL 增量迁移；不改写已应用迁移。数据导入只读源库、使用空目标。测试只清理自己创建且名称核对的随机数据库。
- Bearer 用户会话与长期设备凭据分开；设备所有权不授予家庭位置读取权限，权限在读取、写入、任务处理和幂等重放时重新核对。
- 媒体与导出使用授权读取；源删除、更正或撤权必须使派生解释/问答失效，不用旧缓存复活资料。
- 明确区分已受理、处理中、执行完成和真实外部接收；模拟结果不能显示成硬件执行、模型分析或已送达。

## 验证与交付记录

默认离线回归、移动回归及受影响的 PostgreSQL 实库用例按 [验证清单](acceptance.md) 执行。原生 SDK 桩、HTTP、数据库、原生终端和真实外部集成分别记录；未执行的范围写明，不把编译或本地启动成功描述为生产或硬件验收。

每次交付补充以下事实：提交标识、实际运行命令与结果、条件跳过、功能和启动检查、终端范围、数据库与配置保护、已知限制、远端仓库与提交核对。此源码包不引用原机器的历史日志作为本次通过证明。

## 本次纯净版验证

当前源码的独立安装、编译、回归、Android JS导出、接口覆盖与隔离PG核对见[纯净源码验证记录](clean-release.md)。仓库不携带原本机日志；接口联调先看[fb.md](../fb.md)及[静态OpenAPI](openapi.json)，运行实例以服务根/docs和/openapi.json核对部署版本。

## 2026-11-26 项目交接整理

新增根目录交接文档及需求任务文档，登记11项既有决定、16组功能需求和11项建议后续任务；主需求更新为2.4，修正双库、媒体上传、内容流程和演示清单文件名的陈旧说明。新文档的运行命令、源码入口与能力边界经源码核对和独立复核；44份Markdown的527处本地文件链接无缺失、代码围栏闭合，新增文档中的npm脚本均存在。9个改动文件均为Markdown，静态OpenAPI仍为129路径/158操作且字节未变；业务源码、迁移、锁文件和配置模板均未变。本次未重跑业务回归、重打APK或执行原生终端及外部服务验收，沿用历史基线时明确其日期和范围。

## 2026-11-28 T01媒体恢复修复、T02候选包与T03移动CI

按交接文档在独立源码目录 `DOOGY_clean` 接续；初始提交 `bc3fcd90f6624c42a058668b6477e59786488c4e`，工作区干净，新建分支 `codex/handoff-mobile-validation`。本轮未使用原历史目录作为协作工作树。

本组件使用Expo Video 58，源替换正常时沿用播放器，`replaceAsync` 失败会回退重建实例。原 `MediaPreview.stop` 依赖播放器对象，重建会触发授权范围effect的清理，从而清空SDK正恢复的来源。本轮用ref引用当前播放器并保持stop稳定；身份/媒体/宠物/API切换、失焦、后台及卸载仍使请求失效并清除来源。新增回归先在旧实现取得5过/1失败，修复后6/6；它使用真实安装版 `useEvent`，原生播放器仍为明确测试桩。

`.github/workflows/ci.yml` 新增独立 `mobile` job，使用Node24、两份锁文件的npm缓存，依次根 `npm ci`、mobile `npm ci`、`npm run check`、`npm test`；与后端默认及PG结果分开显示。YAML已解析并断言触发器、缓存与步骤顺序，独立代码复核及 `git diff --check` 通过。Ubuntu原有5项Windows专用测试仍条件跳过；未修改其条件。未推送或执行远端Actions、未改分支保护，不把本地通过称为远端CI已通过。

| 实际检查 | 本轮结果及范围 |
| --- | --- |
| 根 `npm.cmd test` | 427项定义，395通过、32条件跳过、0失败；含独立App演示及API/Worker启动、异常退出和自有进程停止回归 |
| 定向 `node --test dist/test/media-upload-e2e.test.js` | 通过进程级 `MEDIA_TOOLS_DIRECTORY` 使用本机历史目录已有的FFmpeg/ffprobe，7/7通过、0跳过；补验默认回归中缺工具跳过的6项真实解码/上传用例，不修改环境文件 |
| mobile `npm.cmd run check` | 退出0 |
| mobile `npm.cmd test` | 136/136通过，0失败/跳过，包含2项新增媒体回归及Windows启动入口测试；SDK桩与原生验收分开 |
| 新建演示的HTTP/Worker/同库重启 | 实际上传1秒合成WAV并经FFmpeg校验，独立Worker完成offline演示解释，保存本人反馈；Enter停止自有API/Worker后，用原demo.env启动同一SQLite库，媒体/解释/反馈GET逐项一致、授权原字节SHA一致；两次管理器及4个服务进程均已退出 |

本地日志保存于忽略目录 `data/handoff-20261128/`。默认32项跳过为26项PG条件用例和6项缺媒体工具用例；后者已按上表定向补验，PG仍未执行。本轮没有后端、HTTP合同、数据库结构、依赖、环境变量或启动流程变化，`start.bat`、`scripts/start.ts`、两套迁移、锁文件与环境模板保留原样。测试仅使用自身隔离数据，未改用户环境文件或业务库，未调用外部业务服务。

同库补验回执为本地 `data/handoff-20261128/demo-restart-verification.json`；验证脚本及日志保留在同目录，使用新建独立演示库、服务端文件和HTTP客户端，不经过手机界面。当前ADB无连接设备；ARM64终端权限/录音59秒/系统选择器/可听输出/前后台/完整51画板、同库终端重读及真实外部集成仍待验，以下构建和静态核对不能代替T01或完整T02验收。

### 本轮ARM64候选包

在本PowerShell进程设置已安装JDK17、Android SDK37及Gradle缓存后，于mobile执行 `npm.cmd run apk:android -- E:\AndroidDev\b`。脚本新建独立快照 `dgy-QY9rJf`，check、fresh prebuild、Gradle均退出0；Gradle耗时9分35秒、611项全部执行。版本仍为0.1.3/code4、包名 `com.doogy.mobile.preview`，没有递增发布版本或尝试安装升级。

| 项目 | 本轮结果 |
| --- | --- |
| 新制品 | `E:\AndroidDev\b\artifacts\dgy-QY9rJf\doogy-preview-arm64.apk`，27,468,069字节 |
| APK SHA-256 | `1e82a5a5d268c8523f2a46f60a5b3dcd78d9298e018f5d7d91124de529443464` |
| 独立签名/对齐 | Build Tools37的apksigner verify退出0，v2签名有效、Android Debug测试证书；zipalign检查退出0 |
| ABI/内嵌JS | 仅arm64-v8a、19个原生库；内嵌 `assets/index.android.bundle` 为2,045,880字节，未做无Metro启动实测 |
| Manifest | aapt2核对版本/包名通过；保留前台录音权限，无相机、定位及后台麦克风服务权限 |
| 源码来源 | 38个非node_modules输入（含src/assets/配置/锁文件）构建前、构建后、独立快照逐文件SHA一致；另记录实际build-android.cjs摘要。依赖沿用锁定版本 |

原始 `receipt.json` 保留构建时的 `independent_signature_verification=not_performed`，不改写历史时点；独立检查另存同制品目录的 `verification/verification.json`、`source-verification.json`、apksigner/aapt2/zipalign日志及本轮构建日志。制品与原始本地日志不纳入源码仓库；本表给出本轮可核对摘要。未进行设备安装/升级、无Metro启动或真机验收，preview仍需可达后端并显式填写根地址，offline也需要后端网络连接。

## 2026-11-28 第二轮：媒体删除确认与PG恢复验收

基线 `c4709fdeb333af28d5c97a71a71a67c4862a08c7`，工作分支 `codex/pg-recovery-and-media-confirmation`。本轮沿用已确定的T01/T09范围。

媒体删除原先等待原生Alert后直接提交，旧页面卸载或切换媒体后仍可能执行删除。本轮仅为该删除意图记录媒体ID和确认世代；API、焦点、媒体分区、所选媒体或有效来源改变均使确认失效，确认返回后先检查页面存活及世代，再提交DELETE。正常确认与取消保留。新增9项在旧实现1过/8失败，修复后9/9；learning-screens整文件16/16。独立代码复核未发现必须修复项，原生确认和导航仍为模拟，不宣称真机时序已验。

PG专用runner补入遗漏的 `health-stage` 与 `app-demo`。递归核对直接和间接使用PG fixture及测试连接变量的测试文件，未发现其他漏项。托管PG备份测试在旧归档恢复后，补验源库新发生的照护撤回：最新日志重放后默认列表排除记录、撤回时间一致、操作者NULL/固定恢复理由、既有修订保持、单次系统审计不含原文理由，第二次重放不重复；随后保留宠物删除重放及托管轮转。没有修改备份业务逻辑或表结构。

测试使用随机Compose项目 `doogy-qa-9fa2c897a427`、loopback独立端口和新项目卷；进程显式设置 `COMPOSE_DISABLE_ENV_FILE=1`、合成POSTGRES配置、`TEST_DATABASE_URL`、`PG_TOOLS=docker`、`DATA_MODE=offline`，不读取已有环境文件。构建后直接运行 `node dist/scripts/test-postgres.js`，备份工具的Compose端点核对及旧归档原生dump/restore使用同一项目。Docker Engine为本轮启动，既有ChatBI容器随Engine自动恢复，本轮不停止或修改这些容器/卷。

| 实际命令/检查 | 结果与范围 |
| --- | --- |
| `npm.cmd run build` 后 `node dist/scripts/test-postgres.js` | 完整专用runner 175/175通过，0失败/跳过，224.86秒；使用PostgreSQL17.5/PostGIS3.5，含原生备份恢复、12种旧表集恢复升级、失败目标清理、最新删除/撤回重放、并发与HTTP；其中明确的SQLite隔离检查保留原驱动，不将175项统称纯PG |
| mobile `npm.cmd run check` | 退出0 |
| 根已构建后，mobile `tsc -p tsconfig.test.json`、`node --test test/*.test.cjs` | 145/145通过，0失败/跳过；含9项新增媒体确认回归及原有Windows启动入口用例 |
| 根 `npm.cmd test` | 显式设置本机可用媒体工具；427项定义，401通过、26项PG条件跳过、0失败，41.05秒。PG条件用例已在独立实库runner实际执行，两种运行分别记数 |
| `node dist/scripts/postgres-performance.js --quick --report <新文件>` | 既有quick配置，4个合成家庭、120历史位置、读并发1/4、独立Worker1/3；每阶段40个唯一事件及精确重试，轨迹/终态各恰40、队列排空、无死锁，19项检查通过；API/Worker均正常停止、随机性能库已删除 |

quick纯读P95为12.64–130.73ms，混合阶段最慢端点P95为217.15ms；这些是本机短时合成负载，样本规模和机器条件见原始 `postgres-quick.json`，不作为试点容量承诺或RPO/RTO验收。本地原始日志与回执保存在忽略目录 `data/handoff-20261128-next/`。

清理前核对随机测试/性能库剩余0，独立管理库没有业务users表；核对容器发布端口、Compose项目标签及新卷确非原有卷后，停止并移除本轮容器/网络，再仅移除该项目卷。清理后项目容器/网络/卷均为0，原有10个容器及10个卷仍存在；未停止既有服务，Docker Engine保持运行。实际回执为本地 `postgres-cleanup.json`，本轮API/Worker均已退出。

本轮无新增依赖、环境变量、运行/构建入口或迁移，启动脚本与环境模板沿用。未重打APK，上一轮 `dgy-QY9rJf` 只对应 `c4709fd` 的运行源码。目标ARM64终端、真实硬件/模型/消息、远端Actions、生产容量及RPO/RTO仍需各自证据。

## 2026-11-28 第三轮：课程确认与0.1.4候选来源追溯

基线 `b8bc1ca99e86b3a89964d62e445cedd7d93fb054`，工作分支 `codex/android-preview-014`。App四处版本元数据同步到0.1.4/code5，移动锁文件仅改包自身版本，所有依赖条目逐项与基线一致；后端版本不变。

课程外部视频原先等待Alert后直接调用旧URL，本轮仅给该操作增加局部确认世代。内容/用户/API/宠物或焦点生命周期变化、新版本/视频地址返回、撤回清空来源及收起正文均使旧确认失效；正常确认后才调用系统打开，取消不打开，不写学习进度。新增11项先在旧实现取得1过/10失败，修复后11/11，learning-screens整文件27/27。独立复核通过；这些是原生Alert/导航/Linking模拟，不能替代系统终端验收。

APK入口沿用现有复制白名单和保密过滤，增加 `source-manifest.json`：非node_modules输入路径/字节数/SHA、Git HEAD/dirty（不可用或源码锁文件未被仓库跟踪则null）、实际build驱动SHA、仅三项白名单公开API地址。复制后和每个构建阶段核对源目录与独立快照，源码增删改、驱动改变或fresh Gradle元数据改变均中止交付；receipt v1保留旧字段并新增 `version/version_code/source_manifest/source_manifest_sha256`。Git HEAD是上下文，脏工作树仍以清单摘要为准，依赖只核对锁定版本而非逐字节认证。

独立复核补充制品写入失败边界：本次快照内先暂存APK/manifest/receipt，三者写齐并核对摘要后才整体移入最终新目录；移动前核对真实artifacts路径仍在构建根内并拒绝已有目标。写入或复制失败只保留本次失败快照/暂存，最终目录不出现不完整新包，历史制品保留。

根 `npm.cmd run build` 与mobile `npm.cmd run check` 均退出0；根已构建后在mobile执行 `tsc -p tsconfig.test.json` 与 `node --test test/*.test.cjs`，173/173通过、0失败/跳过（15秒），含构建专项30/30及课程页面27/27、既有Windows启动入口。构建追溯新增9项在旧实现全失败，ZIP嵌套另复现父仓库误归属；独立复核后补充暂存交付回归，部分写入、实际复制失败和越界路径在旧流程复现失败，修复后全部通过。没有后端/数据库变更，本轮未重跑后端全套或PG实库，上一轮实库结果保留其原提交范围。

上述源码先提交再进行fresh候选构建，后续真实构建与独立检查另记本节；本地日志目录为 `data/handoff-20261128-preview014/`。构建流程变化已同步根/mobile README、APK合同及交接文档；没有新增环境变量或依赖，后端及mobile启动BAT、API/Worker启动流程、环境模板和数据库迁移均沿用。本轮不对外发布或切换业务环境。

### 0.1.4/code5实际候选与独立检查

从干净源码提交 `697fcd9343dee0f90ccfdef77a5b65125ef49d55` 执行fresh ARM64构建，check/prebuild/Gradle均退出0，自动来源guard未触发，prebuild未改package.json。总流程580.067秒，Gradle8分8秒、611项全部执行；新APK包含此前媒体删除确认与本轮课程视频确认修复。

| 项目 | 本轮实值 |
| --- | --- |
| 制品 | `E:\AndroidDev\b\artifacts\dgy-SHsSQ7\doogy-preview-arm64.apk`，27,468,781字节 |
| 版本/包名 | 0.1.4/code5；`com.doogy.mobile.preview` |
| APK SHA-256 | `e2134c730814ba906e9eef2dfaa63e258830c172673d6fd2e6e3c2090d580ee6` |
| 自动源码清单 | Git HEAD=697fcd9、dirty=false，38个非node_modules输入与源/快照一致，构建驱动摘要匹配；`public_api_urls={}`，服务器由安装者显式填写 |
| 清单SHA-256 | `46811aa8b2f81ffff727e9484b409e0c83f567fd9c3aeacf72e8f5589e659660`，与receipt关联一致 |
| 原生内容 | 仅arm64-v8a、19个原生库，内嵌bundle2,046,592字节；minSdk24/targetSdk36/compileSdk37 |
| 独立验签/权限 | apksigner、aapt2、zipalign均退出0；保留前台录音，无相机/定位/后台麦克风服务权限，仍是Android Debug测试签名 |

前包dgy-QY9rJf也重新独立验签并核对其原APK摘要，新旧证书SHA-256同为 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`。这证明签名一致，不等于升级验收。原receipt独立验签字段保留构建时点的not_performed；本次独立结果在同制品目录 `verification/verification.json`（passed=true）及对应日志，自动清单为 `source-manifest.json`。三份主制品完成暂存后成功整体移入新目录，work/delivery已不存在。制品及原始日志保留本机，不纳入源码仓库。

T03另尝试从同一提交导出无私密配置的源码归档，在一次性node:24 Linux容器执行同序CI；Docker Hub匿名token请求 `auth.docker.io/token` 返回EOF，镜像未拉取，npm安装/类型/测试均未执行。没有修改代理/registry或替换锁文件，原10容器/10卷保留，无自有容器或新增命名卷残留。失败回执位于本地 `linux-ci-f00bcfd943f2/result.json`；不能记为Linux通过或远端Actions执行。

当前ADB仍无目标设备，本轮未安装/升级/原生启动或无Metro运行；权限/录音/可听播放、完整51画板和真实外部能力仍待目标终端及授权条件。API/Worker测试进程已退出，未改用户环境文件或业务库。

## 2026-11-28 E盘阶段二：Android核心缺陷与离线终端准备

工作目录E:\Doogy_ma\project；使用E:\Doogy_ma\scripts\Use-DoogyEnvironment.ps1的既有进程级E盘配置。原C仓库未写入，不复制业务库/环境/签名。业务改动仅MediaCapture.tsx、CareScreens.tsx、client.ts；三个问题分别由真实Expo选项转换、迟到系统选择器、跨会话/重复请求键竞争先复现后修复。care新10项旧2过8败→相关文件28/28；media新1项旧失败→相关15/15；client新3项旧全失败→20/20。

实际执行mobile的npm run check和npm test：类型通过、187/187（新增14）、0失败/跳过；npm test先编译最新父后端与测试模块。同次源码随后node --test dist/test/*.test.js：401过、0败、26个PG专项跳过。日志/red-green回执位于E:\Doogy_ma\evidence\android-stage2。启动专项包含本轮移动回归中的Windows入口失败即停，以及后端合成API/Worker管理；无新增依赖、工具变量、运行入口、后台服务或数据库迁移，业务.env.example及启动脚本保持原样。

本地npm run apk:android -- E:\Doogy_ma\b产生fresh dgy-p0Udwe，版本0.1.5/code6、arm64-v8a、27,469,497字节，SHA256 `3843b10398eda9ea9b52fd70db3e219bff02f8b4c9174287a7e35e03b6480f48`。check/prebuild/gradle全退出0；Gradle10m36s、611任务；apksigner/aapt2/zipalign独立退出0。与E盘0.1.4基线同包ID/同测试证书/code6>5/14行权限完全一致；内嵌JS2,047,308字节。静态条件通过不等于手机安装升级。原receipt的独立验签字段保留生成时not_performed，后置结果见android-stage2/android-verification.json和产物verification目录。

源码清单38项及driver逐一匹配，HEAD6870073/dirty=true，公开API地址为空。构建时唯一仓库状态额外变化为未跟踪的docs/项目需求文档-Pawch对齐版.md，非构建输入，已只读核对并保留。来源报告如实记录状态文本有差异，而非伪写未变化。后续本段仅补文档，不改运行输入；实际输入以清单SHA为准。本轮记录10个自有构建进程已退出，没有强停共享进程，未执行ADB/模拟器命令。

用户明确后端仅电脑127.0.0.1，先准备离线安装。手机loopback不是电脑，USB文件传输不提供网络隧道；不使用start-app-demo的LAN入口、不开放USB网络或防火墙。E:\Doogy_ma\artifacts\android-stage2-20261128包含基线+候选APK、两份1秒合成媒体、先看这里.md/验收记录.md及SHA清单；手机尚未安装、型号/系统/ABI未知，14项原生记录均待用户操作。先USB本地复制→基线新装→离线错误/连接设置→候选覆盖更新，不卸载或清空数据；候选独立新装另列待验。登录/恢复、宠物/照护、撤权、媒体原生权限与可听播放等受后端不可达阻塞。ADB只读支持边界见E:\Doogy_ma\evidence\android-stage2\adb-review.md；iOS、云构建、推送、发布未进行。
