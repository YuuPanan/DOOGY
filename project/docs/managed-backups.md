# 托管备份、轮转与自动执行

托管入口在现有 SQLite 在线快照和 PostgreSQL 原生归档之上保存完整备份包，并只轮转它自己完成、可校验的产物。两种数据库和 offline/API 模式继续独立选择，不增加云端服务或 npm 依赖。原有 `data/backups/` 手工备份、现有配置及源数据库不会被托管轮转覆盖或删除。

## 手动预览与备份

从项目根目录执行：

```powershell
# 预览在下一次成功备份之后可能轮转的旧包，不创建备份或托管目录。
./start.bat .env backup-plan
./start.bat .env.postgres backup-plan

# 生成并校验新包，成功后才轮转同一来源的旧托管包。
./start.bat .env backup-managed
./start.bat .env.postgres backup-managed
```

BAT 先同步依赖并构建最新源码，再执行维护并退出，不启动 API/Worker。`npm.cmd run backup:managed` 提供默认 `.env` 的相同手动入口；预览使用 `npm.cmd run backup:managed -- preview`。命令直接使用所选数据库访问权限，不需要用户 Bearer，也不调用外部业务供应商。

源数据库只读。SQLite 使用在线备份接口，覆盖已提交 WAL；PostgreSQL 复用同一导出快照上的 `pg_dump` 和表内容清单。工具不会为了读取删除日志而迁移源库。PostgreSQL 源须已通过正常启动或 `prepare-db` 应用当前结构，客户端权限及 `PG_TOOLS=docker/native` 要求沿用 [数据库操作说明](database-operations.md)。

## 配置和自动执行

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `MANAGED_BACKUP_ENABLED` | `false` | 是否由运行中的 Worker 自动检查备份；手动入口不受此开关限制 |
| `MANAGED_BACKUP_DIRECTORY` | `./data/managed-backups` | 托管根目录，默认位于 Git 排除的本地 data 下 |
| `MANAGED_BACKUP_KEEP_COUNT` | `7` | 每个来源成功备份后保留的完整包数量，1–365 |
| `MANAGED_BACKUP_INTERVAL_HOURS` | `24` | 自动备份间隔，1–720 小时，以最近成功包为准 |

程序不会覆盖现有 `.env`。确认保存位置与保留数量后，由操作者在对应配置中启用：

```dotenv
MANAGED_BACKUP_ENABLED=true
MANAGED_BACKUP_DIRECTORY=./data/managed-backups
MANAGED_BACKUP_KEEP_COUNT=7
MANAGED_BACKUP_INTERVAL_HOURS=24
```

Worker 每分钟检查一次，使用独立子进程执行备份，不在遥测处理循环中等待整个快照或归档完成。自动间隔按最近完成清单的创建时间判断，不是对已有包的持续 checksum 巡检；失败没有完成清单，不推进该间隔，也不会因此轮转旧包。停止 Worker 时只管理本次创建的备份进程。

自动执行依赖 Worker 持续运行，不安装 Windows 计划任务，也不是停机时仍独立运行的系统备份服务。offline 仍可使用本机 SQLite 或 PostgreSQL 备份；它不自动配置 PostgreSQL、上传归档或改变业务模式。

## 产物与轮转边界

托管根目录按数据库来源身份分桶。SQLite 来源使用实际源路径，PostgreSQL 使用服务器、端口和数据库等连接目标；来源摘要不包含密码。不同数据库的产物和保留计数分开，修改源路径或目标数据库不会让工具接管原来源的手工文件。

每次备份使用独立目录，文件如下：

| 数据库 | 包内文件 |
| --- | --- |
| SQLite | `database.db`、`privacy-log.json`、`manifest.json` |
| PostgreSQL | `database.dump`、`database.dump.json`、`privacy-log.json`、`manifest.json` |

`database.dump.json` 是原 PostgreSQL 内容清单；`manifest.json` 是托管包完成标记，记录来源、创建时间、固定文件清单和内容校验信息，最后写入。没有完成标记的目录不能当作成功备份。

