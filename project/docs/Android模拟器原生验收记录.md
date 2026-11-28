# DOOGY 0.1.7/code8｜Windows Android 模拟器原生验收记录

日期：2026-11-28；工程：`E:\Doogy_ma\project`；授权前检查证据：`E:\Doogy_ma\evidence\android-native-017-20261128`；授权后续做证据：`E:\Doogy_ma\evidence\android-native-017-authorized-20261128`。

## 当前实际结果（授权后，2026-11-28）

**本轮已执行的Android原生核心、code7→code8覆盖升级、媒体技术路径、切号切宠/只读撤权及真实断网恢复场景已通过；人耳可听仍待确认，完整组合与65页全量原生不作通过结论。** 本次使用已有APK，没有修改App源码、依赖或重新打包。下方18:18环境快照及授权前阻塞记录是历史检查点，不能覆盖本节最新结果。

| 场景 | 实际结果 | 主要证据 |
| --- | --- | --- |
| code8全新安装、脱离Metro启动 | PASS；boot完成后安装Success，实际0.1.7/code8、x86_64；原生欢迎页、SVG和表单可操作 | [核心结果](../../evidence/android-native-017-authorized-20261128/native-run-02/core-native-results.md)、[安装](../../evidence/android-native-017-authorized-20261128/native-run-02/install-code8-boot-complete.json)、[运行版本](../../evidence/android-native-017-authorized-20261128/native-run-02/installed-package.txt) |
| API模式与核心数据闭环 | PASS；App显式配置`http://10.0.2.2:53108`；独立合成API/Worker，服务端offline/demo/sqlite，HTTP确实联通；原生注册、建宠Native017A、Today、照护保存和重读 | [保存结果原生截图](../../evidence/android-native-017-authorized-20261128/native-run-02/14-care-save-result.png)；服务端offline表示无外部业务调用，不表示App断网 |
| force-stop后会话恢复、返回重读 | PASS；重开无需登录，Today和详情重读唯一标记`NATIVE-CORE-0d9879c5815f`；只读旁证对应记录ID`912d9581-8f94-4dab-a683-ee0aedebfab5`未变、无重复记录或修订 | [冷恢复](../../evidence/android-native-017-authorized-20261128/native-run-02/15-cold-session-restored.png)、[重读](../../evidence/android-native-017-authorized-20261128/native-run-02/18-care-history-reread.png)、[主机只读比对](../../evidence/android-native-017-authorized-20261128/core-api/native-core-companion/after-force-stop.json)；SELECT不是App HTTP抓包 |
| 显式退出与重新登录 | PASS；退出后force-stop再开回欢迎页，不恢复旧会话；邮箱密码重新登录后恢复本人宠物和原记录 | [退出冷启](../../evidence/android-native-017-authorized-20261128/native-run-02/25-logout-cold-start.png)、[再次登录](../../evidence/android-native-017-authorized-20261128/native-run-02/26-explicit-login-success.png)；凭据提交过程未保存截图/XML |
| code7→code8覆盖升级 | PASS；第二独立AVD全新安装0.1.6/code7并在原生登录；随后`adb install -r`安装0.1.7/code8，首次安装时间18:40:35保留、更新时间变为18:43:09；不卸载、不clear；升级直接恢复本人会话、宠物和旧照护记录 | [覆盖安装回执](../../evidence/android-native-017-authorized-20261128/native-run-03-upgrade/install-code8-over-code7.json)、[升级后原生截图](../../evidence/android-native-017-authorized-20261128/native-run-03-upgrade/07-code8-after-overlay.png)、[升级后只读旁证](../../evidence/android-native-017-authorized-20261128/core-api/native-core-companion/after-upgrade.json) |
| 麦克风与录音草稿 | PASS（本模拟器合成输入）；系统拒绝后提示明确且可导入，再次允许后录音、手动停止、取消清理均执行；第二次未手动停止，自动结束并上传，服务端解析59.001905秒 | [拒绝](../../evidence/android-native-017-authorized-20261128/ui/native-media-20261128/06-microphone-denied-state.png)、[自动停止上传后](../../evidence/android-native-017-authorized-20261128/ui/native-media-20261128/16-auto-record-upload-outcome.png)；未带allow-host-audio，不等于真实声学采集 |
| 系统文件选择器与导入 | PASS（所列夹具）；系统选择器取消不产生草稿，真实导入WAV与MP4，经显式确认上传并重读源列表 | [WAV](../../evidence/android-native-017-authorized-20261128/ui/native-media-20261128/27-wav-uploaded-source-list.png)、[MP4](../../evidence/android-native-017-authorized-20261128/ui/native-media-20261128/47-mp4-upload-source-list.png)；WAV用已记录生成开始时间；MP4只用原文件mtime作为合成时间标签，原精确生成开始未知，不冒充真实拍摄或本次导入时间 |
| 原生解码与播放 | PASS（WAV/MP4原生加载、Play/Pause、进度到终点；MP4蓝色首帧实际可见）；**人耳可听NOT_OBSERVED**，已询问用户，未收到确认 | [WAV播放](../../evidence/android-native-017-authorized-20261128/ui/native-media-20261128/37-wav-play-invoked.raw.png)、[MP4解码](../../evidence/android-native-017-authorized-20261128/ui/native-media-20261128/53-mp4-decoded-first-frame.raw.png)；3秒660Hz合成音实际播放时间18:56:58、18:57:46。播放器属于保留的Behavior业务入口，不计Pawch43/46已验 |
| SVG、键盘、安全区和返回抽查 | PASS（已观察样本）；欢迎/导航SVG、WAV时间输入框与系统IME、系统Back与播放器释放/返回Today；不代表65页或所有输入法布局 | [键盘样本](../../evidence/android-native-017-authorized-20261128/ui/native-media-20261128/25-wav-time-keyboard.png)、[返回Today](../../evidence/android-native-017-authorized-20261128/ui/native-media-20261128/56-handoff-today.png) |
| 切号切宠与家庭只读 | PASS（所列账户/角色）；B登录选自有Native017B后显示B note，切共享A只显示A note；Pawch07字段/Save及Pawch26字段/Save均disabled；切回A后实际宠物选择器只列A，不含B | [只读档案](../../evidence/android-native-017-authorized-20261128/native-boundaries/08-b-shared-a-disabled-pawch-profile.png)、[只读照护](../../evidence/android-native-017-authorized-20261128/native-boundaries/10-b-viewer-care-disabled.png)、[A选择器](../../evidence/android-native-017-authorized-20261128/native-boundaries/21-a-only-pet-after-relogin.png)；B夹具通过正常API准备，不算原生建档 |
| 家庭撤权生效 | PASS；只撤B在A家庭的test membership，正常API核对B旧记录读取404；App实际Refresh identity后移除A与CORE marker，自动回自有B并保留其照护历史；A原note未变 | [App刷新](../../evidence/android-native-017-authorized-20261128/native-boundaries/11-b-revoked-a-removed.png)、[B记录保留](../../evidence/android-native-017-authorized-20261128/native-boundaries/14-b-own-note-still-readable.png)、[正常API撤权回执](../../evidence/android-native-017-authorized-20261128/core-api/native-core-companion/actor-b-revocation.json)；不冒称实时推送撤权 |
| 真实断网保存失败、恢复不重复与返回 | PASS；仅关闭guest Wi-Fi/移动数据后空路由、TCP Network is unreachable，宿主后台持续运行；App保存明确失败且草稿保留。恢复原1/1/0、TCP恢复后同草稿重试一次，出现Saved/re-read，再实际Return to pet profile→Today→照护历史 | [失败](../../evidence/android-native-017-authorized-20261128/native-boundaries/16-guest-offline-save-error.png)、[恢复成功](../../evidence/android-native-017-authorized-20261128/native-boundaries/17-restored-retry-saved-reread.png)、[返回档案](../../evidence/android-native-017-authorized-20261128/native-boundaries/18-explicit-return-pet-profile.png)、[历史重读](../../evidence/android-native-017-authorized-20261128/native-boundaries/20-new-note-care-history.png)；未修改Windows网络或停止后端 |

