# 移动端功能与接口覆盖

核对日期：2026-11-25。此表依据当前屏幕源码与后端控制器，说明实际入口和接口边界；“已接入”不表示真实硬件、供应商服务或全部原生系统行为已验收。前后端协作规则以项目根目录的 fb.md、主需求和当前接口实现共同核对。

Android App 使用 React Native + TypeScript + Expo，保留 iOS 扩展结构和 Web 辅助预览。五个 Tab 是今天、安全、读懂、学习、问答；顶部提供当前宠物选择和个人入口。App 不运行 NestJS、数据库、Worker 或设备模拟器，业务统一请求后端的 /api/v1。

## 页面与合同

| 页面 / 源文件 | 已接入的操作 | 真实后端合同与边界 |
| --- | --- | --- |
| Auth · [AuthScreen](../src/screens/AuthScreen.tsx) | 连接/区域、注册登录、找回申请与重置、恢复重试 | `/auth/register`、`login`、`password-recovery`、`password-reset`、`refresh`及身份/引导。认证共享操作锁；临时读取失败保留凭据，明确失效才清理；旧连接/会话迟到结果不覆盖新会话 |
| [OnboardingScreen](../src/screens/OnboardingScreen.tsx) | 已有宠物选择/新建、保存选择、绑定或跳过、完成进入Main、中断恢复 | `GET/PATCH /auth/onboarding`、`POST /pets`、`POST /devices/claim`，版本/家庭权限/短期码。完成失败不导航，建档已成功后读取失败不重建 |
| 顶部 [PetPickerScreen](../src/screens/PetPickerScreen.tsx) | 当前授权宠物选择与档案入口 | 读取context宠物并selectPet；切宠重读相关页面，不扩展权限 |
| 今天 · [HomeScreen](../src/screens/HomeScreen.tsx) | 摘要→健康/身体/餐食/体重→观察与安全、学习/协作/管理 | `overview`、`goals`、`body-check-ins`、`nutrition/daily`。未知不当0，不评分；Care携createType直达，保存popTo原Main重读 |
| 安全Tab · [SafetyHubScreen](../src/screens/SafetyHubScreen.tsx) | 位置/风险计数→足迹/围栏/历史/设备/分享/联系人/求助 | `GET /pets/:id/overview`、`location/latest`，最近点/可用回退分开；section直达设备分项，事件携petId/eventId，viewer不获写权限 |
| Profile · [AccountScreens](../src/screens/AccountScreens.tsx) | 显示名、实际条款版本、继续/重开引导、退出先清本机 | `GET/PATCH /auth/me`、`GET/PATCH /auth/onboarding`、`POST /auth/logout`。不预填条款接受；远端撤销未确认会提示，完成引导不等于蓝牙成功 |
| Pet | 建档/修改、本次称重、相册头像替换及当前头像下载分享 | `GET/POST /pets`、`GET/PATCH /pets/:id`、`PUT /pets/:id/avatar`、头像content；JPEG/PNG/WebP≤5MiB。写成功后身份读取失败只重读，不重复创建/称重，迟到结果不切回旧宠 |
| Household | 家庭选择/设置、成员/角色/移除、邀请生成/接受 | `/households`、`/households/:id/members`、`invitations`、`/invitations/:token/accept`。邀请不自动发送且须邮箱匹配；家庭/角色key隔离，旧token不回写另一家庭，迟到删除确认不提交 |
| Contacts | 独立选择家庭，无宠可CRUD/主联系人/报告同意；本机拨号/复制；同家庭宠物通知及每页10条历史→详情→重试取消 | `/households/:id/contacts`、`/contacts/:id`、`POST/GET /pets/:id/contact-alerts`、`/contact-alerts/:id[/retry\|/cancel]`。无日期/status筛选，点选读当前详情；viewer可查不可写，成功后刷新第一页/详情；跨API/账号/家庭/宠物/角色清旧状态并校验pet_id；ID只作fallback。版本/刷新/方式变更后重选，不附位置、不记录拨号接通 |
| Notifications | 本人全部/未读/已读、偏好、标记已读、失败重排、安全跳转 | `/notifications`、`/notifications/:id/read`、`retry`、`/notification-preferences`。重排不是送达，未接真实移动推送注册 |
| Privacy | 授权NDJSON导出、影响预览、注销/删宠/删家庭、成员选择转移所有权 | `/auth/data-export`、`/auth/account-deletion`、`DELETE /auth/account`、宠物/家庭deletion-preview及DELETE、`POST /households/:id/owner`。密码/目标确认文本，导出重新授权且不产半份；系统分享不表示接收方已读 |
| Privacy家庭保留 | 所选家庭策略读取/启用/三类天数、预览、密码与家庭文本后执行 | `GET/PATCH /households/:id/retention`、`POST .../preview`、`run`。成员只读，配置/预览/执行仅owner；启用后Worker会执行。预览绑定本人/服务器/家庭/策略及更新时间/last_run，执行前重读，但非原子preview token |
| Care · [CareScreens](../src/screens/CareScreens.tsx) | 七类新增/编辑/详情/历史/撤回、附件上传下载；餐食/称重直达，保存返回今天 | `POST /care-records`、`GET /pets/:id/care-records`、`/care-records/:id[/history\|/withdraw\|/attachments]`、`/care-attachments/:id/content`。幂等、原单位和旧JSON保留；无独立附件删除API，只记录实际用药 |
| Wellness | activity/body/goals/nutrition/trends、同范围独立草稿、真实排便手记选择、结构化计划预填、返回后营养更新 | 日/周/interval/current、nutrition/daily、goals、body-check-ins、trends。同宠/日期/时区普通刷新不覆盖另一分项；冲突明确重读、跨范围重新核对，未知不补0、原文不评分，current临时比较不作反馈历史 |
| Health | 指定完整日评估、历史/证据/本人已阅、实际发现关联反馈 | `/pets/:id/observations`、`health-observations`、`/health-observations/:id[/read]`、`POST /pets/:id/feedback`。生成新评估后历史重定界可找回；反馈只选实际证据，规则不是诊断，缺项保留 |
| Devices · [DeviceScreens](../src/screens/DeviceScreens.tsx) | 绑定/解绑、本人库存选择已解绑设备续码/释放、策略/走失及自动命令读取、高级ID可选；无宠有建档/求助/返回 | `GET /devices`、`/pets/:id/overview`、`/devices/claim`、`/devices/:id[/unbind\|/claim-code\|/release\|/reporting-policy\|/lost-mode\|/commands/:commandId]`。库存仅所有权元数据不授予家庭位置，续码填草稿不自动claim，无长期设备秘密 |
| Devices围栏/足迹/分享/配置历史/排障 | section直达、圆/多边形规则启停、定位分页、分享/撤销、修改历史/简报/重排 | `/geofences`、`/pets/:id/geofences`、`location/latest`、`locations`、`location-shares`、`configuration-history`、`/households/:id/operations`、`/pets/:id/telemetry-failures`、`/ingest/events/:id/retry`。WGS84坐标编辑；足迹固定首屏bounds，刷新第一页重取默认；无假地图/硬件执行 |
| Safety | Today/近7当地自然日/全部、分页、依据详情及ack | `/pets/:id/safety-events`的from/to与scoped cursor、`/safety-events/:id[/ack]`。改变时区/范围重置，ack不关闭风险、不替代本人已读。[安全历史](../../docs/safety-history.md) |
| Support | 绑定前文字求助、本人列表/详情、诊断授权撤销；staff回复/状态及授权快照 | `/support/tickets`、`/support/tickets/:id[/diagnostics-consent]`、`/admin/support/tickets`、`/admin/devices/:id/diagnostics`。staff白名单由后端检查，切模式不授予权限；失效授权不读旧快照 |
| Learning · [LearningScreens](../src/screens/LearningScreens.tsx) | 目录/搜索/正文来源版本、当前版步骤与已学、历史只读；指导按真实类别进入；结构化计划回原Wellness草稿 | `/content`、`/content/:id?version=`、`/lessons`、`PUT /lessons/:id/progress`、`/learning-progress`。旧版不可写、新版不继承、撤回不返正文；无收藏。课程视频仅确认后外部打开，非内嵌播放，不记自动完成 |
| Behavior | 人工记录新增/筛选/详情、授权媒体列表/详情/播放/下载/删除、解释历史/创建/状态/重试取消/成功attempt反馈复读 | `/pets/:id/behavior-records`、`/behavior-records/:id`、`GET/POST /pets/:id/media`、`/media/:id[/content]`、`/pets/:id/interpretations`、`/interpretations/:id[/retry\|/cancel\|/feedback]`。读媒体先鉴权；解释反馈GET仅本人/有效attempt/当前pet权限。offline固定演示，api无模型明确失败 |
| [MediaCapture](../src/ui/MediaCapture.tsx) | 主动前台录音/约59秒原生停止、系统导入、实际采集时间、明确上传/同草稿重试/取消/作用域清理 | `GET /pets/:id/media/capabilities`、`POST /pets/:id/media`。60秒20MiB，真实probe/decode M4A AAC/MP3/WAV PCM/MP4 H.264可带AAC，拒绝QuickTime/MOV。固定key/时间，成功才onSaved，不自动解释/发送，不删用户原件 |
| [MediaPreview](../src/ui/MediaPreview.tsx) | 已授权媒体显式加载、播放/暂停/清来源 | 原生重读metadata并用请求头授权，无URL token/自动或后台播放/磁盘缓存；离页/后台清来源，Web只下载；真实解码/生命周期须另验 |
| Assistant | 本人会话/消息历史，实际课程/人工记录/成功解释列表选来源，显式上下文与问题、证据及重试取消 | `/pets/:id/assistant-conversations`、`/assistant-conversations/:id/messages`、`/assistant-messages/:id[/retry\|/cancel]`。人工原文可无媒体提问，媒体/来源失效清派生；本人及当前pet权限、会话/问题草稿与late结果隔离，无假流式/模型分析 |

