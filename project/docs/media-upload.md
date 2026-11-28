# 音视频采集、上传与读取

2026-11-24 用户确认首版：音频/视频最多 **60 秒、20 MiB**，支持常见 M4A、MP3、WAV、MP4；保存至主动删除或删除宠物。本合同复用原 `pet_media`，不增加表或迁移。真实模型仍未接入。

## App 流程

读懂 → 媒体 → 显式录音或导入 → 确认采集开始时间 → 上传 → 媒体列表/详情 → 授权播放或创建解释 → 历史/结果/本人反馈。

- 录音使用 Expo Audio 58，用户点击后才申请麦克风；M4A/AAC 前台录制，原生限制为 59 秒，为编码尾部留出服务端 60 秒边界。拒绝权限时可继续导入文件。
- 导入使用系统文件选择器，先复制到本模块缓存。取消不上传，不删除提供方原文件。导入片段须填写用户实际报告的采集开始时间，不能把导入时间冒充采集时间。
- 草稿首次上传固定文件、时间和幂等键；失败可重试同一次业务意图。只有服务端成功才进入列表，不自动解释或向第三方发送。
- 离页、切宠、退出和进入后台停止录音并清理本模块临时文件；已发出的请求仍可能已经受理，返回列表核对。系统选择器自身的前后台切换单独处理，不误丢其返回结果。
- 前台录音需要 `RECORD_AUDIO`，不开放相机、后台录音、后台播放或手机定位权限。原生权限/录制、SDK 桩和服务器解码分别验收。

## 原生上传兼容

Expo 58 默认使用 `expo/fetch`，其 multipart 编码不支持 RN 特有的 `{uri,name,type}` 文件对象。`MobileApi` 原生统一上传现通过 Expo File 的 `bytes()` 提供 FileBlob，保留原文件名、优先使用调用方 MIME，并沿用采集时间等字段、POST/PUT 方法、幂等键及请求 fingerprint；web 仍走父类的浏览器 Blob 路径，不切换全局 fetch 实现。

## HTTP 合同

| 方法（统一前缀 `/api/v1`） | 行为 |
| --- | --- |
| `GET /pets/{id}/media/capabilities` | 当前宠物读权限；返回 upload_enabled、20MiB/60秒上限、格式及 READ_ONLY / MEDIA_VALIDATOR_NOT_CONFIGURED 原因 |
| `POST /pets/{id}/media` | 当前 owner/caregiver；multipart 的 file 和 captured_at（带时区 ISO）；可选 Idempotency-Key |
| `GET /pets/{id}/media`、`GET /media/{id}` | 复用授权分页/详情；返回实际类型、大小、摘要、时长、用户报告时间、owner_upload 来源及校验元数据 |
| `GET /media/{id}/content` | 复用 Bearer 授权、单段 Range、no-store/nosniff；不产生永久公开播放链接 |
| `DELETE /media/{id}` | 复用删除日志、源失效及恢复重放；旧解释/反馈和问答派生引用不得复活 |

服务端在校验前和落库事务内分别检查权限。接口不接受客户端宣称的 duration、validation 或 source。MIME/后缀不作为真伪依据，实际识别并解码：WAV PCM、MP3、M4A AAC、MP4 H.264（可带 AAC）；最多一条音轨和一条视频轨，视频不超过4096×2160。QuickTime/MOV、3GP 等不能因共用 demuxer 或改名而冒充 MP4，ISO-MP4/M4A 品牌也须符合白名单。

检查容器与流时长，并核对解码输出时长；结束时间不能晚于服务端现在。元数据保留 `ffmpeg_decode_v1`、codec、container_brand、实际时长及 `model_analyzed:false`，不把解码当成行为识别。校验失败不落库；同键不同文件/时间冲突，重放仍受当前权限限制。

校验仅允许读取本次临时文件，禁用网络协议，最多两个并发校验，每个子进程限时15秒并限制分配/输出。超时、异常或不支持的编码均明确拒绝。FFmpeg/ffprobe 只在服务端使用，不打入 APK。

## 服务端工具准备

源码包不附FFmpeg/ffprobe可执行文件。部署时准备与操作系统匹配的工具，来源可参考 [FFmpeg官方](https://ffmpeg.org/download.html)；工具能力与实际格式/解码结果分别检查。

在另一台服务器部署时，将匹配系统的 `ffmpeg`/`ffprobe` 放到项目 `.tools/media/`，或通过 `MEDIA_TOOLS_DIRECTORY` 指定两者所在目录。此变量已加入两份环境示例注释；当前没有修改用户 `.env`。缺工具只关闭上传，其他业务和既有媒体读取仍可用；能力接口如实报告未配置。

实现依据：[Expo SDK58 Audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) · [ffprobe 文档](https://ffmpeg.org/ffprobe.html)。软件流程及验收边界见 [51画板核对表](app-closed-loop.md) 和 [协作流程](process.md)。