设备为两个独立E盘API34 Google APIs x86_64 AVD，1080×2340、440dpi，WHPX可用；使用headless真实Android guest与受审SwiftShader 4.0.0.1。宿主API仅监听`127.0.0.1:53108`，没有LAN/公网开放。第一台AVD在核心测试后正常停止，保留数据；第二台最终留A/Native017A Today，网络恢复原Wi-Fi=1/移动数据=1/飞行模式=0，App PID5234。当前独立ADB5039、AVD及API/Worker继续运行供本地复测；原有5037 ADB与53808 Web演示环境未借用或结束。

边界8个实际场景、22组原生XML/PNG与验证结果见[边界报告](../../evidence/android-native-017-authorized-20261128/native-boundaries/report.md)。新marker`NATIVE-NET-45e31b7ec84e`为保存前0→断网失败后0→恢复重试后1条，总care8→8→9；唯一记录ID`9e903e4f-b7ad-4afa-958f-05da32a8a4a6`在返回后ID/时间/修订保持。持久化SELECT另行旁证，不冒充HTTP抓包。未验证服务端已提交但响应丢失、并发重复点击、所有角色/网络组合或长期token到期。

[本轮复测步骤](../../evidence/android-native-017-authorized-20261128/RETEST.md)列出现有实例冷启/新XML截图、同库API恢复、真实安装升级的隔离前提与受审参数；[最终宿主/设备快照](../../evidence/android-native-017-authorized-20261128/final-host-device-20261128T111546.json)记录实际版本、API34/x86_64、只回环监听、旧服务保留及APK未变哈希。[65页清单](pawch-65-acceptance.md)现有13页仅部分原生路径已验，余52页未抽查；所有画板的未测状态仍待验。

