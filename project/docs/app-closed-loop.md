# App 操作闭环与 51 画板验收表

本表依据 [主需求](../Doggy_final.md) 第21节的参考画板节点和当前软件合同编制，用于前后端协作。它规定入口、操作、保存返回与重读条件，不代表所有画板已完成全部原生终端验收。参考Figma节点不等于取得最新原型连线，视觉可沿用现有风格。

## 使用口径

- 软件闭环需要可从实际入口选择对象、提交或明确取消，看到成功/失败/等待状态，并返回原页重读持久结果。
- HTTP、数据库和真实TSX组件分别证明接口、持久化和界面逻辑；原生SDK桩不证明权限、录制、播放或真实硬件。
- 未配置能力应明确关闭或失败；offline演示不能显示为真实模型识别、设备执行或第三方已接收。
- 按 [接口文档](../fb.md)、本表条件和 [验收清单](acceptance.md) 逐项记录本次结果。

## 51 画板逐项验收

| 编号与留存画板 | 实际 App 入口与操作 | 保存、返回与重读的成功条件 | 后端 / 组件证据索引 |
| --- | --- | --- | --- |
| 01 Welcome | 未登录的欢迎/账户页；展开连接与服务区域，检查服务端，选择登录或注册。 | 连接失败留在当前页可修改地址重试；已保存环境在重开后仍一致，不自动跨 CN/Global 复制账号。 | A：连接验证、会话恢复、无效 URL。 |
| 02 Create account | 欢迎页→创建账户；填写邮箱、密码及可选显示名。 | 注册成功只创建一次账户；随后身份读取失败提供恢复读取，不能再次注册；成功进入引导。 | A：真实注册 HTTP、注册后身份失败恢复、空可选名。 |
| 03 Meet your dog | 引导第 1 步→选择已有档案或新建；完整档案页可编辑头像、资料与体重。 | 新建结果可重读；身份读取失败后只重读已建档案，不重复 POST；切宠后的迟到保存不切回旧宠物。 | A、B：宠物/头像 API、引导与保存作用域组件。 |
| 04 Connect collar | 引导第 2 步或安全→设备；输入设备身份与短期绑定码，或显式跳过。 | 绑定后从概览重读当前绑定；跳过保存 `collar_choice` 后可继续使用，并能回到设备页恢复设置。 | B、G：引导状态、claim、解绑/库存接口。 |
| 05 Setup complete | 引导完成按钮→Main；个人资料页可主动重新打开引导。 | 完成请求成功才进入首页，后退不残留未完成步骤；失败停留并能重试，重登录按持久引导状态进入。 | A、B：引导完成/拒绝后不跳转组件。 |
| 06 Log in | 欢迎页→登录；找回密码可申请请求、输入受控投递得到的一次性凭据并重置。 | 登录后可刷新/恢复；退出先清本机。重置成功撤销旧会话，旧密码失败、新密码可登录。 | A：client/restore/真实 HTTP、password recovery 后端测试。 |
| 07 Edit profile | 页头“我的”→个人资料；宠物资料进入档案页，头像显式选择后替换。 | 显示名按版本保存、重读；头像服务器校验后才能作为当前头像读取。条款只记录实际阅读的版本，不预填接受。 | A、B：profile/头像 HTTP、Pet 保存与相册回包作用域。 |
| 08 Collar settings | 安全→项圈与位置→设备；读连接状态、普通策略、走失状态；“我的设备”选择已解绑设备续码/释放。 | 策略返回的 `command_id` 自动加载，可刷新实际回执；续码填入绑定草稿而不自动 claim，释放后清旧码、刷新库存；无需记 UUID 找回本人未绑定库存。 | G：reporting/device inventory HTTP、设备组件。 |
| 09 Today | 底部“今天”；当前宠物、今日摘要、照护入口、风险提示及家庭协作入口。 | 焦点/刷新读取当前宠物，切宠清旧作用域；餐食等返回后汇总能重读，缺失数据保持未知。 | B、C、D：概览 HTTP、首页入口与返回组件。 |
| 10 Health overview | 今天→健康概览与活动趋势；Wellness“活动”。 | 展示所选日期/有效时区、日周汇总及实际覆盖；今日同进度比较与历史完整日评估分别呈现。 | C、E：daily/weekly/current assessment 与组件。 |
| 11 Activity | Wellness→活动→日/周数据、时段读取、目标入口。 | 日期与 IANA 时区明确；小时/时段与分页查询使用明确边界。同一宠物、日期/时区不变时，普通刷新不覆盖其他分项未保存草稿；切换范围会重新载入对应草稿。 | C：活动汇总/interval、Wellness 草稿和范围测试。 |
| 12 Sleep | Wellness→活动查看 `sleep_minutes`；趋势选择睡眠分钟。 | 已有睡眠分钟与覆盖按实际样本读取；无数据展示缺失，不解释为未睡。 | C：activity/trends 后端、Wellness 读取。 |
| 13 Score breakdown | 今天/Wellness→原始活动、身体观察、覆盖和证据。 | 保留用户原文与客观数据，不生成日常状态分、不从未知值推导分数；能打开证据或返回补录。 | C、E：身体观察原文、活动证据。 |
| 14 Today’s inputs | 今天→记录餐食或体重、身体观察；Care 记录详情可查看修订和附件。 | 写入后选择返回的记录、重读详情；返回“今天”复读汇总，不另建第二个 Main。 | C、D：care-flow 组件、care/nutrition HTTP。 |
| 15 Body check-in | 今天→记录身体观察，或 Wellness→身体观察。 | 食欲/精力/行动/排便可分别留空；保存带版本，冲突保留草稿并明确重读；可选择实际排便记录，不猜测缺项。 | C：wellness HTTP、版本冲突/交叉分项草稿组件。 |
| 16 Weight | Wellness→趋势→体重，或 Care→称重历史。 | 跨日期体重序列可重读，kg/lb 及原值来源保留；撤回或修订后汇总采用当前有效事实。 | C、D：wellness trends、care types/withdrawal。 |
| 17 Log weight | 今天→记录体重；Care 表单选择称重。 | 明确数量/单位/记录时间后保存一次；按返回 ID 重读，取消不提交；保存成功后的读取失败不重复写入。 | C、D：care form/幂等/单位 HTTP 与组件。 |
| 18 Health insights | 今天→健康观察历史；选定完整日生成/读取评估。 | 新返回的快照能在历史范围找到；详情显示原证据、输入不足原因、本人已阅与关联反馈。 | E：health-stage HTTP、生成后历史重定界与反馈组件。 |
| 19 Trends | Wellness→趋势；选指标、日期范围、时区，分页读取。 | 按服务端口径复读活动/睡眠/体重数据，保留覆盖及缺失；过滤改变回到第一页。 | C：wellness-stage、backend 代表闭环。 |
| 20 Nutrition | Wellness→营养；可进入餐食历史和喂养指导。 | 同日期摄入摘要与餐食记录一致；已知 kcal 和未知能量数量分开，完整性仅针对已记录餐食。 | D：nutrition-stage、返回营养汇总组件。 |
| 21 Log a meal | 今天→记录一餐，或 Care→新增喂食。 | 保存食物/数量/单位/餐次/时间及能量来源；取消保留既有事实；旧格式编辑不静默改写原数量单位。 | D：care-types/nutrition HTTP、legacy edit 组件。 |
| 22 Today’s intake | Wellness→营养→当日摄入；返回 Care 详情核对原餐。 | 新增、修订、撤回后刷新摘要；未知 kcal 不按 0 计，来源可追溯。 | D：nutrition/withdrawal HTTP、focus 返回刷新组件。 |
| 23 Feeding guidance | 营养→查看喂养指导→Learning 的 nutrition/guidance 目录。 | 点选真实发布内容，读版本/适用范围/来源；无内容明确空态，可返回记录，不生成指导正文。 | J：content-stage、路线筛选组件。 |
| 24 Health warnings | 今天→健康观察与提醒；Health 历史按时间和已阅状态查询。 | 从摘要选择详情，缺少完整日证据时说明原因；不把未产生观察当作“没有健康风险”。 | E：health-stage、分页与已阅权限 HTTP。 |
| 25 Alert details | Health→原评估与证据；设备类事件由安全→事件详情进入。 | 健康已阅属于本人；安全 ack 与自动关闭分开；当前权限复查，失效引用不回放旧正文。 | E、H：health read、safety detail/ack、来源失效测试。 |
| 26 At-home care | Health→查看照护说明→Learning health/guidance；家庭联系人可保存实际用途/兽医联系方式。 | 阅读当前发布版本及适用说明，再返回健康或照护；联系入口不假装已经接通。 | E、I、J：内容可见性、联系人和拨号 URI。 |
| 27 Alert guidance | 健康详情→照护说明；安全详情→确认依据、工单与下一步操作。 | 说明对应真实证据/已发布内容；失败、缺失和无内容有可返回路径，不用模型生成内容补空态。 | E、H、J：说明目录、事件依据与工单 HTTP。 |
| 28 Location | 底部安全→现在在哪里→位置与足迹。 | 最近接收点、最近可用参考点分开，显示采样/接收时间、坐标、精度、来源和质量；刷新只读已有数据。 | F：location presentation/quality、trajectory 组件/算法。 |
| 29 Live status | 安全概览或设备页读在线、最后接收、定位新鲜度、走失与策略状态。 | 设备绑定/在线/位置新鲜度/蓝牙分别表示；未知保留未知，不能用一次刷新伪造持续实时通信。 | F、G：overview/reporting HTTP、设备命令组件。 |
| 30 GPS details | 位置→最近位置和逐点详情；读取来源与质量标记。 | 只显示实际存储的采样质量，能返回安全页；无有效定位或信号元数据明确未知。 | F：location-presentation/location-safety。 |
| 31 Home boundary | 安全→家庭围栏→新增/编辑圆形或多边形。 | 输入 WGS84 坐标和圆半径/多边形点，保存后重读围栏；取消编辑不写入，viewer 只读。 | F、G：fences/geofence engine、授权 HTTP。 |
| 32 Fence settings | 围栏→编辑缓冲/精度/连续点/停留规则；启停与本人提醒偏好分别操作。 | 保存后规则/启用状态和配置历史可重读；停用保留历史，通知开关不修改围栏几何。 | G、H：configuration history、fences/notification prefs。 |
| 33 Battery | 安全或设备→实际电量、低电与最后采样时间；本人通知偏好。 | 电量来自真实上报，缺失保持未知；低电提醒按现有阈值，不把旧值当当前电量。 | G、H：device status/notifications、概览。 |
| 34 Power & accuracy | 设备→普通 reporting-policy、走失请求、回执及配置历史。 | 提交显示期望策略与 `pending/applied/failed/expired` 等真实命令状态；不会把队列受理当固件已执行。 | G：reporting/configuration-history、自动命令 GET 组件。 |
| 35 Safety history | 安全→查看安全历史；今天/近 7 自然日/全部，时间窗与时区明确。 | 自然日边界取服务端，首屏范围随分页固定；全历史兼容既有合同；摘要→详情→ack→重读，切宠清旧详情。 | H：safety-history HTTP、mobile safety-history 与 backend 测试。 |
| 36 Outside-zone alert | 安全概览“需要留意的变化”或本人通知→对应宠物安全事件。 | 详情有越界依据与时间；ack 后列表更新，ack 不自动关闭事件；成员无权后旧详情不可继续读取。 | F、H：geofence/location-safety、safety ack/inbox。 |
| 37 Live tracking | 安全→寻找会话→设备策略与位置足迹。 | 显式开/关走失会话，重读期限、恢复策略及命令；当前页足迹仅按质量连线，坏点/跨绑定不桥接。 | F、G：reporting/share、trajectory、设备组件。 |
| 38 Emergency actions | 安全→寻找会话、联系人、分享或求助。 | 用户明确选择动作，显示每个动作的实际受理/失败/取消；无设备仍能求助或返回，不生成统一假“紧急操作成功”。 | G、I：设备空态、contact alert/work、support。 |
| 39 Share & contacts | 安全→联系人与文字通知；或设备→位置分享。联系人/宠物可选择，通知按宠物每页 10 条历史→详情→attempt 重试/取消。 | 联系人版本/成员报告同意/收件选择显式确认；请求成功后重读逐人结果；位置分享独立创建/复制/撤销，不自动附进文字通知。 | I、G：contacts/history/lifecycle HTTP、通知历史与设备组件。 |
| 40 Exercise | Wellness→活动→运动目标与计划；从计划目录为当前宠物预填计划草稿。已有目标页面时返回原页，没有原页则打开目标页。 | 活动事实与目标分开；同一目标页作用域内保留指标草稿，计划仍须明确保存。目标有有效日期/版本，不由设计示例值或内容正文自动生成；切宠/日期不承诺沿用旧范围草稿。 | C、J：wellness goals、content-plan 与计划组件。 |
| 41 Exercise plan | Wellness→浏览运动计划→读正文→选用真实结构化计划→明确保存。 | 选用只预填可编辑草稿，未点击保存不写；无结构化参数只读正文；冲突保留草稿并可重读。 | C、J：结构化计划 HTTP、计划预填/版本冲突组件。 |
| 42 Behavior | 底部“读懂”→人工行为；选择标签、时间、备注及可选媒体。 | 人工观察可无媒体保存，列表能重新找到并点选详情；取消或切宠不会把旧回包写进新宠物页面。 | K：behavior-stage、learning-flow HTTP 与组件。 |
| 43 Behavior details | 人工记录详情或所选媒体详情；可显式带来源提问/用于解释。 | 从实际列表选择来源，核对 pet 与媒体归属；删除媒体后派生结果失效，人工标签/原文按合同保留。 | K、L：media/behavior/source invalidation、来源选择组件。 |
| 44 Record sound | 读懂→媒体→MediaCapture；显式授权录音或从本机导入 M4A/MP3/WAV/MP4。 | 服务端能力可用且有写权限才开放；录音原生约 59 秒停止；用户确认采集时间后上传，60 秒/20 MiB 服务端验真；失败沿用同草稿 key，取消/后台/离页/切宠清自有临时文件。 | M：media-upload HTTP、media-capture 8 项组件。 |
| 45 Interpretation | 媒体列表选片段→用于解释→显式创建任务；详情重读/取消/按 attempt 重试/反馈。 | Worker 实际处理后才显示终态；反馈绑定成功尝试与证据；原媒体删除或来源失效清旧派生结果。 | K：behavior/interpretation-feedback/learning-flow HTTP 与组件。 |
| 46 Behavior history | 读懂→人工行为或解释任务历史；今天/近 7 自然日/自定义、分页、选择详情。 | 生成新任务后历史刷新包含返回任务；固定筛选时间窗，切宠/任务后迟到反馈不覆盖新草稿，反馈可重读。 | K：list/filter/cursor、feedback HTTP 与组件。 |
| 47 Helpful tips | 行为详情/解释→查看相关提示，打开 behavior/tip 目录。 | 当前发布内容才可读，正文/来源/版本可重读；无条目时空态并可返回，撤回不通过旧缓存复活。 | J、K：content visibility、内容/媒体失效及路由筛选。 |
| 48 Learn | 底部“学习”；课程/建议/指导/计划目录，标题搜索、类别筛选、本人学习历史。 | 搜索分页、点选正文、返回目录与重读本人进度；切宠不清账号级搜索，换账号/服务端不保留旧内容。 | J：content-stage、learning-screens。 |
| 49 Video lesson | 学习→课程正文；有真实 video URL 时经确认交给系统打开外部视频，勾选步骤/已学并保存。 | 保存当前发布版本的本人进度；历史版本只读，新版本不继承旧勾选。外部打开仅表示系统接受地址，不自动记录观看完成。 | J：content/progress HTTP、历史版本只读/late save 组件。 |
| 50 Lesson library | 学习目录→课程/内容筛选、学习历史中的具体版本。 | 使用真实 ID/版本与当前权限读取；内容撤回不导出旧正文，列表为空仍能返回及重试刷新。 | J、N：content lifecycle、学习分页与授权导出。 |
| 51 Ask AI | 底部“问答”，或课程/行为详情带明确来源进入；选择本人会话和实际上下文来源后提问。 | 请求返回 pending，Worker 处理后重读消息；失败/取消按 attempt 重试；只对本人和当前宠物权限开放，切会话/来源的迟到回复不覆盖新问题。 | L：assistant-stage/learning-flow HTTP、来源选择及 late response 组件。 |

