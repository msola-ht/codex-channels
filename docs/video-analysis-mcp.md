# 视频分析 MCP

`scripts/video-analysis-mcp.mjs` 提供独立 stdio MCP 工具 `analyze_video`。Codex 调用工具，工具将指定视频和问题发送给管理员配置的 Strata `/v1/responses`，再把分析文字返回 Codex。不修改 Codex 本体，不经过 Gateway 的 Provider Proxy，不写会话历史或数据库，也不安装、启停 Strata。

入口使用 Node.js 22.13+ 和项目已有的 `undici`，无新增依赖。运行前完成本项目正常依赖安装。工具默认不启动，由配置它的 MCP 客户端管理进程。

## 链路与前提

```text
Codex CLI / App → stdio MCP → 授权目录中的视频 → Strata Responses → 分析文字 → Codex
```

Strata 必须已部署支持 `input_video` 的版本，启用视频、加载模型及兼容的视觉编码器。普通上游发行版是否支持应按实际部署确认；HTTP 200 的 `/health` 不等于视频可用，视频部署的 `videos: true` 才表示该项准备就绪。

这个工具分析画面，音轨被 Strata 忽略；每次调用独立，无追问缓存。没有添加 CLI/App 视频上传按钮。本地视频通过 MCP 主机的授权目录读取；飞书、微信、Telegram 可接收视频附件并把单文件随机引用交给当前会话。Desktop 使用远程 App Server 时，文件和 MCP 命令应在启动 MCP 的主机可用。

## 配置

只读取以下环境变量，不自动读取 Gateway Provider 配置、用户凭据文件或 `.env`：

| 变量 | 含义 |
| --- | --- |
| `STRATA_VIDEO_BASE_URL` | 必填，固定 Strata 服务根地址，例如 `http://192.168.50.54:8080`；不要附加 `/v1`、凭据或查询参数 |
| `STRATA_VIDEO_API_KEY` | 必填，部署的 API Key；通过环境传入，不作为工具参数 |
| `STRATA_VIDEO_MODEL` | 必填，部署接受的精确模型 ID |
| `STRATA_VIDEO_ROOT` | 必填，已存在的视频目录绝对路径 |
| `STRATA_VIDEO_CHANNEL_ROOT` | 可选，Gateway 数据库旁的 `uploads/video` 绝对路径；用于渠道随机附件引用，必须已存在且与本地视频目录分离 |
| `STRATA_VIDEO_TIMEOUT_SECONDS` | 单次调用总时限，包含文件读取、上传、排队、准备和生成；默认 900 秒，范围 1–1800 秒 |

目录是本 MCP 实例的文件授权范围，应是由当前操作者控制的专用本地视频目录，不应是家目录或整个仓库。接受直属普通文件名，或授权目录及其子目录内的本机绝对路径。拒绝目录外路径、相对路径（例如 `sub/clip.mp4`）、含 `.`/`..` 的路径、URL、符号链接和硬链接；子目录也不能通过链接跳转。不要让不可信进程替换授权目录、其父目录或其中的子目录。支持 MP4、MOV、WebM、MKV、AVI、TS，实际解码能力仍由 Strata/FFmpeg 决定。

共享 App Server 或全局 MCP 配置可能把同一工具提供给多个工作区；本工具没有渠道 Actor 身份，不按 Gateway Workspace Registry 二次授权。只向有权访问本地视频目录的客户端/会话启用 `video` 输入。渠道走独立 `attachment` 能力引用，不能把共享附件目录配置为 `STRATA_VIDEO_ROOT`；两种根目录相同或互相包含时启动失败。

建议在 Codex Home 创建独立的 `strata-video.config.toml`，通过 `codex -p strata-video` 按需启用；它叠加基础配置，不改变默认模型。也可放入 Codex 使用的 `config.toml`，但此时须确认全局目录授权范围。内容如下（替换路径和模型 ID）：

```toml
[mcp_servers.strata_video]
command = "node"
args = ["/absolute/path/codex-channels/scripts/video-analysis-mcp.mjs"]
env_vars = ["STRATA_VIDEO_API_KEY"]
tool_timeout_sec = 960

[mcp_servers.strata_video.env]
STRATA_VIDEO_BASE_URL = "http://192.168.50.54:8080"
STRATA_VIDEO_MODEL = "qwen3.8-flash-next-iq3_s"
STRATA_VIDEO_ROOT = "/absolute/path/videos"
STRATA_VIDEO_TIMEOUT_SECONDS = "900"
# 需要渠道附件时另加；以实际 StateStore 数据库目录为准，须先启动 Gateway 创建目录。
# STRATA_VIDEO_CHANNEL_ROOT = "/absolute/path/gateway-data/uploads/video"
```