[本轮机器可读总回执](../../evidence/android-native-017-authorized-20261128/native-stage-result.json)关联实际产物、来源、各原生报告和哈希，保留静态/Web/原生及未验范围的区分。核心12条细分断言、单次升级路径、媒体14条技术断言与边界8场景各有独立口径，不相加冒充互不重叠的端到端用例数。

首次在Android系统服务尚未完成初始化时安装得到PackageManager/StorageManager空引用；该失败原样保留。等待`sys.boot_completed=1`后同一APK成功安装，属于测试启动时序问题，没有据此重打包或计作App缺陷。

媒体采集保留工具失败：一次uiautomator返回null root但exit0，固定临时名曾导致读到旧XML；该XML已标无效并排除定位/通过依据。后续helper改用每次唯一guest XML、检查新文件读取状态和内容；播放器VideoView导致idle失败时保留原始PNG，不复用旧XML。已完成核心26组XML/PNG另有逐组核对，不将本次媒体失败覆盖为历史核心失败。

原生媒体PID筛选日志中保留4条ExpoVideo的“activity不支持picture-in-picture”E级诊断。当前未启用PiP，所测WAV/MP4播放与返回未被阻断，没有为消除诊断启用PiP或新增权限。只在该已筛选的500行窗口未见AndroidRuntime/ReactNativeJS/MediaCodec错误，不宣称全程零native错误。

媒体逐项结果、真实文件ID/MIME/时长/哈希、56张原生PNG及失效采集排除规则见[媒体原生报告](../../evidence/android-native-017-authorized-20261128/ui/native-media-20261128/report.md)。14条有限技术断言通过；人耳可听未确认，物理cache删除未取证，超限负例、完整后台/切号媒体组合及65页全量布局未执行，不将这些项计为通过。

