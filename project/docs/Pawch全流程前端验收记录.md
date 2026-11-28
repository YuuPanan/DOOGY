# Pawch 全流程前端：本机开发与分层验收

日期：2026-11-28；工作区：`E:\Doogy_ma\project`；移动源码版本：0.1.7 / Android versionCode 8。本文记录全流程前端，上一批 Today → Pet → Care 的 0.1.6/code7 记录保留原范围。

后续原生阶段已在Windows本机两个独立API34/x86_64 AVD实际通过code8新装、显式本机合成API、注册建宠、Today、照护保存重读、会话恢复和code7→code8覆盖升级；权限、媒体及其他边界仍逐项验收，详见[Windows Android模拟器原生验收记录](Android模拟器原生验收记录.md)。已按用户授权保留默认ADB认证目录的C盘例外，其余受审项目路径E，后端仅127.0.0.1；复用现有APK，没有重打。本文以下65页实现、26组Web与319自动回归保留前阶段基线范围，逐页表另标原生已执行核心路径，不将它们视为65页全量原生通过。

## 范围与实现

以本机 `E:\Doogy_ma\figma-assets\Pawch-frontend-handoff\manifest.json`、`design-tokens.json` 和 [Pawch 对齐需求](项目需求文档-Pawch对齐版.md) 为依据。65 张画板全部有独立可操作的 React Native 页面或明确门控的补充状态：入门与绑定 8、今日与健康 12、趋势与营养 9、预警与照护 4、定位与安全 15、活动与行为 13、学习与问答 4。对应 [逐页验收表](pawch-65-acceptance.md) 和 [机器可读表](pawch-65-acceptance.json)，不将首批三页视作全量交付。

新界面在 `mobile/src/pawch`，保留 React Navigation、AppContext、ApiClient/MobileApi、SecureStore、服务端角色/版本/幂等和实际 API。原业务页仅作为家庭、全部照护类型、设备管理、联系人、账户与隐私等必要补充入口，65 张主流程不以旧页套壳。五个导航为 Today、Safety、Understand、Learn、Ask AI。Web 的 `#pawch/<画板号>` 是带鉴权的正常页面地址，不写入测试令牌或绕过权限；应用内部按钮保留 Stack 返回和来源参数。

复用原导出字标、导航图标、插画和明确标为演示的静态素材，共 34 个 SVG；原文件字节不变，原始宽高由资源注册表保存，地图针标组合只做已记录的等比布局。全屏截图和 component-reference 不进入运行资源。共享颜色、按钮/列表/导航尺寸直接读取导出 token；表单、图表、按钮、滚动和状态使用 RN 组件。新增唯一运行依赖为与已装 Expo SDK 匹配并精确锁定的 `expo-image@58.0.18`，用于 Android/Web SVG；原生包需要重新构建。没有新增权限、业务 API、环境变量或数据库结构。

## 实际软件验收

最终完整移动回归 **319/319 通过，0失败、0跳过**，类型检查退出0；日志 `mobile-full-release-candidate.log` 和 `mobile-types-release-candidate.log`。本轮新增105项在既有214项基础上验证路由65分派、真实页面渲染、写后重读/仅重试读、版本冲突、切宠切号/撤权、迟到请求/按钮卸载隔离与能力门控。测试渲染器和SDK桩属于自动测试，实际浏览器测试属于RN Web，二者均不记为Android原生通过。证据根目录：`E:\Doogy_ma\evidence\pawch-full-20261128`。

最终启动按既有入口fresh构建/check/export，API/Worker实际就绪，Web导出在 `E:\Doogy_ma\artifacts\pawch-desktop-21c3be5dea474b3982daa487b47184b0\web`，与 `desktop-preview-iteration3.log` 一致。额外重跑后端预览守卫 **5/5**，验证配置边界、仅127/独立合成模式及导出目录校验，日志 `backend-preview-guards-final.log`；未把历史10项或401项后端数字记为本轮重跑。没有后端业务/数据库变化，未触发PG实库迁移或全量后端回归。

已通过 26 组实际 RN Web + 合成 API/Worker 流程：

| 范围 | 结果与证据 |
| --- | --- |
| 核心 12 组 | UI 注册→建宠→显式跳过项圈→持久化完成→Today；07→26 照护保存 GET→返回 07/09 重读；断网草稿→显式重试且只保存一次；身体观察 PUT/GET、真实 409 保留草稿与明确重读；体重保存与身份重读；未知能量餐食保存不补零；标签能量 80 kcal 与显式撤回重读；90 天分段查询；实际观察本人已阅；viewer 控件只读/API 403；owner 撤权后旧宠物清除/API 404。最终export3：`core-web-6d9e3b23.json`。 |
| 安全 6 组 | 切宠、围栏断网草稿→一次 POST201→137m 重读、本人偏好、返回来源、切号与 viewer 只读403、38a→38b→38c/39 本地演示无外发或分享 POST。最终export3：`safety-browser-fb28b234.json`；真实设备策略/硬件回执因无绑定设备跳过。 |
| 活动与学习 8 组 | 计划只预填、取消恢复、显式保存与返回40重读；学习正文/进度/明确来源版本→问答→Worker offline_demo；人工行为保存与历史；已有授权合成媒体解释；录像演示零写；viewer边界；断网记录保留与一次重试。最终export3：`behavior-learn-browser-5a8b3a25/report.json`。 |