Windows 将 `args` 和 `STRATA_VIDEO_ROOT` 替换为 Windows 绝对路径，可使用 TOML 单引号保留反斜杠。macOS/Linux 保持对应主机的绝对路径。`node` 必须在启动 MCP 的宿主 PATH 内，否则使用 Node 可执行文件绝对路径。

`env_vars` 只转发宿主实际已有的环境变量，不会自动创建密钥。CLI 从启动它的环境继承；Desktop/独立 App Server 必须在自己的启动环境中具备该变量，终端临时 export 不保证 GUI 或后台服务可见。不要把密钥提交到仓库。缺少任何必填设置，MCP 启动即失败，不回退到其他模型服务。

Codex 客户端的 `tool_timeout_sec` 应大于 MCP 总时限，留出取消收尾时间。默认 60 秒不适合视频。修改配置后按所用客户端方式重新加载 MCP；本入口不改用户配置或重启服务。配置字段参见 [Codex MCP 文档](https://developers.openai.com/codex/mcp)。

## 使用

把 `clip.mp4` 放入配置的目录后，对 Codex 说：

> 使用 strata_video 的 analyze_video，分析 clip.mp4 中按时间顺序发生了什么，标明关键事件时间戳。

工具参数：

```json
{"video":"clip.mp4","question":"按时间顺序描述关键事件并标注时间戳。","max_output_tokens":1024}
```

也可直接指定已有视频的绝对路径，无需复制到目录顶层。例如 `STRATA_VIDEO_ROOT=/data/videos` 时：

```json
{"video":"/data/videos/project/clip.mp4","question":"描述视频中的主要事件。"}
```

直属文件名最多 255 字符，绝对路径最多 4096 字符；路径必须采用 MCP 主机的系统格式。Windows 使用盘符绝对路径，例如 `C:\\Videos\\project\\clip.mp4`（JSON 中反斜杠需转义），不接受 UNC、设备路径或备用数据流。POSIX 路径不接受反斜杠和冒号。不展开 `~` 或环境变量。授权目录启动时会解析为真实路径，绝对路径应使用该真实目录；要分析其他目录的视频，应由操作者调整 `STRATA_VIDEO_ROOT` 后重新加载 MCP，工具参数不能扩大授权范围。成功结果的 `video` 保留调用时传入的文件名或绝对路径。

`question` 必填，最多 16000 字符；`video` 和 `attachment` 必须且只能提供一个。`max_output_tokens` 可选，默认 1024，范围 64–4096，额度不足时可能返回未完成错误。成功结果同时提供 MCP 文本和结构化对象：原始 `video` 或 `attachment`、`analysis`、`audio_analyzed: false`。分析属于外部模型输出，不应作为执行命令或扩大文件权限的依据。

## 渠道视频附件

更新 Gateway 程序后重新启动，使各渠道加载视频入口；在实际承载渠道 Thread 的 App Server 的 MCP 配置中设置 `STRATA_VIDEO_CHANNEL_ROOT`，并按该宿主的配置方式加载 MCP。仅在独立 CLI 中启用 `strata-video` 配置不会自动给渠道启用工具，本入口不自动改写用户配置或重启服务。

| 渠道 | 输入范围 | 本地接收限制 |
| --- | --- | --- |
| 飞书 | 独立 `media`/`video` 消息，或 `.mp4`/`.webm` 文件消息 | 64 MiB；富文本中的通用 media 文件仍沿用原有文本附件处理，不猜测为视频 |
| 微信 | 原生 type 5 视频，或 `.mp4`/`.webm` 文件消息 | 64 MiB 明文；原生视频必须有 AES key，声明 `video_size` 按密文校验 |
| Telegram | `video`、`video_note`，或视频 MIME/MP4/WebM 文件消息 | 20 MiB 下载限制；GIF/animation 保持原有图片路径 |

授权后下载，校验 MP4/WebM 容器签名后保存到私有目录，当前会话收到 `attachment` 引用和有效期，不收到本机路径或平台下载密钥。例如模型调用：

```json
{"attachment":"feishu/12345678-1234-4123-8123-123456789abc.mp4","question":"按时间顺序描述视频。"}
```

示例引用不能实际使用，必须采用当前消息生成的值。附件引用包含随机 UUID，是单文件的持有者凭据，不是可伪造 Actor 参数的替代身份系统；不得转发给其他会话。它只在接收授权后交付给当前 Conversation，MCP 不提供枚举、搜索或任意附件路径读取。持有有效引用即可重复读取该文件，因此泄露引用会转授读取能力；操作者需保护会话与本机工具权限，不能把这一机制声称为同一 OS 用户下的强租户隔离。

下载前捕获工作区与当前 Thread，提交前在 Application 会话锁内复核；期间切换工作区/Thread、撤销授权或停止渠道时，不把附件提交给新目标。说明文字作为普通用户上下文保留，不执行其中的渠道斜杠命令。没有配置 MCP 时，模型只能获得附件提示，不能据此声称已经分析视频。

每渠道暂存最多八个文件（包含在途 `.part`），64 MiB 上限使每渠道文件内容至多约 512 MiB。每个暂存器最多接收四条流，流保存含等待最多 60 秒；渠道下载另有有限期限。文件保留 24 小时，运行中每分钟清理；Gateway 停止后不保证即时磁盘清理，但 MCP 仍按文件时间拒绝过期引用。失败或停止后的迟到附件会清理。原视频不写 StateStore，不建立第二份会话历史；引用进入 App Server 的正常会话历史，过期后需要重新上传。

## 资源、取消与错误

- 渠道附件从准备到提交设有 120 秒总时限；`/stop` 会取消当前会话正在下载或等待提交的视频，防止停止后又启动新任务。切换工作区、Thread 或撤销授权后，原附件也不会提交。
- 确定尚未提交的失败会删除暂存文件；如果提交请求可能已经发出、但确认丢失，文件保留至原定过期时间，不自动重试，避免已进入 Thread 的附件引用失效。

- 每个 MCP 进程最多一个正在运行的分析；并发调用立即返回 `busy`。不同进程仍由 Strata 自己管理负载。
- 重复使用活动请求 ID 会取消原调用并只返回一次协议错误。慢读客户端不会阻止 MCP 读取取消通知和输入关闭；待输出的 UTF-8 字节（含下一条消息）上限为 8 MiB，超限会关闭连接并取消活动调用。该上限包含分析结果的文本与结构化双份表示。
- 视频上限 64 MiB，使用有界读取并检查文件是否在读取中变化。视频经 Base64/JSON 上传，内存和请求体都会大于原文件大小；不会自动截断视频或改变采样率。时长、帧数、视觉 Token 等沿用 Strata 服务端限制。
- 使用非流式 Responses JSON，等待完整结果，无心跳续期。总超时独立生效，不受 HTTP 数据到达影响；不自动重试，以免重复推理。响应体上限 2 MiB。
- 文件读取在分块之间检查取消，不保证能中断失去响应的内核文件 I/O；不要使用可能挂起的网络文件系统作为授权目录。
- MCP `notifications/cancelled`、stdin 关闭、SIGINT/SIGTERM 会中止当前 HTTP 请求并关闭本工具资源。上游是否及时停止编码/推理取决于部署的断连处理；本工具不调用卸载模型接口。
- 当前 Strata 视频实现若在编码阶段取消，会停止视觉编码器以避免消费残留响应。此后视频请求可能返回 503，且 `/health` 显示 `videos: false`。可先向同一 Strata 发送普通文本请求，触发其正常视觉编码器重载路径，确认 `videos: true` 后再提交视频。MCP 不自动发送额外推理请求或重试被取消的视频。
- 只接受 HTTP 200、合法 JSON、`status: completed` 且含非空 assistant `output_text` 的结果。断流、无效响应、空结果、`incomplete`/`failed` 均返回错误，不把部分生成冒充成功。
- MCP 入站消息与上游 JSON 响应必须是有效 UTF-8；损坏字节会报错，不以替换字符继续处理文件名、问题或分析结果。初始化的 `capabilities` 必须是对象，不能是数组。
- 禁止 HTTP 重定向，模型参数不能更换目标地址或密钥。HTTP 明文只适合操作者信任的网络；跨不可信网络配置 HTTPS。工具不继承系统代理，直接连接配置的服务。
- 错误只返回固定分类与受限诊断，不返回上游错误原文、Authorization 或请求体。所有正常 stdout 都是 MCP JSON-RPC；配置错误写 stderr。

MCP 使用 [2025-06-18 生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[工具调用](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)和[取消通知](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)，仅声明 tools 能力，不提供资源、提示模板或管理工具。

## 已观察的链路与限制

2026-10-11，在 Linux、Node.js 24.21.0、Codex CLI 0.160.1 和启用视频的 Strata 部署上进行了手工操作：

- 原生 `codex exec -p strata-video --ephemeral` 会话实际发出 `mcp_tool_call`，分析六秒的红、蓝、绿顺序视频，工具及最终回复都正确给出约 0–2、2–4、4–6 秒的顺序；整轮约 53.4 秒。主会话在该次运行中临时选择 Strata，配置档本身不修改默认模型。
- 损坏 MP4 返回 HTTP 400，MCP 返回 `upstream_http` 并继续服务。该操作发现并修复了丢弃未消费 HTTP 响应体时 Undici 的未处理错误事件。
- 要求长文且输出额度设为 4096 的请求约 24.1 秒后返回 `upstream_incomplete`，未将部分生成返回为成功。
- 观察到 Strata 正在生成后发送 MCP 取消通知，约 0.96 秒后服务状态为 `busy: false`、`queued: 0`；同一 MCP 的下一次短视频分析成功。这个观察覆盖生成阶段，不证明编码阶段取消也已实测。
- 用一条任务自有的长生成请求占用推理队列，视频 MCP 排队 66 秒后取消该自有请求，视频于约 67.77 秒成功返回正确颜色顺序。没有改服务配置或模拟响应；结束时服务为 `busy: false`、`queued: 0`。这覆盖 MCP 的真实长等待，不等于已观察 Codex UI 中超过 60 秒的调用。
- 64 MiB 加 1 字节的文件和空文件均在本地返回 `video_size`；错误密钥返回受控 HTTP 401，随后同一 MCP 的 ping 正常，进程退出码为 0。
- 提交 119 秒视频约 2.09 秒后，观察到 `busy: false`、`queued: 1`，在该准备阶段取消。约 0.77 秒后队列清空，但 `videos` 变为 `false`，下一次视频返回受控 HTTP 503。这与上游编码中断后停止视觉编码器的源码路径一致；未直接读取远程编码器进程日志。随后一次普通文本请求约 1.55 秒完成，`videos` 恢复为 `true`，再次通过 MCP 分析短视频成功；没有重启服务或修改上游代码。
- 关联审查复现并修复了重复活动 ID 产生两次响应、stdout 背压暂停输入导致取消延迟的问题。修复后，重复 ID 只返回一次错误；延迟输出的手工内存流交互仍立即读取取消，目标调用没有再返回结果，`drain` 监听器数量为 0。数组能力声明返回 `-32602`，损坏 UTF-8 入站消息返回 `-32700`。
- 不消费输出的手工交互在缓冲到 8387931 字节后，下一条将超出 8 MiB 时关闭输入输出，未积累 `drain` 监听器。修复后再次运行原生 Codex CLI，观察到一次成功的视频 MCP 调用和正确的红、蓝、绿最终回复，整轮约 46.8 秒。
- 增加绝对路径后，通过真实 stdio MCP 分别提交授权子目录中的绝对路径和原有直属文件名，两次 Strata 分析均返回红、蓝、绿的正确顺序，结果保留各自输入的 `video`，进程退出码为 0。同次交互中的目录前缀碰撞（同名前缀的相邻目录）、`..` 路径、相对子路径及链接子目录均被拒绝。该路径观察在 Linux 上完成，未重复进行 Codex UI 验收。
- 渠道附件入口加入后，共享暂存器生成随机 `attachment`，真实 stdio MCP 调用 Strata 返回正确颜色顺序；同时提供 `video` 与 `attachment`、越界引用、通过普通路径读取附件目录均被拒绝，过期引用返回 `attachment_expired`。进一步运行真实原生 Codex CLI，观察到 `analyze_video` 使用 `attachment` 成功调用，最终回复“红 → 蓝 → 绿”，整轮约 45.2 秒、退出码 0；配置只通过当次进程覆盖，未修改用户配置。
- 容量和退出手工交互中，第九个文件返回 `video.capacity`，目录保持八个文件；销毁正在等待数据的输入后，调用返回受控错误且无残留。相同或互相包含的本地/渠道根目录返回配置错误。
- 飞书 Inbox、Telegram grammY 入口和微信 type 5 解析/解密进行了本地交互，使用真实视频字节和替换的平台下载/提交观察端口；覆盖拒绝未授权、撤权/关闭后的迟到结果、失败清理、说明文字不作为斜杠命令以及微信密文长度与明文长度区分。Application 提交守卫的本地交互使用生产会话锁和替换的路由/执行端口，工作区、Thread、权限变化及等待锁期间撤权均拒绝提交。这些观察不等同于真实平台收件、真实 App Server 绑定切换或渠道最终回复验收。

没有进行 Codex Desktop 界面、Windows/macOS 或 Node.js 22.13 的实机验收；当前 Linux 主机没有图形会话。合成视频说明接入和简单时序路径可用，不代表真实复杂视频的识别准确率。
