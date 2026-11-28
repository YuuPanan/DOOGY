# DOOGY Android App

React Native + TypeScript + Expo 客户端，Android 优先，iOS 后续。当前源码版本为 0.1.7 / Android versionCode 8。此目录用于协同开发，保留现有业务和硬件标准合同，不包含本机配置、依赖缓存、数据库、生成的原生工程或历史 APK。

当前Windows Android模拟器已实际通过已执行的核心链路（App显式配置合成API、注册/建宠、Today、照护保存返回重读、force-stop会话恢复）、独立AVD的code7→code8覆盖升级、媒体技术样本，以及切号切宠、只读/撤权和实际断网恢复路径。人耳可听仍待确认，不代表全部65页原生或完整组合通过，见 [Android模拟器原生验收记录](../docs/Android模拟器原生验收记录.md)。复用既有code8双ABI包，本轮没有重建或新增业务源码、依赖、接口、迁移。包内CN/Global默认URL仍为空，实际通过App配置10.0.2.2宿主回环连接仅127.0.0.1的合成API；DATA_MODE=offline不等于客户端无需HTTP。

## 前阶段基线（2026-11-28）：Pawch 七组65画板

`src/pawch/Router.tsx`分派七组独立RN页面，`ui.tsx`读取导出token，`assets.tsx`用expo-image加载34份原SVG（字节不改，全屏参考图不打包）。`App.tsx`保留既有鉴权/业务Stack与必要入口，五Tab按Figma导航。唯一新增依赖expo-image@58.0.18与现有SDK匹配并锁定，曾要求fresh构建，已由现有code8完成；本轮复用，不再次重打，旧code7只作升级来源、不含全量新界面。无新权限/环境变量/业务迁移。

逐页清单见 [65画板验收表](../docs/pawch-65-acceptance.md)，复测和分层结果见 [全流程验收记录](../docs/Pawch全流程前端验收记录.md)。统一E盘环境后执行npm test/check；本机入口仍是 `E:\Doogy_ma\Start-PawchDesktop.cmd`，先编译检查导出，再启动127合成API/Worker。此处Web/静态基线形成时尚未启动ADB/模拟器，授权后原生进展见顶部记录，三类证据分别验收；不等待手机，不做iOS/云/发布。

## 历史：0.1.6/code7 Pawch 三页电脑预览

本轮只推进电脑端 Android 模拟/预览，不做或等待手机。Today → Pet → Care 已用真实 RN 组件接通既有 API：档案概览/编辑/取消/保存，照护提交后返回档案或今天并重读；空态、断网草稿、读失败重试、只读权限与撤权隔离保留。实际通过的是 RN Web 桌面 headless-shell 浏览器 6 场景：登录、建宠、照护返回重读、断网恢复不重复提交、只读写入 403、撤权清除旧宠物；页面错误 0、外部 origin 0。另一个真实浏览器草稿场景以`profile-draft-93835fd5.json`失败 → `profile-draft-1564dfc7.json`通过，验证同宠物外部更新后未提交草稿保留，焦点权限重读继续有效，合计6+1场景。定向 UI 回归 64/64，后端预览守卫 10/10，不是全量重跑或原生验收。

使用 `E:\Doogy_ma\Start-PawchDesktop.cmd`，入口先 fresh 根编译、mobile check、Web export，再启动既有 API/Worker，只绑定 `127.0.0.1`；打开终端打印的地址，按 Enter 关闭。`-Resume` 可恢复本项目已验证的 `demo.env`。预览目录变量 `DOOGY_MOBILE_WEB_PREVIEW_DIRECTORY` 由该本机入口设置，后端只在 offline/SQLite/`DOOGY_DEMO=1`/`HOST=127.0.0.1` 且导出目录通过 E artifacts 实路径校验时启用，不新增业务 API 或数据库迁移。

