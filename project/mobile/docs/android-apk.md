# Android APK 构建与使用

本说明对应当前 `scripts/build-android.cjs`。仓库只分发源码；需要使用本机工具链重新构建，不引用旧开发机 APK、摘要或历史回执。

## 准备

1. 从项目根目录和 mobile 分别执行 `npm.cmd ci`，保留两个 package-lock.json。APK 入口要求本机锁定依赖已安装，不会隐式安装。
2. 在当前 PowerShell 配置自己的 JDK 17 和 Android SDK 37，见 [工具链](android-toolchain.md)。`JAVA_HOME` 指向 JDK 根目录，不是 bin；`ANDROID_HOME` 指向 SDK 根目录。
3. 选一个项目目录之外、短英文且无空格/特殊 shell 字符的构建根目录。脚本默认 `E:\AndroidDev\b`，可传入自己的绝对路径，不要求复用原开发机目录。

## 执行入口

在 mobile 目录运行：

```powershell
npm.cmd run check
npm.cmd run apk:android -- E:\AndroidDev\b
# QA 请求 ARM64 与 x86_64；可将示例构建根换为自己的目录。
npm.cmd run apk:android:qa -- E:\AndroidDev\b
```

脚本按以下顺序执行：

1. 检查 JAVA_HOME、ANDROID_HOME、锁文件和已安装依赖版本。
2. 建立独立的 `dgy-<随机值>` 源码快照，排除 `.env*`、私钥、旧原生输出和缓存，记录非node_modules运行输入清单。
3. 类型检查 → fresh Android prebuild → Gradle `assembleRelease`。
4. 核对本次非空APK、fresh生成的版本/code及运行输入未变化，在本次快照内暂存APK、源码清单和receipt；写齐并核对摘要后，整体移入不存在的新artifacts子目录。

默认只请求 arm64-v8a，QA 请求 arm64-v8a、x86_64。构建退出非零即停止，不交付旧包；失败快照保留供排查，脚本不按端口或进程名清理其他项目。脚本不会自动安装 APK。

## 产物与签名

实际输出在所选构建根目录下：

```text
<build-root>/artifacts/dgy-<随机值>/doogy-preview-arm64.apk
<build-root>/artifacts/dgy-<随机值>/doogy-preview-qa-arm64-x86_64.apk
<build-root>/artifacts/dgy-<随机值>/receipt.json
<build-root>/artifacts/dgy-<随机值>/source-manifest.json
```

两种命令只产生各自请求的 APK。包名为 `com.doogy.mobile.preview`，使用 Android debug 测试签名并内嵌 JS，不依赖 Metro 运行。它不是生产签名/商店发布流程；脚本回执的独立验签状态为未执行，不能把复制摘要核对当成 apksigner 验签或终端兼容验证。

交付前另用 Android Build Tools 的 apksigner、aapt2 等检查签名、版本、权限、ABI 和内嵌资源，再在目标设备安装。保留本次生成的摘要与运行证据；新的源提交应建立自己的验收记录，不复用旧 APK 数字。

源码清单按现有复制白名单和过滤规则列出非node_modules输入的相对路径、字节数和SHA-256，另记实际构建脚本摘要及三项允许进入App的公开API根地址。Git可用时记录HEAD和dirty；ZIP或无Git时这两个字段为null，构建仍可继续。HEAD只说明仓库上下文，dirty=true时须以本次文件摘要判断具体来源。依赖仍按锁文件核对版本，源码摘要不等于逐字节验证node_modules。

清单与构建前输入、独立快照在复制后和各构建阶段复核；运行文件增删改或构建脚本改变会失败，不生成可交付回执。receipt保留已有字段，新增清单文件名/SHA及从fresh `build.gradle` 读取的App版本/code；生成值仍需aapt2独立核对，不替代验签或安装升级。

制品暂存在本次 `dgy-*` 快照内，任何复制、清单/回执写入或摘要检查失败，都不创建本次最终交付目录；失败快照和暂存文件保留供排查。整体移动前复核artifacts真实路径仍在选定构建根内，并拒绝已有目标目录，不能覆盖历史制品。

## 连接后端

APK 构建显式禁用 dotenv，不把 `mobile/.env` 拷入快照。若需要预填公开后端地址，在构建终端设置相应变量，或安装后在 App 中填写：

```powershell
$env:EXPO_PUBLIC_CN_API_URL = 'http://192.168.1.10:3000'
$env:EXPO_PUBLIC_GLOBAL_API_URL = ''
npm.cmd run apk:android -- E:\AndroidDev\b
```

示例为 preview 局域网地址，应替换为自己可达的服务器根地址，不加 `/api/v1`、用户名、密码或查询参数。公开地址会进入 App，不可放入密钥。正式 production 配置要求区域 HTTPS 地址，不能启用本地 HTTP。

电脑运行根目录 `start-app-demo.bat` 可建立独立合成演示；实际手机需能访问电脑，`10.0.2.2` 仅用于 Android 模拟器。App 检查连接后，演示账号入口由后端能力决定；offline 仍需后端在线。更多步骤见 [移动 README](../README.md) 与 [演示说明](../../docs/app-demo.md)。

## 验收边界

构建成功、ABI 请求、原生 SDK 桩、模拟器及真机分别验收。麦克风授权与实际录音、系统选图/文件、可听输出、视频编码和前后台生命周期需目标终端验证。真实 BLE、设备命令、外部模型、推送/邮件/联系人送达、地图和 SSO 需要单独接入与授权，不由 preview APK 自动启用。
