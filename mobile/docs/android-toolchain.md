# Windows Android 工具链

此文档说明协作者需准备的工具，不记录原开发机的安装流水账。使用自己的目录和环境；仓库不包含 SDK/JDK、许可、缓存或已生成原生工程。

## 所需工具

| 工具 | 当前工程要求 |
| --- | --- |
| Node.js | 24.x，与根 package.json engines 一致 |
| npm | 使用仓库 package-lock.json 执行 npm ci，不随意升级依赖 |
| JDK | 17；同时需要 java 与 javac |
| Android SDK | Platform 37、Build Tools 37.0.0、Platform Tools、Command-line Tools |
| 原生编译工具 | 锁定依赖使用 NDK 27.1.12297006、CMake 3.22.1，按生成工程实际要求核对 |
| Gradle | 使用 Expo fresh prebuild 生成的 wrapper，不用系统任意版本替换 |
| 运行终端 | 已授权的 Android 实体设备或匹配 ABI 的模拟器；构建不代表运行通过 |

Android Studio 或 SDK Command-line Tools 均可管理 SDK。首次安装由协作者阅读并接受安装器显示的许可；不自动代替接受。若锁定依赖要求额外 Build Tools 等组件，按 Gradle/SDK Manager 的实际提示补齐，不通过改版本绕过失败。

## 当前终端配置

以下路径只是示例，先替换为自己已经安装的目录。JAVA_HOME 必须指向含 bin/java.exe 的 JDK 根目录，ANDROID_HOME 必须指向含 platforms/build-tools/platform-tools 的 SDK 根目录。

```powershell
$env:JAVA_HOME = 'E:\AndroidDev\Java\jdk-17'
$env:ANDROID_HOME = 'E:\AndroidDev\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = 'E:\AndroidDev\Gradle'
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
$env:JAVA_TOOL_OPTIONS = "$env:JAVA_TOOL_OPTIONS -Dfile.encoding=UTF-8".Trim()

java -version
javac -version
Test-Path -LiteralPath "$env:JAVA_HOME\bin\java.exe"
Test-Path -LiteralPath "$env:ANDROID_HOME\platforms\android-37\android.jar"
Test-Path -LiteralPath "$env:ANDROID_HOME\build-tools\37.0.0\aapt2.exe"
```

这些设置只影响当前终端及其子进程，不要求覆盖系统 Java 或其他项目设置。自己的环境脚本可代替逐行设置；仓库没有要求协作者必须拥有某个本机绝对路径。若安装目录含空格，PowerShell 调用可执行文件时使用调用运算符与引号。

## 安装与检查

通过 SDK Manager 查看已安装项。命令行工具位于自己 SDK 的 cmdline-tools 目录；示例：

```powershell
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" --list_installed
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" 'platform-tools' 'platforms;android-37' 'build-tools;37.0.0' 'ndk;27.1.12297006' 'cmake;3.22.1'
```

根据实际许可证提示操作。安装完后重新检查，不并行启动多个 SDK 安装器，也不要删除其他项目正在使用的 SDK、NDK 或虚拟设备。

## 项目命令

先在项目根目录安装后端依赖，再进入 mobile 安装移动依赖：

```powershell
npm.cmd ci
cd mobile
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run apk:android -- E:\AndroidDev\b
```

构建根需要在项目之外、短英文且无特殊 shell 字符。现行 APK 入口检查工具路径、依赖锁、源码快照及失败结果；完整输出和签名边界见 [APK 说明](android-apk.md)。开发包编译安装使用 `npm.cmd run android`，已安装开发包再用 `npm.cmd start` 启动 Metro。

生成的 android/ios 工程、node_modules、Gradle/CMake 缓存与 APK 不属于纯净源码交付。修改原生依赖或配置插件后重新 prebuild/构建；iOS 编译需 macOS/Xcode 和签名，Windows 工具链不提供 iOS 原生验收。