Android 原生未运行：当前 ADB 默认认证 home 来自 Windows `CSIDL_PROFILE`，没有已证实受支持的完整 E 盘覆盖；E SDK 无 emulator/images，已知镜像为 API34/x86_64。双 ABI QA 包的最终静态结果见 [本机电脑验收记录](../../docs/Pawch电脑验收记录.md)，不等于原生通过；本轮操作见 [流程](../docs/process.md#2026-11-28-pawch-电脑预览)，最终浏览器报告为`E:\Doogy_ma\evidence\pawch-desktop-20261128\desktop-ui-flow-ecf2fdc9.json`。不改系统、开放 USB/LAN 网络或调用外部后端；iOS/云/推送/发布未进行。

历史：2026-11-28 E盘阶段二的187项回归和0.1.5/code6 ARM64静态核对保留原范围，真实安装升级/系统权限/媒体仍未验。手动验收说明在E:\Doogy_ma\artifacts\android-stage2-20261128；下方通用手机和LAN步骤也不属于本轮电脑预览操作，不能作为本轮要求。详见父目录docs/process.md的E盘阶段二记录。

先阅读项目根目录的 fb.md 和 [开发约定](../AGENTS.md)，再按 [页面与接口覆盖](docs/migration-coverage.md) 定位屏幕。业务接口公共前缀为 `/api/v1`；启动后的后端根路径 `/docs` 与 `/openapi.json` 提供动态接口文档。

## 安装与联调

使用 Node.js 24 与仓库锁文件。在项目根目录执行：

```powershell
npm.cmd ci
npm.cmd test
.\start-app-demo.bat
```

最后一个命令显式创建独立 SQLite/offline 合成演示库并启动 API、Worker，控制台打印手机可达地址候选。普通业务环境仍按根目录 [README](../README.md) 配置，不覆盖已有 `.env`。每次新建演示库与恢复同一次演示资料的区别见 [演示说明](../docs/app-demo.md)。

在第二个终端进入 mobile：

```powershell
cd mobile
npm.cmd ci
if (!(Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
npm.cmd run check
npm.cmd test
```

编辑本机 `mobile/.env`，仅填写公开 API 根地址，不带 `/api/v1`、令牌、账号或供应商密钥。真实手机使用可达的电脑/服务器地址；Android 模拟器访问宿主机可使用 `http://10.0.2.2:<端口>`。App 中也可展开连接设置，选择 CN/Global、填写地址后检查连接。只有后端明确报告独立合成演示，才显示测试主人/只读账号的填入入口；仍需用户点击登录。

offline 表示项目不调用外部业务服务，App 仍需连接后端；不表示把服务端嵌入手机或手机无网可用。

## 开发与构建

先准备自己的 JDK 17、Android SDK 37、构建工具和设备，见 [工具链](docs/android-toolchain.md)。本项目使用原生模块，安装依赖或修改 config plugin 后需要重新构建开发包。

```powershell
npm.cmd run android       # 编译并安装 development build
npm.cmd start             # 为已安装的开发包启动 Metro
npm.cmd run web           # 辅助浏览器预览，不代替原生验收
npm.cmd run apk:android   # 构建内嵌 JS 的 ARM64 preview APK
npm.cmd run apk:android:qa # 构建 ARM64 + x86_64 preview APK
```

`mobile/start.bat` 缺依赖时先执行 npm ci，类型检查失败即退出，再启动 Metro。APK 入口复制当前源码到项目外的短英文目录，检查后 fresh prebuild、Gradle 构建；失败不会交付旧包。每次交付生成源码输入清单，回执关联其摘要及实际生成的版本/code；复制或构建期间运行输入改变会停止交付。生成路径、测试签名、公开地址注入及校验要求见 [APK 说明](docs/android-apk.md)。iOS 原生编译需要 macOS/Xcode、签名与相应终端，Windows 上创建源码不等于完成 iOS 验收。

## 代码与协作边界

- `App.tsx` 组织五个 Tab、Stack、当前宠物选择和身份入口；`src/screens/` 实现页面，`src/ui/` 提供共享组件。
- [ApiClient](src/lib/client.ts) 统一处理 Bearer 会话、刷新、错误和幂等键；[MobileApi](src/lib/mobileApi.ts) 处理 Expo 原生文件上传及授权导出/分享。原生上传使用 FileBlob.bytes，不能换回仅带 uri 的旧式表单对象。
- [AppContext](src/state/AppContext.tsx) 管理服务器、区域、身份与当前宠物。跨账号/服务器/家庭/宠物/角色的迟到回包不得恢复旧范围。
- [硬件合同](src/hardware/contracts.ts) 保留能力状态、BLE 配对端口、短期网关引用和遥测类型；不在客户端存长期设备秘密或假定具体硬件协议。
- 权限由后端再次核对；写请求保留幂等、版本/attempt、明确确认和来源有效性检查。目标/身体观察分别保存原文草稿，运动计划选用只预填，未知数据不补零或评分。

## 媒体与外部能力

媒体导入或前台录音由用户主动触发，文件最多 60 秒 / 20 MiB。录音约 59 秒原生停止，为编码尾部留余量；导入片段必须填写实际报告的采集开始时间。服务器验证实际容器、编码和解码时长，详见 [媒体合同](../docs/media-upload.md)。上传成功不自动解释或发送；播放需重新授权，仅前台使用原生控件，停止、离页或后台清除来源。

真实硬件/BLE、底图、外部模型、移动推送、邮件、联系人外发和外部身份供应商由各自能力门控。离线解释、问答和外发必须显示明确模拟/未配置，不伪造真实识别、设备执行或接收成功。麦克风/相册权限在实际操作时申请；相机、手机定位、后台录音与后台播放保持当前关闭边界。

## 验证与版本记录

移动测试会先构建父目录后端，因此需要整个仓库及根依赖。测试、迁移和合成 fixtures 是协作所需资源，不能作为“无运行引用的文件”删除。当前依赖中的 Web runtime、native-stack、dev-client、system-ui 等仍服务于已有预览、原生导航和构建路径。

每次变更记录实际 check/test、通过/失败/跳过与设备范围。组件和 SDK 桩不代替系统权限、文件选择器、编解码、后台生命周期和真机测试；HTTP 或模拟回执不代替真实硬件与生产外发。纯净源码不携带旧测试日志或 APK，不将历史验收数字当作新提交的运行结果。
