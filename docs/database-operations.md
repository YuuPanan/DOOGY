# 数据库备份与恢复

SQLite 与 PostgreSQL 使用各自的原生备份工具，命令均从项目根目录执行，使用 Node.js 24，先运行 `npm.cmd run build`。`db:backup/db:restore` 只处理 SQLite 文件；`postgres:backup/postgres:restore` 处理 PostgreSQL 自定义格式归档。数据库运行与迁移说明见 [postgres.md](postgres.md)。

本机原 `.env` 仍保存 SQLite 配置，`.env.postgres` 用于 PostgreSQL。使用 `./start.bat` 启动默认配置，使用 `./start.bat .env.postgres` 启动独立 PostgreSQL 配置；不要为切换数据库覆盖原文件。

当前结构为 SQLite034/PostgreSQL023、61张业务表。备份和导入保留安全事件关闭原因，旧来源未记录时留空。`support_tickets` 可保存无设备关联的绑定前求助，原生备份、恢复和导入会保留空关联及回复。附件元数据与 base64 正文随库保存，原生/托管备份无需另拷文件目录。导入兼容工具已知的旧表集及当前61表，旧源没有的新增表留空。PostgreSQL归档按清单保存的迁移版本和对应表集核验，恢复后由启动流程增量升级。功能验证见 [验收文档](acceptance.md) 和 [协作流程](process.md)。

账号注销、共享删除和照护撤回不会改写已有历史备份。恢复后的数据库只能先隔离使用；重新开放 API/Worker 前，用源库最新删除日志重放，并核对保留策略和设备凭证，见本文“恢复后的删除重放”。

幂等缓存恢复后仍按原创建时间和当前 `IDEMPOTENCY_TTL_HOURS` 判断是否到期，不因恢复得到新的重试窗口。可在开放前执行 `start.bat 恢复配置 privacy idempotency-preview`，核对后用 `idempotency-clean` 清理到期记录；重新提交过期键会作为新业务请求处理。命令幂等与缓存期限的区别见 [command-idempotency.md](command-idempotency.md)。

备份和导入保留缓存created_at，恢复后用当前保留窗口判断到期；API、Worker与维护命令使用一致配置。

恢复或导入保留照护修订、撤回与最小删除日志；旧版本缺少的字段按增量迁移处理。恢复开放前重放最新日志，不能从最小日志还原未保存的自由文字。

需要按来源保存备份包和轮转时，使用 [托管备份入口](managed-backups.md)：`start.bat 配置文件 backup-plan` 零写入预览，`backup-managed` 生成新包并在成功后轮转同源旧包。自动执行默认关闭；原有手工命令和 `data/backups/` 产物不加入托管轮转。包内删除日志仅截至打包时，仍需恢复前的最新日志。

## SQLite：创建快照

```powershell
npm.cmd run db:backup
```

默认读取 `.env` 中的 `DB_PATH`，未配置则使用 `data/doogy.db`；默认输出到 `data/backups/doogy-时间戳.db`。也可指定一个不存在的目标文件：

```powershell
npm.cmd run db:backup -- ./data/backups/manual-check.db
```

成功响应包含源/目标绝对路径、页数、创建时间以及 `integrity=ok`、`foreign_keys=ok`。源文件必须存在，不能是内存数据库。

`DB_DRIVER=postgres` 时，`db:backup` 会明确拒绝执行。即使 PostgreSQL 配置中保留了 `DB_PATH` 供迁移源使用，备份该旧文件也不等于备份 PostgreSQL 的最新数据。