## 跨画板必须一起验收的路径

| 路径 | 当前入口与验收条件 | 证据及限制 |
| --- | --- | --- ||
| 家庭、成员与只读 | 今天→家人一起照护或我的→家庭；选择家庭、邀请/接受、角色调整/移除。owner 才可管理，viewer 可读授权资源。切家庭清旧草稿，邀请 token 不从 A 回写 B；迟到删除确认不继续提交。 | A、B、I。邀请仅复制短期凭据，不自动发送。当前权限最终由后端逐次检查。 |
| 设备所有权与家庭权限分离 | 我的设备只列当前账号持有的安全元数据；解绑保留宠物历史，续码/释放从已解绑列表选择。家庭访问不因本人持有设备自动获得。 | G。列表不返回位置、宠物身份、claim code 或长期设备 token；短期码只在本次生成/解绑响应显示。 |
| 账户与共享数据管理 | 我的→数据与隐私；导出本人/当前授权家庭数据，预览注销/宠物/家庭删除，确认范围及密码；转移所有权从实际成员选择。 | N。保留策略有预览、版本复核及显式执行；原生删除/注销等操作必须使用独立合成库。导出系统菜单打开/取消不等于第三方已接收文件。 |
| 通知与工单 | 我的→通知可读/标已阅/重排失败项、保存本人偏好；设备/安全→帮助，可提交纯文字工单或显式授权诊断并撤销，客服按白名单处理状态/回复。 | H、I。重新排队不等于渠道送达；无授权/过期/撤销不继续读取旧诊断。 |
| 取消、弱网、重读与返回 | 保存中不能双击产生第二次业务写；成功写入后的读取失败只重试读取。切账号/服务器/宠物/家庭/会话丢弃旧回包；空态保留创建、求助或返回。 | A、B、C、G、I、K、L、M。组件与 HTTP 分开记录；进程被系统直接终止不能假设 JS 清理回调执行。 |