本轮不做真机、iOS原生构建、云构建、上传云服务、外发代码或凭据、推送或发布；本机回环API的合成媒体上传属于上述已测流程。默认模拟器合成麦克风输入、未配置BLE/真实地图/AI仍保留明确边界。

## 授权后继续：仅ADB默认认证目录的C盘例外

用户在上一轮明确询问后回复“允许”。授权范围为当前 `%USERPROFILE%\.android` 中ADB默认认证资料正常读写；不搬迁或复制旧密钥。SDK、镜像、AVD、缓存、日志、工具临时和产物继续E，不改系统/防火墙、不关闭认证、不对外开放服务。该授权解除此前默认认证目录的未授权阻塞，不替代模拟器其他写入路径和加速条件审计。

续做证据保存至 `E:\Doogy_ma\evidence\android-native-017-authorized-20261128`。APK继续复用0.1.7/code8及code7升级基线，没有重打包或修改产品源码。以下为授权后实际环境结果；下方“授权前检查点”及其后内容保留历史状态，不代表授权后的最新环境。

### 授权后实际环境快照（2026-11-28 18:18，UTC+8）

**环境已进入独立模拟器启动验证；App尚未安装，boot完成仍待确认，原生业务通过数为0。** 不将组件安装、WHPX可用、ADB注册或渲染器初始化记作登录、保存重读、权限、媒体或升级通过。

| 项目 | 已发生的结果 | 证据/边界 |
| --- | --- | --- |
| E盘官方组件 | 已通过现有sdkmanager17安装 Emulator **37.3.10/build16970787** 和 `system-images;android-34;google_apis;x86_64` **revision14**；既有E许可适用，没有接受新条款 | [安装结果](../../evidence/android-native-017-authorized-20261128/environment/sdkmanager17-install-result.json)；Platform-Tools仍37.0.3，ADB文件SHA未变；未复制C盘旧SDK或镜像 |
| 新隔离AVD | `Doogy017_API34_x64_20261128_d126fb10`，API34、Google APIs、x86_64；数据与注册文件位于 `E:\Doogy_ma\.runtime\avd` | [创建回执](../../evidence/android-native-017-authorized-20261128/environment/avd-created.json)；未复用旧AVD/userdata，未执行wipe-data |
| WHPX | `emulator.exe -accel-check` 实际exit0，输出 `WHPX(10.0.26200) is installed and usable.`；没有改Windows功能或BIOS | [加速探针](../../evidence/android-native-017-authorized-20261128/environment/accel-check.json) |
| 独立ADB | 正常认证未关闭；新server **PID54192** 实际仅监听 **127.0.0.1:5039**；USB/mDNS自动连接关闭，并限定计划serial `emulator-5620` | [server回执](../../evidence/android-native-017-authorized-20261128/native-run-01/adb-server-owned.json)；既有5037/PID25544未借用或结束 |
| 首次启动参数修正 | `tcp:127.0.0.1:5039` 被ADB自动启动分类为remote而失败；改为 `tcp:localhost:5039` 成功，实际listener仍为127.0.0.1；客户端继续显式 `-H 127.0.0.1 -P 5039` 及单serial | [纯环境自检](../../evidence/android-native-017-authorized-20261128/environment/child-environment-localhost-selfcheck.json)；旧helper与失败日志保留，general环境脚本未改 |
| run01：guest renderer | 已实际启动headless实例，但 `-gpu off` 被当前系统镜像判为不支持guest rendering，自动回退至lavapipe/SwiftShader并初始化宿主软件渲染；该回退未被接受，Root已停止自己创建的实例 | [实际运行复核](../../evidence/android-native-017-authorized-20261128/environment/runtime-environment-review.json)、[停止原因](../../evidence/android-native-017-authorized-20261128/native-run-01/guest-renderer-environment-failure.json)；环境兼容性失败，未安装App，不是App业务失败 |
| run02：明确软件渲染 | 在[窄范围写入门槛复核](../../evidence/android-native-017-authorized-20261128/environment/renderer-narrow-peer-review.json)后，显式 `-gpu swiftshader_indirect -no-window -no-metrics -no-snapshot`，禁用Vulkan/BluetoothEmulation/Uwb/WiFiPacketStream；QEMU PID50592，serial `emulator-5620`。实际日志报告 **OpenGL ES 3.0 SwiftShader 4.0.0.1**、Vulkan feature **overridden disabled**、crash reporting关闭 | [run02启动记录](../../evidence/android-native-017-authorized-20261128/native-run-02/emulator-start.json)、[实际renderer检查](../../evidence/android-native-017-authorized-20261128/native-run-02/runtime-renderer-checked.json)；boot完成待确认，App未安装，不能记为原生业务通过 |
| 本机合成后端 | 独立API仍仅 `127.0.0.1:53108`；App后续拟显式填 `http://10.0.2.2:53108` | 宿主回环别名可供后续验证；尚无App请求成功证据，不开放LAN/公网 |