各测试独立创建自己的随机合成账户/家庭/宠物，不操作普通业务库、不复制业务 `.env` 或凭据；HTTP 异常含有意断网、409、403、404，逐项在报告中列明。页面错误和外部 origin 均为 0。26 组不是 65 个逐页独立端到端测试；逐页渲染、截图、人工对照和实际流程分别记录。

最终65/65参考与App截图均390×844，见 `comparisons/iteration3/index.html`、`capture-pawch-65-iteration3.json`。65逐页人工审阅按8＋25＋15＋17关联回执；`acceptance-final-verification.json`核对51主/14补、七组数、路由/素材存在、图尺寸/哈希与人工审阅追溯全部通过。33电量卡高度、36实际事件长文等细布局差异保留在表，不宣称像素级一致；真实长文本、额外合同字段与明确能力说明可滚动，主要操作固定可达。旧三批截图、红绿例与中间构建日志不覆盖。

只读收尾复核确认65路由与设计manifest一致、无非法出边/整页旧Screen套壳/整屏图运行引用，额外家庭/隐私/设备/媒体/照护版本等入口仍可达。11份交付/说明文档的595个本地链接无缺失，`git diff --check`通过；这两项不是业务或原生测试。

保留真实失败与修复证据：初次建宠后未跳转是 own-pet 选择提交时的范围校验问题，修复后21项引导回归与真实新建流程通过；共享按钮卸载后迟到操作/完成回调有2个红例，修复后通过。后续 QA 重复 hash 不触发变化、选到隐藏 Stack 中旧输入框，以及38a折叠表单未展开，属于测试采集器问题，原失败报告保留，修正采集器不改业务逻辑。视觉第一轮的提前截图、长标题和44录音区域布局缺口也保留原图，不将采集成功当视觉通过。

## 演示与能力边界

- 13 不提供原型80分，展示四类事实和来源；未知数据不补零，缺项圈不宣称安全。真实图表来自查询结果，睡眠总量不拆造阶段。
- 15c 是项圈来源的只读回看，主人修订在15a，不能改遥测。保存成功而重读失败只重试读取；冲突保留草稿。
- 20a/b 是拍餐与估算边界示意，不请求相机、不生成假识别结果；20c 的成功只来自真实保存后授权重读。手工餐食、修订和撤回保留实际合同。
- 底图、地图针标和边界圈明确为设计演示，与实际坐标/精度/时间/来源分栏；不把 API 坐标投射到假底图。围栏和本人通知偏好按实际配置保存，设备策略/追踪按绑定与能力门控。
- 38a–c、39 仅本地选择/预览/复核/模拟结果；不联系、不派遣、不创建外部通知或位置分享。必要的真实联系人管理入口另保留。
- 44 的静态波形仅为入口插画，不是录音结果。前台录音/系统导入继续使用现有组件与明确用户操作，约59秒停止、60秒/20MiB服务器校验；44b–e 不开启相机、录像或 AI。SDK/系统权限、真实音频播放与前后台仍待原生。
- 课程取已发布版本；问答和解释标明 offline_demo/未配置，不宣称真实模型、诊断或识别准确率。保留 CN/Global/API 显式配置和账号家庭隐私入口。

## 本机复测

新建独立合成环境，先 fresh 根编译、mobile check、Web export，再启动 API 和 Worker：

```powershell
E:\Doogy_ma\Start-PawchDesktop.cmd
```

恢复本次同库（不重新导入演示、不清理数据）：

```powershell
E:\Doogy_ma\Start-PawchDesktop.cmd -Resume "E:\Doogy_ma\project\data\app-demo-e4b9b436e9694ca8bdbcec4c1cf195fa\demo.env"
```

只打开终端打印的 `http://127.0.0.1:<port>/` 根地址。可先在06登录本地明确标为合成演示的账号，或由02注册新合成账号，正常按钮进入各组；具体账号不复制到本文。按启动终端 Enter 只关闭本次 API/Worker。旧服务占用端口时先核对归属，不按端口/进程名批量结束。

自动回归：

```powershell
. E:\Doogy_ma\scripts\Use-DoogyEnvironment.ps1
Set-Location E:\Doogy_ma\project\mobile
npm.cmd test
npm.cmd run check
```

