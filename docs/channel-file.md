# 渠道文件与富媒体发送

`codexc channel send-file` 将显式选择的本地文件交给 Gateway，通过已有 Thread 绑定发送。支持 QQ、飞书、Telegram 和微信。本轮富媒体扩展尚未部署或客户端验收。

```bash
codexc channel send-file /absolute/path/report.pdf --thread <Thread ID>
codexc channel send-file /absolute/path/clip.mp4 --type video --thread <Thread ID>
codexc channel send-file /absolute/path/voice.silk --type voice --thread <Thread ID>
codexc channel send-file /absolute/path/voice.opus --type voice --thread <飞书 Session ID>
codexc channel send-file --help
```

不指定 `--thread` 时，所有前后台绑定中必须只有一个目标，且为受支持渠道；不会从多个绑定中自动挑选目标。参数检查在读取配置前完成，重复选择、未知参数和相对路径拒绝。

- `--type` 支持 `file`（默认）、`video`、`voice`，不根据扩展名猜测。QQ 普通文件最多 64 MiB、MP4 视频最多 30,000,000 字节、SILK 语音最多 20,000,000 字节。飞书三种类型均最多 30,000,000 字节，原生视频为 MP4，原生语音为 Ogg/Opus。以上是当前入口预算，不代表其他平台接口的极限；两渠道语音格式不能互换。
- 视频和语音验证受控文件头，不自动转码，也不保证客户端支持文件内的具体编码。飞书不伪造时长或封面，上传分别使用 `stream/mp4/opus`，发送分别使用 `file/media/audio`。
- Telegram 三种类型均限 50,000,000 字节，video 仅 MP4、voice 仅 Ogg/Opus，分别调用 sendDocument/sendVideo/sendVoice；不伪造时长或封面。依据 [Telegram Bot API](https://core.telegram.org/bots/api#senddocument) 的 multipart 文件、视频与语音合同；上游语音还允许 MP3/M4A，但本地未开放。
- 微信 file/video 均限 25 MiB，video 仅 MP4；这是本地预算，不是已验证的平台硬上限。复用加密上传，文件 media_type=3/type=4，视频 media_type=2/type=5，video_size 为密文字节数；基于锁定 Tencent/openclaw-weixin v2.4.9。该基线没有原生语音发送实现，voice 明确拒绝，音频可显式选 file，不自动降级。
- 文件须为非符号链接、非空的普通文件。读取前后复核文件身份、长度和修改时间，变化时拒绝。
- 文件名最多 255 UTF-8 字节，保留中文及正常 emoji，拒绝路径分隔符、控制/格式控制字符和全空白名称。原名作为平台附件名称，不参与私有暂存路径。
- 命令不启动任务、不扫描模型回复中的路径、不压缩或执行文件。复制成功只表示请求已入队，不代表平台或客户端已经收到。

## 领取与结果

请求存入状态数据库所在目录的 `channel-file-outbox/pending/`。Gateway 配置和状态库 Schema 须有效；不兼容时拒绝，不修改数据库。

文件先有界读取并复制为随机 `.bin`，再原子发布同编号 version 1 manifest。Unix 目录/文件为 `0700/0600`，Windows 使用当前用户私有 ACL。Gateway 只消费同目录同编号普通文件，按原 Thread 绑定定位活动渠道；领取及渠道发送边界按目标平台复核类型和预算，发送时复核授权。

四渠道复用 CLI、channelFilePolicy 类型/预算策略、私有 spool、绑定路由和 SurfaceAdapter 接口。格式内容校验可共享，上传协议和平台错误语义仍由各渠道适配器负责；不另建文件重试队列。TG/微信显式发送总预算 120 秒，沿原队列和调用方取消信号；读取后及每次实际请求前复核原 Thread。微信必须保留入队时的有效回复上下文，失效或替换时拒绝；显式媒体不自动重传 CDN 或消息，旧文字结果文件策略保持原上限及行为。

本轮隔离观察：四渠道实际 CLI 均在独立配置/SQLite 绑定下提交，生产 spool 保留中文内容与 file 类型并归档；TG Outbox 的三类发送分别调用对应 API，排队后解绑不再发送。微信 Outbox→凭据包装器/协议链路观察到文件 3→4、视频 2→5，CDN 上传后撤权无最终消息、最终网络未知无重发、voice 零上传；凭据等待期间解绑或取消均为零 HTTP。平台端口使用本地替代实现，未访问真实账号、用户数据库或 App Server；客户端表现、真实上传和 Windows/macOS 私有目录路径仍未观察。

发送前将 manifest 领取为 `.sending`。只有完整发送按渠道协议获得确认后，才将副本及 manifest 归档至 `done/`：QQ、飞书、Telegram 校验最终消息 ID，微信校验最终发送接口的成功响应，不要求接口未提供的消息 ID。接口确认不代表客户端已打开或播放。失败或结果未知保留在 `failed/`，附受控原因；重启遗留 `.sending` 仅归档，不自动重发。人工决定重新提交前须先核对是否已收到，避免重复。

QQ 发送先上传取得 `file_info`，再发送富媒体消息；只有最终合法消息 ID 才确认送达。5,000,000 字节以内使用 Base64 直传，更大文件走准备、逐片 PUT、逐片确认、合并上传。预签名上传不携带 QQ 凭据，不跟随重定向，实际连接固定到已校验的公网 IP。文件引用只在本次原目标发送中使用，不缓存复用。

QQ 最终消息使用主动额度，与其他消息共用账号、收件人限速和顺序。进入 Outbox 后的发送计划预算为 120 秒，单 API 请求 15 秒、单片上传 30 秒；停止领取器会取消在途网络发送。CLI 和领取器的本地文件读取限制字节量，但不保证异常文件系统上的读取能被即时中断，也不计入该发送预算。每个网络阶段继续复核原 Thread 绑定，上传后撤权不再发送。平台确认不代替客户端下载确认；额度、权限或网络失败不会自动改成其他消息模式，不自动重传分片。

飞书复用现有 Chat 顺序队列和官方 IM 上传、发送接口。上传取得 `file_key` 后才创建对应消息，不缓存跨目标资源 Key，不自动重试非幂等发送。原 Thread 守卫在排队、读取前后、上传、SDK 鉴权等待后的业务 HTTP 及最终发送时复核；停止信号覆盖在途网络请求。本地读取的取消限制同上，沿既有每请求期限，不套用 QQ 的分片和主动额度机制。

## 数据与回滚

本功能不修改 StateStore 或现有图片 `channel-outbox` manifest，不迁移或删除旧请求。文件 version 1 manifest 新增可选 `mediaType`；省略仍表示普通文件，不改写旧记录，未知值拒绝。图片 manifest 不接受该字段。文件目录独立保留，`done/failed/` 不自动清理。

升级前可按现有 Gateway 数据目录管理方式备份整个文件暂存目录。回滚源码后，新字段请求会被旧实现拒绝并保留，不能保证旧版本继续处理；先暂停新文件提交，待在途领取结束后再回滚并人工核对。不要手工删除类型字段把视频/语音变成普通文件，不重新解释为图片，不覆盖旧记录。已经领取的发送可能发生外部效果，取消或回滚不能撤回；勿在运行中移动待发送记录。

本机图片仍使用 [`send-image`](channel-image.md)，任务长正文转文本文件继续由渠道现有结果策略处理；它们与显式任意文件选择的用途不同。