授权例外仍仅为 `%USERPROFILE%\.android` 中默认ADB认证资料的正常读写，未扩大为整个Profile或任意缓存。已只读确认目录及父级不是意外reparse。Profile根目录既有console token只经正常只读链使用并在内存核对非空，没有新建、修改、输出或复制token；没有搬迁或复制旧ADB密钥。SDK、镜像、AVD、日志、缓存、crash数据库、TEMP/TMP和产物仍按受审配置落E；仅Emulator子进程移除HTTP代理，未改系统环境或防火墙。Windows不可控系统日志不被宣称为项目已证明零C写入。

渲染器窄复核核对了当前四个DLL的实际SHA、两个shader-cache回调直接返回，以及legacy ini/debug相对E工作目录的路径。它支持受控run02，不是完整二进制审计或Android功能验收。运行时如出现不同backend、Vulkan初始化、工作目录变化或未重定向的项目路径，应停止本次自有实例；不自动接受其他回退。后续安装、boot完成、登录与API闭环的实际证据须另行追加，不改写上述环境快照。

## 授权前检查点（保留）

**本轮结论：全E盘原生环境门槛未满足，按用户要求停止启动。ADB/模拟器命令执行0次，原生业务用例均待执行。** 本轮未修改App源码、依赖、配置或数据库，未重打APK。65画板、26组Web实测和319项自动回归保留其原范围，本轮不重跑或改记为Android通过。

## 1. 基线和当前产物

已阅读 [Pawch全流程记录](Pawch全流程前端验收记录.md)、[65画板验收表](pawch-65-acceptance.md) 和最终带R8映射的静态回执。原始静态误报不再触发构建。

| 对象 | 当前记录 | 验证层级 |
| --- | --- | --- |
| code8 APK | `E:\Doogy_ma\b\artifacts\dgy-NK37fh\doogy-preview-qa-arm64-x86_64.apk`；0.1.7/code8；50,478,783字节 | 文件和既有独立静态核对；未安装 |
| code8 SHA256 | `61b69e9de2a18f86096f8aa4b9a9c33f2028ae12fd320fb597578240797dcf57` | 本轮复核既有文件，未改包 |
| 包/架构 | `com.doogy.mobile.preview`；arm64-v8a＋x86_64；各21原生库 | 静态；本阶段目标x86_64 |
| code7升级来源 | `E:\Doogy_ma\b\artifacts\dgy-I1SGZR\doogy-preview-qa-arm64-x86_64.apk`；0.1.6/code7 | 同包名/签名、版本递增和权限条件已有静态证据；覆盖升级待验 |
| 原生结果 | 无AVD实际启动、无安装/升级、无冷启动/媒体/布局截图 | 0项原生通过；环境阻塞 |
| 软件基线 | 319/319自动回归、26组RN Web＋合成API/Worker流程、65页截图与人工审阅 | 前阶段既有证据；没有转记为本轮原生结果 |

