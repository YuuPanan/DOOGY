# PostgreSQL/PostGIS 运行与迁移

当前在原 NestJS 后端中增加真正的 PostgreSQL 驱动和 PostGIS 空间计算，SQLite 离线路径继续保留。两个驱动共用业务服务和异步数据访问合同，不使用同步子进程查询桥接，也不通过内存仿真代替 PostgreSQL。

## 1. 数据库驱动与业务模式独立

| 配置 | 含义 |
| --- | --- |
| `DB_DRIVER=sqlite` | 使用 `DB_PATH` 本地文件，缺省仍为 SQLite |
| `DB_DRIVER=postgres` | 使用 `DATABASE_URL`，连接失败时明确停止，不自动降级到 SQLite |
| `DATA_MODE=offline` | 使用合成/本地输入及模拟推送，不调用外部业务供应商；可搭配本机 PostgreSQL |
| `DATA_MODE=api` | 使用实际设备/供应商和推送配置；不自动改变数据库驱动 |

只有数据库位置改变，不会自动申请供应商账号、接入 MQTT 或配置真实推送。现有 `.env` 不会被迁移命令覆盖。

## 2. 启动独立本地 PostgreSQL

要求 Docker Engine 正常运行。在项目根目录执行：

```powershell
docker compose -f compose.postgres.yml up -d --wait
```

Compose 使用 `postgis/postgis:17-3.5`，默认在 `127.0.0.1:55432` 提供 PostgreSQL，数据库/用户为 `doogy`，本地开发密码为 `doogy-local-dev`。数据保存在 DOOGY 专用命名卷，启动不会操作其他项目的数据库或端口。可通过 `PG_PORT/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD` 调整本地配置。

本地示例不是生产凭据或生产部署方案。不要使用 `down -v` 删除已有数据卷来解决迁移失败。

优先使用独立的 PostgreSQL 配置文件，保留原 `.env` 的 SQLite 设置：

```powershell
if (!(Test-Path .env.postgres)) {
    Copy-Item .env.postgres.example .env.postgres
}
./start.bat .env.postgres
```

`.env.postgres` 被 Git 排除；首次使用时按上面的检查从模板复制，保留已有配置，不覆盖其内容。示例关键字段为：

```dotenv
PORT=3002
HOST=127.0.0.1
DB_DRIVER=postgres
DATABASE_URL=postgresql://doogy:doogy-local-dev@127.0.0.1:55432/doogy
DATA_MODE=offline
```

`start.bat` 支持可选环境文件参数，每次先构建，再执行 `prepare-db` 检查所选驱动、连接和结构，成功后才启动 API/Worker。首次连接会应用 `db/postgres/*.sql`；权限不足、扩展不可用、凭据错误或服务未就绪会明确失败，不启动另一套 SQLite 数据库。

