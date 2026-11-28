# DOOGY 0.1.7 纯净源码

包含 Pawch 移动端、NestJS API、独立 Worker、SQLite 与 PostgreSQL/PostGIS 迁移、合成数据种子和回归测试。移动端版本为 0.1.7，Android 对应 code 8。源码位于 [project](project/)。

## Windows 本机运行

将仓库检出到 E 盘。首次运行需要 Node.js 24（至少 24.3）、npm、FFmpeg 和 ffprobe。已装好的运行工具可以放在本目录的 `tools/node`、`tools/media`，也可以在 PowerShell 中指定同一 E 盘上的现有目录。下面的路径是示例。

```powershell
$env:DOOGY_NODE_DIRECTORY = 'E:\nodejs'
$env:MEDIA_TOOLS_DIRECTORY = 'E:\ffmpeg\bin'
. .\Use-LocalEnvironment.ps1
npm.cmd --prefix project ci --no-audit --no-fund
npm.cmd --prefix project/mobile ci --no-audit --no-fund
.\Start-DOOGY.cmd
```

终端出现 `API ready` 和 `DOOGY worker started` 后，打开 [本机预览](http://127.0.0.1:54017/)。在登录页检查连接后可填入合成演示账户。按 Enter 停止本次 API 与 Worker。重启后继续使用此副本生成的合成数据。

Android 内测包在配置好的模拟器内使用 `http://10.0.2.2:54017` 连接本机 API。如需从源码构建安装包，按 [Android 构建说明](project/mobile/docs/android-apk.md) 配置 SDK 和签名。

仓库维护源码、锁文件与启动脚本。依赖和编译输出在本机生成。APK、运行二进制、运行记录、数据库和私有配置保留在各自的本地环境。已有本机交付目录可直接使用 [使用说明](README-先读.md)。