最终静态回执：[code8-final-r8](../../evidence/pawch-full-20261128/android-qa-verification-code8-final-r8.json)。构建receipt的独立验签职责字段和首次原类名扫描误报均保留原样，最终静态回执已有通过结果，本轮没有为它们重新打包。

## 2. 当前环境门槛

| 项目 | 只读事实 | 当前状态 |
| --- | --- | --- |
| SDK/ADB | `E:\AndroidDev\Sdk`，Platform-Tools37.0.3；adb.exe SHA256仍 `bae5ce98846b19caa74a34900850caa8b21d01976932b2ad83baeb5de5651aee` | 工具文件存在；没有执行version等ADB命令 |
| E模拟器/镜像 | E SDK内无emulator程序和system-images | 缺少官方E盘组件；本轮未下载大组件 |
| AVD | E配置目录无有效config.ini；历史C盘API34/x86_64和旧E数据均未启动/复制/改写 | 实际AVD/API版本为未创建/未运行，API34/x86_64只是候选 |
| 默认认证目录 | 当前Windows系统Profile仍为 `%USERPROFILE%`；现有进程Home/Android目录/日志/临时目录已E | Windows ADB默认认证路径不能证明全E |
| 既有进程 | 检测到本轮之前启动的E adb.exe，PID25544，监听127.0.0.1:5037；本轮计划隔离端点5039无监听 | 未借用、查询设备或停止既有server；其认证目录未知 |
| 虚拟化 | CIM显示HypervisorPresent=true，不能由此证明WHPX实际可用 | 未运行加速探针，未改Windows特性/BIOS/系统 |

所有本轮新增文件、下载的公开源码、工具输出与临时目录落E。Windows自身不可控系统日志不被描述为项目已证明零C写入。没有读取/复制认证密钥内容，没有目录联接、Profile重定位、注册表/系统/防火墙修改，没有开放公网或LAN服务。

本机原始矩阵见 [只读审计说明](../../evidence/android-native-017-20261128/local-readonly-20261128T090945-f170abfe/local-environment.md)，稳定入口实际重跑的 [最新事实JSON](../../evidence/android-native-017-20261128/local-readonly-20261128T091734-529c2d96/local-environment.json) 仍为阻塞。可复用入口仅做只读核对与E证据输出，不执行ADB/模拟器，也不是解锁器：

```powershell
& E:\Doogy_ma\scripts\Audit-AndroidNative017.ps1
```

每次创建唯一E子目录，拒绝C输出或重解析路径；关键事实变化后标记requires_manual_review并撤下旧解释，始终start_authorized=false。[15项轻量自检](../../evidence/android-native-017-20261128/reuse-selfcheck-20261128T091734-459c976a/selfcheck.json)覆盖未来组件/AVD出现、关键事实变化、C目标拒绝和无原生启动命令；这是审计脚本自检，未增加319项App基线或原生通过数。

## 3. 哪些设置有效，哪些没有解决认证目录

本轮重新获取官方main元数据，固定为 `1cf2f017d312f73b3dc53bda85ef2610e35a80e9`；7份相关源文件与前轮SHA256全部相同。源正文与逐项摘要实际保存在 [official-review](../../evidence/android-native-017-20261128/official-review/source-retrieval-final.json)。首次Node直连失败记录保留，随后PowerShell HTTP成功；没有把获取失败当作源码通过。