## 源码与测试证据索引

这些链接指向当前可运行实现和对应测试定义；执行结果另见后文日志，不把文件存在当作测试通过。

| 索引 | 主要实现 / 合同 | 相关测试 |
| --- | --- | --- ||
| A 身份与账户 | [AuthScreen](../mobile/src/screens/AuthScreen.tsx)、[AppContext](../mobile/src/state/AppContext.tsx)、[identity](../src/identity.ts)、[password-recovery](../src/password-recovery.ts)。 | [mobile client](../mobile/test/client.test.cjs)、[restore identity](../mobile/test/restore-identity.test.cjs)、[authentication identity](../mobile/test/authentication-identity.test.cjs)、[backend 代表闭环](../mobile/test/backend.test.cjs)、[password lifecycle](../test/password-recovery-lifecycle.test.ts)。 |
| B 引导与档案 | [OnboardingScreen](../mobile/src/screens/OnboardingScreen.tsx)、[AccountScreens](../mobile/src/screens/AccountScreens.tsx)、[App 导航](../mobile/App.tsx)。 | [profile HTTP](../test/profile-stage-e2e.test.ts)、[care flow components](../mobile/test/care-flow-components.test.cjs)、[device/account screens](../mobile/test/device-account-screens.test.cjs)。 |
| C 活动、身体、目标与趋势 | [CareScreens](../mobile/src/screens/CareScreens.tsx)、[wellness](../src/wellness.ts)。 | [wellness HTTP](../test/wellness-stage-e2e.test.ts)、[care flow components](../mobile/test/care-flow-components.test.cjs)、[mobile backend](../mobile/test/backend.test.cjs)。 |
| D 餐食与照护 | [CareScreens](../mobile/src/screens/CareScreens.tsx)、[nutrition](../src/nutrition.ts)、[care](../src/care.ts)。 | [nutrition HTTP](../test/nutrition-stage-e2e.test.ts)、[care types](../test/care-types-e2e.test.ts)、[withdrawal](../test/care-withdrawal-e2e.test.ts)、[attachments](../test/care-attachments-e2e.test.ts)、[care flow components](../mobile/test/care-flow-components.test.cjs)。 |
| E 健康观察 | [health-observations](../src/health-observations.ts)、[CareScreens](../mobile/src/screens/CareScreens.tsx)。 | [health HTTP](../test/health-stage-e2e.test.ts)、[care flow components](../mobile/test/care-flow-components.test.cjs)、[content/health lifecycle](../test/content-health-lifecycle.test.ts)。 |
| F 定位与足迹 | [SafetyHubScreen](../mobile/src/screens/SafetyHubScreen.tsx)、[DeviceScreens](../mobile/src/screens/DeviceScreens.tsx)、[telemetry](../src/telemetry.ts)、[trajectory](../mobile/src/lib/trajectory.ts)。 | [location presentation](../test/location-presentation.test.ts)、[location safety](../test/location-safety.test.ts)、[trajectory](../mobile/test/trajectory.test.cjs)、[device/account screens](../mobile/test/device-account-screens.test.cjs)。 |
| G 设备、围栏、策略、分享 | [devices](../src/devices.ts)、[reporting](../src/reporting.ts)、[fences](../src/fences.ts)、[shares](../src/shares.ts)、[DeviceScreens](../mobile/src/screens/DeviceScreens.tsx)。 | [device inventory HTTP](../test/device-inventory-e2e.test.ts)、[device credentials HTTP](../test/device-credentials-e2e.test.ts)、[configuration lifecycle](../test/configuration-contacts-lifecycle.test.ts)、[location share](../test/location-share-web.test.ts)、[device/account screens](../mobile/test/device-account-screens.test.cjs)。 |
| H 安全、通知与客服 | [DeviceScreens](../mobile/src/screens/DeviceScreens.tsx)、[AccountScreens](../mobile/src/screens/AccountScreens.tsx)、[telemetry](../src/telemetry.ts)、[support](../src/support.ts)。 | [safety history HTTP](../test/safety-history-e2e.test.ts)、[mobile safety history](../mobile/test/safety-history.test.cjs)、[notification inbox](../test/notification-inbox-e2e.test.ts)、[support workbench](../test/support-workbench-e2e.test.ts)。 |
| I 联系人与显式通知 | [AccountScreens](../mobile/src/screens/AccountScreens.tsx)、[contacts](../src/contacts.ts)、[contact alerts](../src/contact-alerts.ts)。 | [contacts HTTP](../test/contacts-stage-e2e.test.ts)、[alert history HTTP](../test/contact-alerts-history-e2e.test.ts)、[alert lifecycle](../test/contact-alerts-lifecycle.test.ts)、[mobile contact history](../mobile/test/contact-alert-history.test.cjs)、[device/account screens](../mobile/test/device-account-screens.test.cjs)、[phone URI](../mobile/test/contact-phone.test.cjs)。 |
| J 内容与学习 | [LearningScreens](../mobile/src/screens/LearningScreens.tsx)、[content](../src/content.ts)。 | [content HTTP](../test/content-stage-e2e.test.ts)、[structured plan HTTP](../test/content-plan-e2e.test.ts)、[content lifecycle](../test/content-health-lifecycle.test.ts)、[learning components](../mobile/test/learning-screens.test.cjs)。 |
| K 行为与解释 | [LearningScreens](../mobile/src/screens/LearningScreens.tsx)、[behavior](../src/behavior.ts)、[source invalidation](../src/source-invalidation.ts)。 | [behavior HTTP](../test/behavior-stage-e2e.test.ts)、[feedback HTTP](../test/interpretation-feedback-e2e.test.ts)、[feedback lifecycle](../test/interpretation-feedback-lifecycle.test.ts)、[learning flow HTTP](../test/learning-flow-backend.test.ts)、[learning components](../mobile/test/learning-screens.test.cjs)。 |
| L 本人问答 | [LearningScreens](../mobile/src/screens/LearningScreens.tsx)、[assistant](../src/assistant.ts)。 | [assistant HTTP](../test/assistant-stage-e2e.test.ts)、[learning flow HTTP](../test/learning-flow-backend.test.ts)、[learning components](../mobile/test/learning-screens.test.cjs)。 |
| M 媒体上传与采集 | [MediaCapture](../mobile/src/ui/MediaCapture.tsx)、[MediaPreview](../mobile/src/ui/MediaPreview.tsx)、[media](../src/media.ts)。 | [upload HTTP](../test/media-upload-e2e.test.ts)、[media HTTP](../test/media-stage-e2e.test.ts)、[media capture components](../mobile/test/media-capture.test.cjs)、[真实安装版上传编码](../mobile/test/native-upload.test.cjs)、[preview components](../mobile/test/media-preview.test.cjs)。上传编码执行安装版RN/Expo链；播放器、音频/文件/权限SDK在组件中仍明确stub，不证明真实录音或播放。 |
| N 生命周期与导出 | [AccountScreens](../mobile/src/screens/AccountScreens.tsx)、[privacy](../src/privacy.ts)、[account export](../src/account-export.ts)、[retention](../src/retention.ts)。 | [export HTTP](../test/account-export-e2e.test.ts)、[privacy HTTP](../test/privacy-e2e.test.ts)、[retention](../test/retention.test.ts)、[mobile export](../mobile/test/export.test.cjs)、[native API/cache](../mobile/test/mobile-api-native.test.cjs)。 |