SQLite 仅在新副本上 checkpoint 并切换为 DELETE 日志模式，再计算独立 `database.db` 的摘要，源库的 WAL 模式和数据不变。新建托管根目录、来源桶和包目录请求权限 0700，包内数据库及私有清单文件使用 0600；已有目录权限不自动重设，Windows 的实际访问控制仍取决于目录 ACL。备份不做加密。

同一来源通过独立 `.lock.sqlite` 的本地文件锁协调并发。它只保存锁状态，不存业务数据、不把 PostgreSQL 业务改为 SQLite，也不锁住源数据库；进程退出后由操作系统释放锁。预览不创建该文件。自动任务取得锁后再次判断是否到期，其他任务占用时返回 busy，不重复生成备份。

轮转顺序为：新包成功完成 → 逐个校验旧包 → 保留本次包及最近的其他有效包 → 仅删除超出名额的有效旧包固定文件。损坏的较新包不会占用有效包的保留名额；时钟倒退也不会让本次刚成功的包被立即删除。未知来源、缺失/损坏清单、内容校验失败、额外文件、符号链接或未完成目录保留供人工检查，不递归接管删除。被保护的异常产物可能使磁盘上的目录总数超过 KEEP_COUNT；不能把该值理解为强制磁盘配额。

预览检查包的结构与清单，列出当前完成包及“下一次成功备份后”的候选清理范围；它不重算所有归档内容的散列，也不执行轮转。实际保留和删除须经过内容校验，所以预览候选不等于最终实删清单。备份失败时旧包保留；中断留下的未完成目录不会参与之后的完成包轮转。需要人工处理异常产物时，先核对实际路径和内容，不能用删除整个托管根目录的方式释放空间。

## 删除日志与恢复

包内 `privacy-log.json` 保存备份打包时可读取的注销、共享删除、所有权交接及照护软撤回记录，格式与现有删除重放工具一致。照护撤回日志不保存原作者或理由，旧快照补状态的限制见 [care-withdrawal.md](care-withdrawal.md)。它只覆盖导出时刻，不能代表未来仍然最新；源库后续新增删除/撤回不会改写已有包。恢复旧包重新开放服务前，仍需取源库最新删除日志重放。

日志内部 `sha256` 覆盖文件原始 receipts 数组的序列化结果，格式校验不会通过重排对象键来改变该校验输入；整个日志文件的摘要在 `manifest.files` 中。验收报告分别使用 `privacy_receipts_sha256` 和 `privacy_file_sha256` 标明范围，不能将内部摘要直接与 Get-FileHash 的整文件结果比较。

恢复前先用命令返回的完整包目录核对文件摘要；尤其 SQLite 原恢复命令检查数据库完整性和外键，不会自动读取托管清单中的文件摘要：

```powershell
$bundle = '托管命令返回的完整包目录'
$manifest = Get-Content -LiteralPath (Join-Path $bundle 'manifest.json') -Raw | ConvertFrom-Json
foreach ($item in $manifest.files) {
    $file = Join-Path $bundle $item.name
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) {
        throw '备份文件摘要不一致，停止恢复'
    }
}
```

SQLite 从包内 `database.db` 恢复到不存在的新路径；PostgreSQL 将 `database.dump` 与同目录的 `.json` 清单一起交给原生恢复命令，目标必须是不存在的新数据库。步骤沿用 [数据库备份与恢复](database-operations.md)，托管入口不自动替换源库、修改 `.env` 或开放恢复副本。

恢复保持独立配置、`DATA_MODE=offline` 和 API/Worker 停止状态，先应用恢复库结构迁移，再重放最新删除日志、核对设备凭证和家庭/库存保留策略，最后启动验收。包内日志可作为截至打包时的恢复材料；若最新源库和日志均丢失，不能据此宣称已恢复备份之后的全部删除事实。

备份包包含账号资料、认证状态和精确位置，是私有恢复材料。内容摘要用于检查损坏，不证明来源，也不等同于加密。仅恢复可信产物；存储访问、加密、异地副本和正式恢复目标需按部署要求另行安排。

## 适用边界

托管轮转只覆盖本工具创建且通过检查的备份包，不删除手工归档、外部副本或用户导出，不代表介质擦除、云端PITR或生产RPO/RTO已验证。备份I/O可能与业务竞争，容量和恢复目标需在实际部署环境记录。