| 设置/路径 | 已支持的作用 | 本轮判断 |
| --- | --- | --- |
| ANDROID_HOME/SDK_ROOT | SDK位置 | 可保持E；不覆盖ADB默认认证home |
| ANDROID_USER_HOME/ANDROID_EMULATOR_HOME/ANDROID_AVD_HOME | SDK偏好、模拟器配置、AVD搜索/数据目录 | 保持E仍不等于Windows ADB认证目录E |
| ANDROID_SDK_HOME/ANDROID_PREFS_ROOT | 部分旧SDK/Java/构建工具偏好 | 没有证据覆盖所核对的Windows ADB认证路径；不新增混用或重复试配 |
| 进程HOME/USERPROFILE | 子进程环境和部分工具home | 当前Windows ADB代码从系统Profile API取home，未使用这些变量作为Windows替代；没有再做只改HOME的试验 |
| ADB_VENDOR_KEYS | 额外认证密钥来源 | 初始化先加载/必要时生成默认用户key，vendor配置不能替代默认key目录；没有生成/复制密钥尝试绕过 |
| ANDROID_ADB_LOG_PATH、TEMP/TMP | 日志和已支持的临时路径 | 可保持E；不覆盖默认key或配对资料目录 |
| ADB_SERVER_SOCKET/ADDRESS/PORT | server端点隔离 | 不改变认证资料路径，也不能让既有server的未知写入位置变为合规 |