实际 UI 工具在 `E:\Doogy_ma\tools\desktop-preview-qa`：`test-pawch-core.cjs`、`test-pawch-safety.cjs`、`test-pawch-behavior-learn.cjs` 接受终端实际127地址；采集工具 `capture-pawch-65.cjs` 还接受未使用的新迭代名和合成库目录，拒绝覆盖已有截图。工具使用已核对 E 盘 headless-shell，临时 profile/cache/log/crash 目录在 E，不启动默认浏览器或 ADB。流程测试会创建自己的合成资料；截图工具只读本次合成来源，除登录不提交业务写入。

## Android 与未验范围

已从最终冻结源码fresh构建独立双ABI测试包，包含本轮65页和新增SVG模块，旧code7包不能代表本轮前端：

| 项目 | 实际结果 |
| --- | --- |
| APK | `E:\Doogy_ma\b\artifacts\dgy-NK37fh\doogy-preview-qa-arm64-x86_64.apk` |
| 版本/包名 | 0.1.7 / code8；`com.doogy.mobile.preview`；测试签名，非生产签名 |
| 大小/SHA256 | 50,478,783 bytes；`61b69e9de2a18f86096f8aa4b9a9c33f2028ae12fd320fb597578240797dcf57` |
| 来源 | 独立快照 `E:\Doogy_ma\b\dgy-NK37fh`；84项运行输入与当前E源码、快照及source-manifest逐项哈希一致；manifest SHA256 `6520ab7a1a1ea6a52299cac7827d91482a06bfa13a480d2917bb8e91b56c53cf` |
| 构建 | check/prebuild/Gradle退出0，Gradle BUILD SUCCESSFUL，617任务；所有路径仍E，不触发ADB/安装 |
| 独立静态检查 | apksigner、aapt2版本/包名、zipalign、两ABI各21原生库机器类型、JS bundle、同code7测试证书/包名/权限且code递增均通过；不等于安装/升级/运行 |
| 记录 | 产物目录 `receipt.json` / `source-manifest.json`；最终独立核对通过 `E:\Doogy_ma\evidence\pawch-full-20261128\android-qa-verification-code8-final-r8.json`，产物内 `verification-r8/verification.json` |

构建器receipt中的 `independent_signature_verification:not_performed` 保留构建时的职责说明，独立验签结果在另行生成的verification回执，不能混读为同一阶段。构建中间快照cBWh0m为视觉修正主动停止的自有进程，未交付旧包，停止记录与日志保留；最终快照为NK37fh。

新增ExpoImage模块也已完成静态闭环：同次R8映射 `expo.modules.image.ExpoImageModule → m91 → Lm91;`，最终classes.dex的class_defs_index4493有实际类定义，且ExpoImage注册名存在；mapping和DEX摘要均记录。首份 `android-qa-verification-code8-final.json` 因只按未混淆原类名扫描而给false，该验证器局限回执原样保留；最终应读后缀 `-final-r8.json`（passed=true）。同一APK、源码、签名未改动，没有为修验证脚本重建或放宽权限。

本轮再次只读核对SDK/ADB/AVD/镜像/架构与现有配置，见 `android-readiness-delta.md/.json`。E SDK ADB 37.0.3 二进制与上轮相同；默认认证 home 仍来自 Windows `CSIDL_PROFILE`，`HOME`、`USERPROFILE`、`ANDROID_USER_HOME` 或 `ADB_VENDOR_KEYS` 未能证明受支持地替代完整默认 key 写入。E SDK 无可执行 emulator、系统镜像和有效 AVD；历史已识别的镜像为API34/x86_64，不能假定 ARM64 包兼容。未执行 ADB（包括version探针）、模拟器、认证绕过、系统虚拟化/防火墙修改，也未从C复制密钥或镜像。

Android 原生启动、安装/升级、冷启动 SecureStore 恢复、系统媒体拒权/授权、导入和可听播放、前后台与键盘/安全区仍待验；Web 通过不能替代这些。仅允许本机监听127，未开放LAN/USB、公网隧道或外部后端。项目源码、依赖、缓存、快照、构建与证据落E；Windows自身不可控日志不被描述为项目已证明零C写入。

最终环境只读回执 `final-environment-audit.json`：E分支 `codex/doogy-ma-e-drive`，HEAD `6870073bbb47cf5fa1d811c20b1b7722f7b5005d` 上保留未提交变动；C原来源仍同HEAD且干净，未修改。Pawch需求原文SHA256仍 `962da685d033fe3d8c25b2a1111c7aa4cb963dbb8984128e4bc6b40855bdb558`。`openapi-audit.json`核对静态/运行时均129路径、158操作，路径差集为空。监听实测仅127.0.0.1:53808，API/Worker执行路径均E。

本轮不做真机、iOS原生、云构建、推送、提交、远端推送或发布。最终仍需满足全E路径的原生工具条件后，单独执行Windows Android模拟器验收；无需等待或接入手机。