工具使用 Node 自带的 SQLite 在线备份接口，覆盖已提交的 WAL 数据，不靠直接复制单个 `.db` 文件。参考 [Node.js SQLite backup 文档](https://nodejs.org/download/release/v24.12.0/docs/api/sqlite.html)。备份前后检查完整性、外键及 DOOGY 核心表；拒绝损坏或无关数据库。目标文件已存在时直接失败，不覆盖。

本地备份包含账号相关数据与精确位置，保存在被 Git 排除的 `data/` 下；它不是面向其他人的脱敏导出包。

## SQLite：恢复到新路径

```powershell
npm.cmd run db:restore -- ./data/backups/manual-check.db ./data/recovery-check.db
```

源备份经过校验后恢复到**不存在的新文件**，再次检查完整性和外键。命令不会替换当前数据库，也不会修改 `.env`。

恢复演练时另开 PowerShell，在项目根目录执行：

```powershell
$env:DB_PATH = './data/recovery-check.db'
$env:DB_DRIVER = 'sqlite'
$env:DATA_MODE = 'offline'
$env:PORT = '3001'
npm.cmd run start:all
```

使用 [健康检查](http://127.0.0.1:3001/api/v1/health) 和 [Swagger](http://127.0.0.1:3001/docs) 检查恢复库的数据。offline 防止恢复副本中的待发送通知被误投到外部服务。按 Enter 停止演练，关闭该终端即可撤销这组临时环境变量。

确认要切换正式使用的本地路径时，先停止原 API/Worker，再由操作者修改 `.env` 的 `DB_PATH` 指向已验收的新文件，保留原库作为回退。脚本不提供覆盖运行中数据库或自动删除原库的操作。

## PostgreSQL：备份与恢复到独立新库

这组工具使用 `pg_dump` 与 `pg_restore`，不通过 SQLite 文件复制 PostgreSQL。原 `.env`、`.env.postgres` 和当前运行数据库均不会自动切换。

### 准备客户端工具

PostgreSQL 命令读取 `.env.postgres`，进程环境中的同名变量优先。默认 `PG_TOOLS=docker`，使用本项目 PostGIS 容器内的客户端工具；先启动 Docker Engine 和 `npm.cmd run postgres:up`。该模式只接受 `127.0.0.1`，且连接端口须匹配本项目 Compose 当前实际发布的数据库端口；不匹配会停止，不会备份另一个数据库实例。连接其他 PostgreSQL 时选择 `PG_TOOLS=native`，在 PATH 中提供与服务器兼容的 `pg_dump`、`pg_restore`。

备份账号需要读取应用结构和数据；恢复连接还需创建新数据库及恢复 PostGIS 的权限。工具不创建集群账号，也不代替数据库权限配置。

源库须已应用当前 PostgreSQL 迁移。更新程序后先按正常流程启动一次，或在构建后执行 `node --env-file=.env.postgres dist/scripts/prepare-db.js`；备份工具只读校验源库，不自动替它升级结构。当前 `002-restore-spatial-function.sql` 固定空间函数的 `search_path`，确保 `pg_restore` 重建生成围栏列时仍能找到 PostGIS 函数。

### 创建一致性备份

```powershell
npm.cmd run build
npm.cmd run postgres:backup
```

也可以显式指定一个不存在的归档路径：

```powershell
npm.cmd run postgres:backup -- ./data/backups/recovery-drill.dump
```

成功后保存自定义格式归档及同名校验清单，例如 `recovery-drill.dump` 与 `recovery-drill.dump.json`，两份文件须一起保留。归档包含恢复业务所需的结构和数据；当前清单保存归档 SHA-256、41 张业务表的行数与内容指纹。清单不输出原始坐标、令牌或设备密钥。

清单格式为 `doogy-postgres-v1`，包含 `archive_sha256`、`tables` 中各表的 `table/rows/sha256`，以及独立的迁移历史。表内容分批核对并纳入有顺序意义的 `__sequence` 字段；生成空间列、函数、触发器和索引随原生归档恢复。

备份在同一导出快照上执行数据核验和 `pg_dump`，正在运行的 API/Worker 不必为生成备份停机。备份完成后的新业务写入不会自动进入该归档。已有目标文件会被拒绝，不覆盖旧备份；失败不会留下可当成完整备份使用的半份结果。

归档包含账号、位置及待处理队列，是数据库恢复材料，不能作为脱敏数据分享。手工命令默认存放在被 Git 排除的 `data/backups/`，不会自动轮转；可改用 [托管入口](managed-backups.md) 管理新的完整备份包。访问权限、加密、上传和异地副本仍需另行安排。仅恢复可信来源的归档，内容散列用于发现损坏，不能证明来源。

### 恢复并核对

```powershell
npm.cmd run postgres:restore -- ./data/backups/recovery-drill.dump doogy_recovery
```

第二个参数是同一 PostgreSQL 实例中**尚不存在的新数据库名**，不是文件路径。名称以小写英文字母开头，仅含小写字母、数字和下划线，最多 63 个字符，不能使用 PostgreSQL 维护库名。任何已存在的目标，即使没有业务数据，也会被拒绝。工具不会对原数据库执行覆盖、清空或删除。

恢复前检查归档和清单的一致性，再从 `template0` 新建数据库并执行 `pg_restore`，核对业务表、行数、内容指纹、顺序和迁移历史。成功后才返回核验通过；命令捕获恢复或核验失败时只清理本次创建的新库，不保留一份看似完成的半成品。源库和备份文件保留。

旧版本归档按清单保存的迁移版本和对应表集核验，随后应用当前增量迁移；不要求旧包预先包含新增表。未知或超出当前可识别版本的归档必须拒绝，不能跳过摘要、结构或外键核对。

设备凭证也恢复到快照时刻，快照后的轮换或吊销不会自动重放。早于凭证元数据的归档升级后使用 active/第一代的兼容默认值。恢复演练保持 loopback 与 offline；正式切换前核对或重新轮换设备凭证，不能把旧快照当成当前吊销名单。具体接口见 [device-credentials.md](device-credentials.md)。

也可让一键脚本同步依赖、编译后执行维护，不必手动先构建：

```powershell
./start.bat .env.postgres backup ./data/backups/recovery-drill.dump
./start.bat .env.postgres restore ./data/backups/recovery-drill.dump doogy_recovery
```

这两个维护入口成功后直接退出，不启动 API 或 Worker。省略 `backup` 后的文件参数时使用默认时间戳路径；指定其他环境文件时使用该文件的数据库配置。

### 在 offline 模式验收恢复副本

保留原 `.env` 与 `.env.postgres`，新建独立 `.env.recovery`；可复制现有 PostgreSQL 配置后只修改恢复库名、端口及业务模式。以下为本地默认开发配置示例：

```dotenv
PORT=3003
HOST=127.0.0.1
DB_DRIVER=postgres
DATABASE_URL=postgresql://doogy:doogy-local-dev@127.0.0.1:55432/doogy_recovery
DATA_MODE=offline
```

```powershell
./start.bat .env.recovery
```

启动后检查 [健康接口](http://127.0.0.1:3003/api/v1/health) 的 `database=postgres` 和 `mode=offline`，再验证原账号、宠物、绑定、最新定位、围栏和待处理任务。恢复副本可能包含未完成的通知与命令，因此演练使用 offline，避免向真实外部服务发送重复任务。按 Enter 只停止本次 API/Worker。

恢复副本重新开放前仍须重放源库最新恢复日志。`password_reset` 会使尚未包含该次重置的旧快照凭据失效；它不保存新密码材料，不能自动还原快照之后的新密码，需重新走 [密码找回](password-recovery.md)。含该receipt的新快照不会重复随机改密。不要仅因旧归档可登录就把快照之后已撤销的凭据视为仍然有效。

备份恢复工具不会自动更改配置或切换流量。决定正式使用恢复库时，先停止原实例，再修改应用配置并验收；原库与恢复库之间没有双向同步，恢复后也不会把新写入回流 SQLite。

备份必须读取当前实际承接业务的数据库，不能把切换后已过时的SQLite副本当作最新数据；切换和回退需核对新增写入并单独安排。

## 恢复后的删除重放

从仍可读取的源库导出最新日志，使用不存在的新文件路径：

```powershell
./start.bat .env privacy export-log ./data/backups/privacy-log-latest.json
# PostgreSQL 源改用 .env.postgres；恢复配置必须指向独立目标并设置 offline。
./start.bat .env.recovery privacy replay-log ./data/backups/privacy-log-latest.json
```

恢复副本的 API/Worker 应保持停止，先由维护入口应用结构迁移并重放，再通过正常启动验收。此流程对 SQLite 恢复文件和 PostgreSQL 恢复库相同；不能让 `.env.recovery` 仍指向源业务库。删除日志记录资源 UUID 和必要所有权转移上下文，不含密码、坐标或照护原文；`care_withdrawal` 不保存自由文本原因或操作者，仍应与受限恢复材料一起保管。

重放仅接受 `DATA_MODE=offline`，检查格式和 SHA-256，按时间顺序在事务中执行；已经存在的 receipt ID 不重复应用。日志内部 `sha256` 按文件原始 receipts 对象的序列化结果核验，格式校验不会改写摘要的输入；保留工具生成文件的原样结构。此摘要是内容完整性检查，不是来源签名，也不是整份 JSON 文件的摘要。重放不会改写旧归档，也不能替代设备轮换/吊销核对；恢复库的家庭和库存保留策略需要人工确认，再由 Worker 自动执行已启用策略。保留规则、关闭账号的匿名引用与共享备注边界见 [privacy-lifecycle.md](privacy-lifecycle.md)，无家庭原文及 signal 来源说明见 [inventory-retention.md](inventory-retention.md)。

源库及其最新删除日志均丢失时，工具无法知道备份之后发生过哪些删除，不能据此宣称完成删除重放。新托管包可按 [托管策略](managed-backups.md) 轮转；已有手工归档、异地副本与介质擦除仍需独立运维安排。

照护撤回日志对旧快照中仍有效的记录补写撤回时间，操作者为 `NULL`、原因为固定“恢复撤回记录”，保留旧历史并写系统审计；不会伪造原作者的撤回前修订。已撤回或不存在的记录不重复处理。新快照可保存真实撤回字段和历史，旧快照加日志只恢复撤回状态；验收恢复库时应读取单条照护/历史与 `status=all` 列表，确认默认列表和体重计算已经排除撤回记录，详见 [care-withdrawal.md](care-withdrawal.md)。