足迹使用当前页最多30个点的局部坐标示意；GNSS/精度≤100米/无质量标记才可连，按采样时间排序，同设备同binding且中间无坏点才连，无归属仅散点。没有底图/导航或精确距离。收藏无既有后端合同；内容、播放器或菜单存在不代表全部终端表单验收。

## 会话、权限与数据作用域

- 使用 [ApiClient](../src/lib/client.ts) 的会话、刷新和幂等请求，以及 [MobileApi](../src/lib/mobileApi.ts) 的原生文件上传、下载与分享。原生 multipart 使用 Expo FileBlob.bytes；保留文件名、MIME、采集时间、HTTP 方法和幂等键。
- owner、caregiver、viewer 的实际权限由后端复核，界面隐藏按钮不能替代授权。个人会话、学习进度和本人反馈不能当作家庭共享数据。
- 切换服务器、账号、家庭、宠物或角色后，迟到请求不得把旧数据、邀请、草稿或确认结果写入新范围。来源删除、撤回、过期及撤权后的不可读状态保持真实。
- 同一宠物、日期和时区的目标与身体观察各自保留未保存草稿；运动计划选用只预填，用户显式保存才提交。冲突明确重读，不自动覆盖。
- offline 依然需要可达后端。解释、问答和外发结果必须标明模拟或未配置；上传和解码不表示做过行为识别。

## 硬件接口保留

[hardware/contracts.ts](../src/hardware/contracts.ts) 保留能力状态、BLE 配对端口、短期网关授权引用及 v1 遥测类型。该文件当前不被 App 自动调用是预留合同的正常状态。不得因此删除，也不在 App 中加入长期设备秘密、猜定 BLE UUID 或 MQTT topic。设备软件绑定、手机蓝牙配对、网关转发、设备命令受理和真实固件执行分别记录。

后台事件接入、凭据校验、供应商归一化、Worker、持久化、通知投递和数据清理继续由服务端处理；App 不复制这些后端任务。

## 协作验证

从根目录安装后端依赖，再安装 mobile 依赖。移动测试依赖父目录源码构建，不能只拷贝 mobile 后直接运行整套回归。步骤见 [移动端 README](../README.md)，原生工具与包构建见 [工具链](android-toolchain.md) 和 [APK 构建](android-apk.md)。

真实 TSX 组件与 SDK 桩、真实内存 HTTP、服务器文件解码、PostgreSQL 条件用例、模拟器和真机验收分别记证。每次变更记录实际运行的命令、通过/失败/跳过和未验证范围；此纯净源码目录不携带旧 APK、原生截图、日志、数据库或历史构建回执。