## 能力门控与演示数据

| 类别 | 可验的软件行为 | 不作为已接入能力的项目 |
| --- | --- | --- ||
| 真实媒体 | 用户已明确音频/视频均不超过 **60 秒、20 MiB**。服务端按真实字节/编码/时长验证 M4A AAC、MP3、WAV PCM、MP4 H.264（可带 AAC），受校验工具能力声明门控；录音约 59 秒停止以留编码尾部。 | 文件 MIME、扩展名、客户端时长或合成数据库 fixture 不能代替服务端真验；组件桩不能证明麦克风、系统选择器、播放器或终端编解码通过。 |
| 演示内容包 | 受控的 [10 条合成内容](../fixtures/app-demo-content.json) 与独立 [start-app-demo.bat](../start-app-demo.bat) / [app-demo 实现](../scripts/app-demo.ts) 已实现。5门课程、1项运动计划、4条指导/提示使用独立库和合成标签；原生操作按目标终端分别验收。 | 不向用户原数据库自动填内容；审阅者仅核对软件流程，不将合成教程、指导或计划称为专业审核内容或适用于真实宠物。默认正式目录仍可为空。 |
| 硬件与地图 | 现有 HTTP ingress、设备凭据、绑定快照、幂等上报、策略/走失请求与回执，以及预留的 BLE 手机网关、供应商 API/Webhook/MQTT 标准边界。 | 未确定硬件协议不编造 BLE UUID、MQTT topic 或永远成功的 beep/recall/new-location。GPS实测、心率、睡眠分段、安全区省电、续航估计、地图/导航/方向距离待各自接入。 |
| AI、身份和发送渠道 | offline 明确演示；api 未配置返回失败；本人问答与解释保留来源、attempt 和失效清理。联系人请求与逐人结果可本地闭环。 | 真实 AI、推送、邮件/短信、SSO、收件人本人核验及位置链接投递未凭标准接口宣称完成。 |
| 日常状态与评分 | 保留活动事实、覆盖率、四项身体观察原文、目标与规则证据；输入不足明确显示。 | 按用户确认保持原文，不生成未确认评分、健康结论或个体运动/饮食公式。 |
