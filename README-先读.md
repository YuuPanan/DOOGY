# DOOGY 0.1.7 纯净版

这是面向本机 Windows x64 的独立开发与体验目录。源码来自当前 DOOGY 工作区，包含 Pawch 界面、NestJS API、独立 Worker、合成演示、两套数据库迁移、两份依赖锁及测试。移动端版本为 0.1.7，随附 Android 内测包为 code 8。

## 在本机运行

1. 双击 `Start-DOOGY.cmd`，等终端显示 `API ready` 与 `DOOGY worker started`。
2. 在本机打开 [DOOGY](http://127.0.0.1:54017/)。在欢迎页选择已有账户，展开连接设置，检查服务器连接后可填入合成演示主人或只读账户。
3. 在终端按 Enter 可停止本次 API 与 Worker。再次双击会重新编译当前源码，并接着使用本目录生成的合成数据。

同一个副本保留一个演示库。初次启动从种子生成于 `project/data`，其中可以添加测试宠物与照护记录。需要另一套干净数据时，使用另一份独立副本。默认端口有冲突时，可在本目录运行 `Start-DOOGY.cmd -Port 54018`，页面和 App 使用同一个新端口。

## Android 原生

`artifacts/android` 附同版本已签名的 ARM64 与 x86_64 测试 APK。使用本机已配置的 Android 模拟器测试，App 的服务器根地址填 `http://10.0.2.2:54017`，选择服务区域后检查连接。Windows 浏览器使用 `127.0.0.1:54017`。模拟器与 Android SDK 属于本机外部工具链，预览启动器只启动后端与 Web 预览。

Web 适合验证账户、宠物、照护、共享、安全、内容等页面及接口。录音、系统选择文件和授权播放器使用 Android App。当前硬件 BLE、真实地图、外部 AI、真实推送与外发仍按原版的未配置状态或合成演示运行。

## 目录与依赖

- `project/` 为完整项目源码。根目录与 `mobile/` 的 Windows 依赖已分别按锁文件独立安装。
- `tools/` 提供本机启动所需的 Node.js 24、npm、FFmpeg 和 ffprobe。供本机使用，工具来源见 `verification/runtime-inventory.json`，对外分发前请分别核对上游许可。
- `artifacts/` 收录 Android APK 及启动时编译的 Web 产物。`.runtime/`、`project/data/` 和各编译目录由本套程序生成，均在 E 盘。
- `verification/` 收录源码逐文件 SHA256、工具及 APK 哈希、安装与测试结果。源码快照覆盖项目文件，运行器和安装产物单列。

本目录未搬入原工作区的业务数据库、会话、环境密钥、签名、缓存或历史 Git 仓库。子目录中的历史交接文档仍保留它们记录的路径和验证口径。使用此纯净版时，以本页的一键入口为准。

如果需要从锁文件重装，请先在 PowerShell 中加载本目录的 `Use-LocalEnvironment.ps1`，再分别于 `project`、`project/mobile` 执行 `npm.cmd ci --no-audit --no-fund`。依赖下载、缓存和生成文件由本目录的进程环境定向到 E 盘。迁往其他操作系统时，携带源码与锁文件并在目标系统安装依赖。