关键依据是 `adb_utils.cpp:275–319` 的Windows系统Profile分支、`client/auth.cpp:205–225,413–429` 的默认key初始化、`client/adb_wifi.cpp:97–153` 的known-hosts及其临时替换文件路径。官方变量文档支持SDK/AVD的目录设置，但不能据此推断ADB所有路径都随之改变。[Android目录变量](https://developer.android.com/tools/variables)、[固定版ADB目录源码](https://android.googlesource.com/platform/packages/modules/adb/+/1cf2f017d312f73b3dc53bda85ef2610e35a80e9/adb_utils.cpp)、[固定版认证初始化](https://android.googlesource.com/platform/packages/modules/adb/+/1cf2f017d312f73b3dc53bda85ef2610e35a80e9/client/auth.cpp)。

**修正旧审计的一项泛化：** `client/adb_client.cpp` 的 `adb_get_server_executable_path()` 与 `client/main.cpp` 中写 `adb.<port>` 均在 `__linux__` 条件编译内。不能把它列为Windows写C的依据。旧证据保留，本记录以Windows默认key/known-hosts路径作为阻塞理由，不沿用该错误。源码固定快照与本机二进制的一对一构建映射仍未建立；这是停止启动的证据边界，不是运行时文件写入追踪。

## 4. APK地址、运行模式与原生准备

两APK的实际Manifest/Hermes bundle已做只读提取，原始输出位于 [preparation](../../evidence/android-native-017-20261128/preparation/apk-public-defaults.json) 和 [APK配置对照](../../evidence/android-native-017-20261128/preparation/apk-config-comparison.json)，方法与16项准备矩阵见 [准备说明](../../evidence/android-native-017-20261128/preparation/README-原生验收准备.md)。两包实际默认region为cn，CN/Global地址均为空；未配置分支回退 `https://unconfigured.invalid`，preview编译为true。结论来自精确APK字节码的对象常量解码及同编译器反汇编，不只依赖TS源码或字符串命中。不能把主机候选地址或health成功写成APK已联通。

环境满足后，在App连接设置中明确选区域、配置模拟器宿主回环地址 `http://10.0.2.2:<独立合成API实际端口>`，通过App连接检查和原生实际请求确认；不重打包替换配置。主机API仍仅绑定127.0.0.1，不用0.0.0.0、LAN、USB或公网隧道。主机已有合成API的白名单health记录仅证明主机服务状态，未证明模拟器可达。

运行模式必须分别记录：`DATA_MODE=offline`指API/Worker不调用外部业务服务，客户端仍通过HTTP访问合成API；网络断开、API不可达或未配置是另一个测试场景，不能替代联通测试。两包实际Manifest为cleartext=true且未声明networkSecurityConfig，操作系统层没有仅本地域名白名单；本地HTTP限制由已编译App配置校验提供（localhost、127.0.0.1、10/192.168/172.16–31私网地址）。本次只配置模拟器宿主别名，不开放LAN。Launcher/内嵌bundle/updates关闭是静态条件；脱离Metro实际启动仍待验。

## 5. 待执行顺序与通过证据

先完成环境门槛，再执行以下阶段；任一步未通过，不进入后续原生差异或iOS：

| 阶段 | 关键步骤与证据 | 本轮结果 |
| --- | --- | --- |
| 新装 | 独立新x86_64 AVD安装现有code8；记录API/ABI/AVD、dumpsys版本、APK SHA；Metro不启动时从Launcher启动 | blocked_environment |
| API闭环 | App明确配置本机合成API并检查→登录→建宠→Today→保存带唯一标记的照护记录→UI返回重读与服务器recordId核对 | blocked_environment |
| 冷恢复 | force-stop/关闭任务后重开，不能点击Log out；确认SecureStore会话恢复、同一user/pet/recordId仍能从后端重读 | blocked_environment |
| 覆盖升级 | 另一个隔离AVD先装code7、创建会话与记录，再install -r code8；不卸载、不pm clear、不wipe-data，核对配置/会话/记录保留 | blocked_environment |
| 断网恢复 | 保留同一合成库，停止本次自有API或受控断开AVD网络；未确认保存/草稿保留→恢复→显式重试，后端只出现一条目标记录 | blocked_environment |
| 账号/宠物/权限 | 切宠切号无旧资料，viewer共享写禁用/API拒绝，owner撤权后重读清除来源；显式Log out后不自动恢复 | blocked_environment |
| 原生媒体 | 麦克风拒绝与允许、前台录音/离页停止；系统选择导入合成文件；实际可听播放另行记录听到声音及来源/时间 | blocked_environment |
| 界面差异 | 原SVG、键盘不挡输入/主操作、安全区、返回来源与硬件Back；不得把静态或Web截图充当原生图 | blocked_environment |

逐项记录模板及待执行命令在 [checklist README](../../evidence/android-native-017-20261128/checklist/pawch-onboarding-core-20261128-01/README.md)，机器模板为 [run-record.template.json](../../evidence/android-native-017-20261128/checklist/pawch-onboarding-core-20261128-01/run-record.template.json)。模板是准备产物，命令未执行。全部新装/升级用独立新AVD，不动旧AVD或业务库；截图/logcat保存E，日志不附认证token/密码。当前没有原生截图或logcat，原因是未启动，不能以桌面图补位。

准备包共有28项用例与65页原生覆盖行，全部NOT_RUN；已校对13个API字段中的35处方法/路径及README3处路径均有当前OpenAPI合同。准备阶段发现并纠正了草稿中不存在的`/weights`简称：实际体重/喂食同用`POST /api/v1/care-records`，通过type区分。只改准备文档，未改App或接口。包/媒体哈希、模板/链接校验在 [准备回执](../../evidence/android-native-017-20261128/checklist/pawch-onboarding-core-20261128-01/preparation-receipt.json)；本轮 [84项运行输入哈希](../../evidence/android-native-017-20261128/runtime-source-unchanged.json) 全部与现有code8源码清单匹配，确认没有修改产品输入。

## 6. 还缺什么与最小决定

首要缺口是受支持且经证实的全E认证路径，随后还缺E盘官方模拟器/一致的x86_64系统镜像、新隔离AVD，以及不改系统条件下的加速和运行验证。当前账户与已登记的普通Windows Profile均在C，没有现成E系统Profile可直接复用。没有把“允许某个C目录”假定为已经满足全部模拟器路径和WHPX条件。

在当前约束下保持停止。若希望在这台电脑继续，最小需决定：**是否为ADB默认认证资料允许一个明确的C盘例外**（当前系统Profile下 `.android` 的默认key及配对资料/必要临时文件；不搬迁或复制旧密钥，SDK、镜像、AVD、缓存、日志、临时与产物仍E）。这会变更用户的“不能写C”约束，尚未授权、未执行；即使允许，也要先重新审计其余模拟器写入和加速条件，不自动启动。若保持严格全E，则本机当前原生验收继续待验，需要提供已具备受支持全E条件的环境。

本轮不接真机、不做iOS适配/构建，不做云构建、上传、推送或发布；硬件、真实地图、走失外发与AI仍按原边界。
