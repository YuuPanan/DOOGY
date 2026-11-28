# 照护记录图片与 PDF 附件

主人可以给已有照护记录补充照片或 PDF。SQLite 与 PostgreSQL、offline 与 API 模式使用相同合同；文件随当前数据库保存、备份和恢复，无需云存储账号、新环境变量或额外服务。

## 上传与读取

下列路径统一前缀 `/api/v1`，使用当前用户的 Bearer 登录令牌：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /care-records/{record_id}/attachments` | owner/caregiver 给有效记录上传一个文件，可选 `Idempotency-Key`；返回新附件元数据 |
| `GET /care-records/{record_id}/attachments` | 当前家庭成员读取附件元数据，返回 `{ "items": [...] }` |
| `GET /care-attachments/{attachment_id}/content` | 当前家庭成员下载附件原始字节 |

viewer 可以列出和下载，不能上传。接口每次按当前家庭权限判断；退出家庭或被撤权后，旧下载路径和旧幂等键不能恢复访问。没有公开文件 URL，也不需要先申请一次性下载链接。

上传使用 `multipart/form-data`：必填文件字段 `file`，可选文本字段 `filename`。`filename` 去除两端空白后为 1–255 个字符，用于显示和下载文件名；省略时使用上传文件的原始名称，支持中文。不要将文件正文放在照护记录的 `value` 或 `notes` 中。

Windows PowerShell 使用 `curl.exe`，避免与 PowerShell 的 `curl` 别名混淆：

```powershell
$token = '登录后取得的访问令牌'
$recordId = '照护记录UUID'
curl.exe --request POST "http://127.0.0.1:3000/api/v1/care-records/$recordId/attachments" `
  --header "Authorization: Bearer $token" `
  --header "Idempotency-Key: care-attachment-20261117-001" `
  --form "file=@./report.pdf;type=application/pdf" `
  --form "filename=体检报告.pdf"
```

让客户端自动生成 multipart 的 `Content-Type` 和 boundary，不要手写不含 boundary 的请求头。`filename` 可整行省略。浏览器拿到用户选择的 `File` 对象 `selectedFile` 后，同样使用 FormData：

```javascript
const form = new FormData();
form.append('file', selectedFile);
form.append('filename', '体检报告.pdf'); // 可省略，改用文件原名
const response = await fetch(`/api/v1/care-records/${recordId}/attachments`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Idempotency-Key': 'care-attachment-20261117-001' },
  body: form,
});
const attachment = await response.json();
```

上传回执、列表元素和照护响应的 `attachments` 使用同一元数据结构：

```json
{
  "id": "{attachment_id}",
  "record_id": "{record_id}",
  "filename": "体检报告.pdf",
  "content_type": "application/pdf",
  "size_bytes": 2048,
  "sha256": "{原始文件字节的64位十六进制SHA-256}",
  "created_by": "{user_id}",
  "created_at": "2026-11-17T12:00:00.000Z",
  "download_path": "/api/v1/care-attachments/{attachment_id}/content"
}
```

单条读取、照护列表、`history.current` 和宠物概览中的照护记录带 `attachments` 数组；无附件时为 `[]`。这些响应只带元数据，下载接口才返回文件正文。

```powershell
curl.exe "http://127.0.0.1:3000/api/v1/care-records/$recordId/attachments" `
  --header "Authorization: Bearer $token"

curl.exe "http://127.0.0.1:3000/api/v1/care-attachments/附件UUID/content" `
  --header "Authorization: Bearer $token" `
  --output ".\体检报告.pdf"
```

下载设置文件的 `Content-Type` 和 `Content-Length`，以 `Content-Disposition: attachment` 返回；`filename*` 使用 UTF-8 编码保留中文下载名，并设置 `Cache-Control: no-store`。可用 `Get-FileHash -Algorithm SHA256` 将下载文件与元数据中的 `sha256` 核对。

## 文件边界与重试

每次只上传一个非空文件。支持 `image/jpeg`、`image/png`、`image/webp` 和 `application/pdf`；服务同时检查对应文件头，修改扩展名或声明 MIME 不会将其他格式转换为支持的文件。单个文件最多 **5 MiB（5,242,880 字节）**，每条照护记录最多 **10 个附件**。