使用示例配置时，健康检查为 [http://127.0.0.1:3002/api/v1/health](http://127.0.0.1:3002/api/v1/health)，Swagger 为 [http://127.0.0.1:3002/docs](http://127.0.0.1:3002/docs)。实际地址以启动窗口输出为准；不要为释放端口结束无关项目服务。

结束使用时先按 Enter 停止 API/Worker；需要停止本地数据库再执行 `npm.cmd run postgres:stop`，该命令保留数据卷。

## 3. 保留 SQLite

继续使用本地文件只需：

```dotenv
DB_DRIVER=sqlite
DB_PATH=./data/doogy.db
DATA_MODE=offline
```

本机原 `.env` 保持 SQLite，运行 `./start.bat` 或 `./start.bat .env` 即按该文件启动。SQLite 不需要 Docker 或 `DATABASE_URL`。使用哪个业务模式、哪个数据库由操作者分别选择，脚本不会悄悄覆盖模式或原始数据库。命令行环境变量仍可能覆盖环境文件中的同名值，临时 PostgreSQL 验证建议在独立终端执行。

## 4. 将现有 SQLite 数据导入 PostgreSQL

**导入目标必须为空。** 源库与目标库由本次配置明确指定；源码包不提供已有业务数据库，也不假定任何本机数据库已完成导入。首次复制之后两个数据库不会自动保持同步。

下面流程供新的迁移使用，须选择新的空目标；不要清空已有 `doogy` 数据库重做。

先停止源 SQLite 的 API/Worker，避免一致性快照完成后仍有新写入留在旧库。在 SQLite 配置下用现有 `db:backup` 保存源快照；迁移工具本身始终只读 SQLite，不清空或覆盖它。

源库建议先由当前SQLite应用完成增量迁移，最新为034；当前61表源保留各模块元数据、原内容、来源和校验信息。导入兼容支持的已知旧表集，缺少的新表或字段按其保存版本处理，不能把未提供内容推断为已有数据。

目标必须是没有业务数据的专用数据库。已经运行过 PostgreSQL 演示或写入过测试数据的库会被拒绝，不自动 TRUNCATE。需要新目标时可创建独立数据库，例如：

```powershell
docker compose -f compose.postgres.yml exec postgres createdb -U doogy doogy_import
$env:DATABASE_URL = 'postgresql://doogy:doogy-local-dev@127.0.0.1:55432/doogy_import'
npm.cmd run db:import-postgres -- ./data/doogy.db
```

这个命令不要求把现有 `.env` 的 `DB_DRIVER` 先改为 postgres；导入工具显式选择 PostgreSQL 目标。成功输出每张表的行数、校验摘要和总行数，不打印数据库密码、设备密钥、坐标或账号令牌。

导入过程：

1. SQLite 以只读事务建立一致性快照，检查完整性、外键和当前结构。
2. PostgreSQL 初始化目标结构，在单个事务内确认所有业务表为空。
3. 当前 61 张业务表按依赖顺序分批复制，保留 ID、时间、身份散列、绑定历史、业务事件、队列、策略和附件；旧 37/39/40 表源缺少的新表留空，有顺序意义的记录保留源插入顺序。
4. 每批按主键重新读取目标，将所有源字段逐值规范化后做 SHA-256 核对，再检查表行数。
5. 活动触发器产生的临时版本会替换为源版本，然后导入摘要/观察快照，避免污染缓存证据。
6. 任意校验、约束或空间数据错误使整次导入回滚，目标结构保留但业务数据不留半份；源库保持不变。

PostgreSQL 自身的迁移历史独立记录，不导入 SQLite 的迁移文件名，因此不能通过两个 `migrations` 表的行数判断数据迁移是否正确。

成功后先在新的独立环境文件中设置 `DATA_MODE=offline`、独立 API 端口和已验证的 `DATABASE_URL`，使用 `start.bat 该环境文件` 验证目标。检查账号登录、宠物/绑定、轨迹、围栏、照护、分享/诊断授权和待处理任务。不要同时让旧 SQLite 与新 PostgreSQL 承接真实写入，也不要把切换配置等同于双库同步。

验收期间尚无新写入时可切回原 SQLite 文件；PostgreSQL 已接收新业务后，原 SQLite 已过时，不能只改驱动就声称无损回退，需要单独处理新增数据。

## 5. 数据与空间实现

- 保留既有 TEXT 身份、UTC ISO 时间和 JSON 文本列，以及 0/1 标志，维持接口序列化与迁移前查询语义。该选择不等于已经改为原生 UUID、timestamptz 或 JSONB 存储。
- PostgreSQL 建立外键、启动序列幂等键、活跃绑定唯一约束和原有权限/来源版本触发器。
- `locations.__position` 为生成的 WGS84 geography 点，`geofences.__shape` 为生成的 geometry；圆形保存中心和半径，多边形确保闭合，并建立 GiST 索引。
- PostgreSQL 围栏使用 `ST_Distance` 的米制距离和 `ST_Covers` 的边界包含判断；SQLite 继续使用本地几何函数。空间内部列不作为业务 API 字段返回。
- PostgreSQL 椭球距离与本地近似可能在边界附近存在数值差异，不能把一次本地对比当作真实设备精度或误报率验收。
- 事务固定在同一连接，通过事务级 advisory lock 保留早期串行写语义。它保持现有多步业务、幂等与队列的一致性，但会限制并行写吞吐；多个连接的正确性不能代替容量结论。负载运行方法见第 8 节，资源级行锁细化、分区与持续高吞吐仍需后续验证。

PostgreSQL 初始结构对应 SQLite 001–013；`db/postgres/002-restore-spatial-function.sql` 固定围栏空间函数的 `search_path`，SQLite 不受此 PostgreSQL 专属修复影响。当前 PostgreSQL `003-location-device-index.sql` 与 SQLite `014-location-device-index.sql` 同步添加设备定位时间索引。以后新增业务结构变更要给两个驱动提供相应增量迁移，不要修改已应用的初始文件来冒充新迁移。

迁移文件按驱动独立编号执行，最新SQLite034、PostgreSQL023，当前61张业务表。保留已应用迁移，新增结构使用新文件。旧归档先按保存版本和表集核验，再增量升级。恢复缓存按原created_at和当前窗口判断，不重置期限；旧快照不包含之后的轮换/吊销、删除与撤回事实，重新开放前须重放最新删除日志并核对凭据。参见 [照护撤回](care-withdrawal.md)、[隐私恢复](privacy-lifecycle.md) 和 [凭据](device-credentials.md)。

## 6. 实际测试

首选运行专用测试命令，自动构建并从 `.env.postgres` 的 `DATABASE_URL` 或优先指定的 `TEST_DATABASE_URL` 选取连接：

```powershell
npm.cmd run test:postgres
```

测试账号需要创建/删除专用测试数据库及安装 PostGIS 的权限。该命令没有可用连接时明确失败；普通 `npm.cmd test` 若未设置 `TEST_DATABASE_URL`，PostgreSQL 专项测试会标记跳过，不能当作已测成功，执行范围见 [验收清单](acceptance.md)。

用例创建名称带 `doogy_test_`、`doogy_backup_test_`、`doogy_concurrency_test_` 或 `doogy_http_` 前缀的随机独立数据库，只清理自己创建且名称经核对的测试库，不清空配置 URL 所指业务数据库。

专用runner同时执行健康观察单元链路与App合成演示HTTP用例，使用共用fixture的部分会在真实PG上运行；App启动器等明确使用SQLite的检查仍保留自身驱动。托管PG备份用例覆盖原生dump→独立库restore→备份后的照护撤回/宠物删除最新日志重放→幂等复读→同源轮转，不只检查归档文件存在。

存储专项在真实 PostgreSQL/PostGIS 上覆盖：

- 真实圆形/多边形/边界空间计算、GiST 索引、幂等、事务回滚、两个独立 Worker 连接和通知闭环。
- 活动版本/缓存失效及成员撤权后分享、诊断永久失效的触发器。
- SQLite 当前 61 表导入逐字段核对，保留访问会话、队列、策略、照护和附件内容，兼容旧表集并拒绝非空目标。
- 旧 013/015、37 表源库只读导入，新增生命周期表为空、旧账号未注销。
- 不合法空间数据使整次迁移回滚，源 SQLite 保持原值。

HTTP 场景使用同一套断言，可通过 `TEST_E2E_POSTGRES=1` 切换到独立 PostgreSQL 测试库；照护编辑/撤回与设备命令幂等、库存保留、绑定隔离及隐私生命周期共用该路径：

```powershell
$env:TEST_E2E_POSTGRES = '1'
$env:TEST_DATABASE_URL = 'postgresql://doogy:doogy-local-dev@127.0.0.1:55432/doogy'
node --test dist/test/postgres.test.js dist/test/postgres-backup.test.js dist/test/managed-backup-postgres.test.js dist/test/postgres-concurrency.test.js dist/test/reporting-idempotency-postgres.test.js dist/test/reporting-idempotency-e2e.test.js dist/test/care-withdrawal-e2e.test.js dist/test/inventory-retention-e2e.test.js dist/test/privacy-e2e.test.js dist/test/privacy-maintenance.test.js dist/test/account-export-e2e.test.js dist/test/device-credentials-e2e.test.js dist/test/operations-e2e.test.js dist/test/e2e.test.js dist/test/development-e2e.test.js dist/test/pilot-e2e.test.js dist/test/api-mode.test.js
Remove-Item Env:TEST_E2E_POSTGRES, Env:TEST_DATABASE_URL
```

## 7. PostgreSQL 备份与恢复

`npm.cmd run db:backup` 仅用于 SQLite，在 `DB_DRIVER=postgres` 时明确拒绝，不能把 `DB_PATH` 指向的旧 SQLite 文件当成当前 PostgreSQL 备份。`db:restore` 也只是 SQLite 文件恢复工具，不会恢复 PostgreSQL。

新增 PostgreSQL 专用 CLI，读取 `.env.postgres` 并保留原 `.env`：

```powershell
npm.cmd run build
npm.cmd run postgres:backup -- ./data/backups/recovery-drill.dump
npm.cmd run postgres:restore -- ./data/backups/recovery-drill.dump doogy_recovery
```

默认 `PG_TOOLS=docker` 使用本项目 PostGIS 容器内的工具，仅接受 `127.0.0.1` 且核对 Compose 当前实际发布的数据库端口；连接其他服务器时使用 `PG_TOOLS=native`，在 PATH 中安装兼容的 `pg_dump/pg_restore`。归档为 PostgreSQL 自定义格式，配套 `.json` 清单记录 SHA-256、当前61张业务表的行数和内容指纹以及迁移历史，备份读取同一导出快照；旧归档按保存版本核验其 37/39/40 表及当时字段。

恢复仅接受尚不存在的新数据库名；已有数据库即使为空也不会清空或覆盖。工具从 `template0` 创建新库，恢复后核对内容、顺序与迁移历史，捕获失败时只清理本次创建的目标。命令不自动修改配置或替换当前数据库。演练时用独立 `.env.recovery` 设置 `DATA_MODE=offline`，再运行 `start.bat .env.recovery`，避免恢复的待发送任务访问真实外部服务。

有备份后注销、删除或照护撤回时，先保持恢复副本不开放 API/Worker，在 offline 配置下执行 `start.bat .env.recovery privacy replay-log 最新日志文件`，再核对权限、保留策略、照护状态和设备凭证。步骤与限制见 [privacy-lifecycle.md](privacy-lifecycle.md)；历史归档不自动清除。

`start.bat .env.postgres backup [归档路径]` 和 `start.bat .env.postgres restore <归档路径> <新数据库名>` 提供相同维护入口，先同步依赖、编译，再执行命令；成功后直接退出，不启动 API/Worker。

需要自动检查和同源托管包轮转时，可执行 `start.bat .env.postgres backup-plan` 或 `backup-managed`，并按 [托管备份说明](managed-backups.md) 配置默认关闭的自动执行。托管入口仍复用原生 PostgreSQL 备份，包内保留 `.dump` 与内容清单，源库不因备份而自动升级；现有手工归档不接管轮转。

详细步骤、权限与归档保存要求见 [database-operations.md](database-operations.md)，实际执行结果见 [acceptance.md](acceptance.md)。这是单库逻辑备份，不包含集群角色管理、异地副本或云端 PITR；备份权限、存储加密、保留、恢复点和恢复时间需在正式部署前确定。

本机数据库、现有 SQLite 导入及软件合同验证不代表生产迁移放行、月度可用性或真实硬件集成验收；PostgreSQL 本地恢复的验证范围以验收记录为准。

## 8. 并发与性能复验

```powershell
npm.cmd run postgres:perf
```

`start.bat .env.postgres perf` 提供先同步依赖和编译的入口。工具创建独立随机 PostgreSQL 数据库，用合成数据和 offline 模式运行真实 HTTP、API 与 Worker 负载，结束时清理自己创建的库和进程。现有 `doogy`、恢复库、配置和 SQLite 离线文件继续保留。

工作负载、P95 口径、实际报告和已验证范围见 [performance.md](performance.md)。当前全局写事务锁继续保留；多 Worker 运行主要验证领取/处理正确性，吞吐结论须结合该负载下的实际测量，不能推断为已经移除写串行瓶颈。

1/3 Worker 的已接收事件到投影完成 P95 分别为 9,798/7,224ms；1 Worker 余量很小，最大值为 10,104ms。该指标使用提交前记录的 `processed_at` 作为应用投影代理，另用已提交查询核对告警与最终状态；不等于 WAL 或提交确认延迟。结果不能直接推广为生产持续吞吐、可用性或真实手机提醒结论。
