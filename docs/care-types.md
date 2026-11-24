# 如厕与自定义照护记录

主人可以在现有照护记录中记下排尿、排便，以及刷牙、训练等自定义事项。两种新类型沿用创建、编辑、列表、单条读取、修改历史、撤回、宠物概览和授权导出，不需要先建分类或切换数据模式。

## 选择记录类型

`type` 支持七种值：

| `type` | 用途与 `value` 约束 |
| --- | --- |
| `weight` | 体重；`weight_kg` 必须为大于 0、不超过 300 的数字，单位为 kg |
| `feeding` | 饮食；JSON 对象 |
| `medication` | 手工用药事实；JSON 对象 |
| `grooming` | 护理；JSON 对象 |
| `note` | 备注；JSON 对象 |
| `toileting` | 如厕；必填 `kind`，取 `urination`（排尿）、`defecation`（排便）或 `both`（两者），可保留其他 JSON 字段 |
| `custom` | 自定义事项；必填顶层 `custom_type`，`value` 为 JSON 对象，可为空对象 `{}` |

`custom_type` 是这一条记录的名称，例如“刷牙”或“训练”。名称去掉两端空白后为 1–100 个字符；不同记录可重复使用同名，也可各用不同名称。系统没有独立分类库，修改名称只影响当前记录，不批量重命名其他记录。非 `custom` 请求不传 `custom_type`，记录响应中该字段为 `null`。

`recorded_at` 使用带时区的 ISO 8601 时间，表示事情发生的时间。`source` 默认为 `owner`，也可为 `vet`，均为录入者声明；`notes` 可选，最多 4,000 个字符。未填写或没有记录的事项表示未知，不能据此判断宠物没有如厕或健康正常。

## 记录一次如厕

接口统一前缀 `/api/v1`，使用当前用户的 Bearer 登录令牌。owner/caregiver 可以创建，当前家庭成员可以读取；viewer 不能写入。

```http
POST /api/v1/care-records
Authorization: Bearer {access_token}
Idempotency-Key: {本次记录意图的唯一键}
Content-Type: application/json

{
  "pet_id": "{pet_id}",
  "type": "toileting",
  "value": { "kind": "defecation", "location": "楼下草地" },
  "recorded_at": "2026-11-17T08:15:00+08:00",
  "source": "owner",
  "notes": "晨间散步时记录"
}
```

响应沿用照护记录字段，其中 `type="toileting"`、`custom_type=null`，`value` 保留 `kind` 和 `location`。缺少 `kind`、拼写不在枚举内，或传入非对象的 `value` 均不能创建。

## 记录自定义事项并纠正

自定义名称放在顶层 `custom_type`，事项内容放在 `value`。例如记录一次刷牙：

```http
POST /api/v1/care-records
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "pet_id": "{pet_id}",
  "type": "custom",
  "custom_type": " 刷牙 ",
  "value": { "duration_minutes": 2 },
  "recorded_at": "2026-11-17T20:30:00+08:00"
}
```

保存后 `custom_type` 为“刷牙”。只有名称、没有其他结构化内容时，也可传 `value={}`。系统只保存自定义字段，不赋予 `duration_minutes` 等字段额外业务含义或计量换算。

需要纠正当前记录的名称或内容时，使用原 PATCH 接口：

```http
PATCH /api/v1/care-records/{record_id}
Authorization: Bearer {access_token}
Idempotency-Key: {本次纠正意图的唯一键}
Content-Type: application/json

{
  "custom_type": "晚间刷牙",
  "value": { "duration_minutes": 3 },
  "notes": "纠正本次持续时间"
}
```

PATCH 省略的字段保留原值；提供的 `value` **完整替换**旧对象，不逐项合并。修改如厕 `value` 时仍需带合法的 `kind`。记录的 `type`、所属宠物、原始来源和作者不能通过 PATCH 改变；`custom_type` 只能用于 `custom` 记录，不能用它把其他类型变成自定义类型。

每次编辑保留修改前快照，`GET /care-records/{id}/history` 的 `current` 可读取当前名称，`revisions[].record` 可读取原名称和内容。升级前保存的修订和幂等回执可能没有 `custom_type`；当前事实以 `GET /care-records/{id}` 为准，不改写旧回执。撤回后不能再编辑，权限、幂等键、原因和冲突规则见 [照护记录编辑与撤回](care-withdrawal.md)。

## 按事项查看记录

```http
GET /api/v1/pets/{pet_id}/care-records?type=toileting&status=active&limit=50
Authorization: Bearer {access_token}
```

```http
GET /api/v1/pets/{pet_id}/care-records?type=custom&custom_type=%E5%88%B7%E7%89%99&status=all&from=2026-11-17T00%3A00%3A00%2B08%3A00&to=2026-11-18T00%3A00%3A00%2B08%3A00
Authorization: Bearer {access_token}
```

| 参数 | 含义 |
| --- | --- |
| `type` | 可选，按七种记录类型之一筛选 |
| `custom_type` | 可选，去掉两端空白后按名称精确匹配，长度 1–100；可单独使用 |
| `status` | `active`、`withdrawn` 或 `all`，默认 `active` |
| `from`、`to` | 可选，按 `recorded_at` 筛选 `[from,to)` 时间区间 |
| `limit`、`cursor` | 每页 1–200 条，默认 50；后续页传上一页的 `next_cursor`，保留相同筛选条件 |

多个筛选条件同时成立才返回记录。例如 `type=note&custom_type=刷牙` 没有匹配项；名称筛选不做模糊搜索或大小写转换。列表按 `recorded_at`、`id` 倒序排列，返回 `items` 和 `next_cursor`，后者为 `null` 表示结束。名称纠正后按新名称筛选当前记录，原名称仍可从历史读取。

宠物概览 `/pets/{id}/overview` 在所选自然日的 `care_records` 中显示有效记录及 `custom_type`；撤回记录从默认列表和概览排除。新类型不会改变宠物体重，体重仍仅由有效的 `weight` 记录回算。

## 保存、导出与升级

授权导出的 `care_records` 分区包含新类型及 `custom_type`；修订由原 `care_record_revisions` 分区保留，导出仍为 31 种分区。旧快照没有记录过的 `custom_type` 不补造名称，详见 [账号数据导出](account-export.md)。

SQLite `020-care-types.sql` / PostgreSQL `009-care-types.sql` 增加可空 `custom_type` 并扩展类型约束，业务表仍为 40 张。旧记录该字段为 `NULL`；SQLite 重建表时保留既有字段、修订关联和撤回信息。正常 `start.bat` 先编译再应用所选数据库的增量迁移，沿用现有 API/Worker、依赖和环境配置。

以上为如厕与自定义类型交付阶段的范围和迁移版本。后续已支持照护图片/PDF 上传、下载、历史和授权导出，当前结构及接口见 [照护记录附件](care-attachments.md)。
