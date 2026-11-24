# DOOGY Android App

React Native + TypeScript + Expo 客户端，Android 优先，iOS 后续。当前源码版本为 0.1.3 / Android versionCode 4。此目录用于协同开发，保留现有业务和硬件标准合同，不包含本机配置、依赖缓存、数据库、生成的原生工程或历史 APK。

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

`mobile/start.bat` 缺依赖时先执行 npm ci，类型检查失败即退出，再启动 Metro。APK 入口复制当前源码到项目外的短英文目录，检查后 fresh prebuild、Gradle 构建；失败不会交付旧包。生成路径、测试签名、公开地址注入及校验要求见 [APK 说明](docs/android-apk.md)。iOS 原生编译需要 macOS/Xcode、签名与相应终端，Windows 上创建源码不等于完成 iOS 验收。

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