| 情况 | 结果 |
| --- | --- |
| 缺少 `file` | `400 ATTACHMENT_REQUIRED` |
| 文件为空 | `400 EMPTY_ATTACHMENT` |
| 超过 5 MiB | HTTP `413`；服务层为 `ATTACHMENT_TOO_LARGE`，multipart 入口可先返回大小限制错误 |
| MIME 不支持 | `415 UNSUPPORTED_ATTACHMENT_TYPE` |
| 文件头与声明类型不符 | `400 INVALID_ATTACHMENT_CONTENT` |
| 当前记录已有 10 个附件，新上传仍想新增 | `409 ATTACHMENT_LIMIT_REACHED` |
| 父记录已撤回 | `409 CARE_RECORD_WITHDRAWN` |

网络超时重试时，保持同一个 `Idempotency-Key`、规范化文件名、内容类型和原始字节。系统用文件名、类型、大小与 SHA-256 比较请求，相同内容重放首次元数据回执，不重复保存附件、父记录修订或审计；同键异内容返回 `409 IDEMPOTENCY_CONFLICT`。当前权限与父记录有效状态在读缓存前检查，撤回后不能用旧键重新上传。

缓存只保存摘要请求和元数据回执，不再缓存一份文件正文。无键或缓存到期后的上传属于新的操作，即使字节相同也会新增文件并占用名额。默认缓存最长 24 小时，期限、清理和非实时回执语义见 [命令幂等与记录保留](command-idempotency.md)。

## 历史与撤回

每次成功上传在同一事务内保存上传前的父记录快照、附件、父记录 `updated_at` 和上传审计。快照中的 `attachments` 只保留当时的元数据；第一次上传前快照为空数组，后续上传前快照包含已有附件。之后修改正文或撤回记录，也保留当时的附件元数据。升级前的修订或旧幂等回执可能没有 `attachments`，不会改写旧历史来补造文件。

撤回保留照护原文、修订和文件。默认照护列表与概览仍排除撤回记录，但当前有读权限的家庭成员可通过单条记录、历史、附件列表和下载接口继续读取它们；撤回后不能上传新文件。完整撤回规则见 [照护记录编辑与撤回](care-withdrawal.md)。

本次没有独立附件删除接口。需要清除整只宠物或家庭的共享资料时，使用 owner 已有的显式共享删除，关联附件一起清理，见 [隐私与数据生命周期](privacy-lifecycle.md)。

## 保存、导出与恢复

SQLite `021-care-attachments.sql` / PostgreSQL `010-care-attachments.sql` 新增 `care_attachments`，当前全库为61张业务表。元数据与 base64 文件正文存在同一个数据库，不使用外部文件目录或云对象存储；base64 正文约为原始文件的 4/3，数据库和备份体积会随附件增加。正常 `start.bat` 继续先构建最新源码并应用所选数据库迁移，沿用原 API/Worker、依赖和环境配置。

SQLite 快照、PostgreSQL 原生归档和托管备份一起保存附件元数据及原始字节的 base64 表示。SQLite 只读导入到空 PostgreSQL 目标时也一起迁移；旧源没有附件表时，新表为空。恢复旧备份只拥有当时已经保存的文件；恢复后的撤回日志重放能补父记录撤回状态，不能恢复备份之后才上传的文件。备份和恢复步骤见 [数据库操作说明](database-operations.md)。

授权数据导出新增 `care_attachments` 家庭分区，包含附件 ID、父记录 ID、文件名、类型、大小、SHA-256、创建人与时间，以及 `content_base64`；撤回记录的附件仍随当前权限导出。该分区每页最多 1 条，即使 `limit=200` 也返回一条后继续分页；必须读取到 `next_cursor=null`，本地 NDJSON 命令会自动遍历。解码 `content_base64` 可还原文件，再按 `size_bytes` 和 `sha256` 核对。当前清单共 32 种分区类型，每个家庭最多 22 种，viewer 为 21 种。详细分页、完成标记和摘要见 [账号数据导出](account-export.md)。
