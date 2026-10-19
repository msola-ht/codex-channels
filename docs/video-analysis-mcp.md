# 视频分析 MCP

`scripts/video-analysis-mcp.mjs` 提供独立 stdio MCP 工具 `analyze_video`。Codex 调用工具，工具将指定视频和问题发送给管理员配置的 Strata `/v1/responses`，再把分析文字返回 Codex。不修改 Codex 本体，不经过 Gateway 的 Provider Proxy，不写会话历史或数据库，也不安装、启停 Strata。

入口使用 Node.js 22.22.0+ 和项目已有的 `undici`，无新增依赖。运行前完成本项目正常依赖安装。工具默认不启动，由配置它的 MCP 客户端管理进程。

## 链路与前提

```text
Codex CLI / App → stdio MCP → 附件授权与身份检查 → Strata Files（首次上传）→ file_id → Responses → 分析文字
```

Strata 必须已部署支持 `input_video` 的版本，启用视频、加载模型及兼容的视觉编码器。普通上游发行版是否支持应按实际部署确认；HTTP 200 的 `/health` 不等于视频可用，视频部署的 `videos: true` 才表示该项准备就绪。

这个工具分析画面，音轨被 Strata 忽略；每次推理独立，只缓存授权文件到 Strata 文件引用的映射，不缓存答案或问答历史。没有添加 CLI/App 视频上传按钮。本地视频通过 MCP 主机的本机文件路径读取，`STRATA_VIDEO_ROOT=any` 时不限定目录；飞书、微信、Telegram 可接收视频附件并把单文件随机引用交给当前会话。Desktop 使用远程 App Server 时，文件和 MCP 命令应在启动 MCP 的主机可用。

## 配置

只读取以下环境变量，不自动读取 Gateway Provider 配置、用户凭据文件或 `.env`：

| 变量 | 含义 |
| --- | --- |
| `STRATA_VIDEO_BASE_URL` | 必填，固定 Strata 服务根地址，例如 `http://192.168.50.54:8080`；不要附加 `/v1`、凭据或查询参数 |
| `STRATA_VIDEO_API_KEY` | 必填，部署的 API Key；通过环境传入，不作为工具参数 |
| `STRATA_VIDEO_MODEL` | 必填，部署接受的精确模型 ID |
| `STRATA_VIDEO_ROOT` | 必填，已存在的视频目录绝对路径，或字面值 `any`（不限定目录，只接受本机绝对路径）；配置向导的 Strata 预设写为 `any` |
| `STRATA_VIDEO_CHANNEL_ROOT` | 可选，Gateway 数据库旁的 `uploads/video` 绝对路径；用于渠道随机附件引用，必须已存在。它可以位于本机视频目录内，但不能等于或包含本机视频目录 |
| `STRATA_VIDEO_TIMEOUT_SECONDS` | 单次调用总时限，包含文件读取、上传、排队、准备和生成；默认 900 秒，范围 1–1800 秒 |
| `STRATA_VIDEO_TRANSPORT` | 默认 `files`，上传一次后复用引用；旧 Strata 或未启用文件接口时，由操作者显式选择 `url`，每次完整发送 Base64 视频；其他值拒绝启动 |

`STRATA_VIDEO_ROOT` 是本 MCP 实例的文件读取范围。配置为已存在目录时，接受直属普通文件名，或该目录及其子目录内的本机绝对路径；配置为字面值 `any` 时不限定目录，只接受本机绝对路径（例如 `/data/videos/project/clip.mp4`），不再接受直属文件名。两种方式都拒绝目录外路径（前者）、相对路径（例如 `sub/clip.mp4`）、含 `.`/`..` 的路径、URL、符号链接和硬链接，子目录也不能通过链接跳转。使用目录模式时该目录应是由当前操作者控制的专用视频目录，不应是家目录或整个仓库；使用 `any` 时任何能调用该工具的会话都能指定本机任意视频路径，只应向可信会话提供该 MCP。不要让不可信进程替换目录、其父目录或其中的子目录。支持 MP4、MOV、WebM、MKV、AVI、TS，实际解码能力仍由 Strata/FFmpeg 决定。

共享 App Server 或全局 MCP 配置可能把同一工具提供给多个工作区；本工具没有渠道 Actor 身份，不按 Gateway Workspace Registry 二次授权。只向有权访问本机视频文件的客户端/会话启用 `video` 输入。渠道走独立 `attachment` 能力引用：目录模式下，本机视频目录不能等于渠道附件目录，也不能位于渠道附件目录内。本机视频目录可以包含渠道附件目录，但本机路径入口会拒绝读取渠道附件目录内的文件，渠道附件只能通过随机引用读取。

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
# 或 "any"：不限定目录，只接受本机绝对路径。
STRATA_VIDEO_ROOT = "/absolute/path/videos"
STRATA_VIDEO_TIMEOUT_SECONDS = "900"
STRATA_VIDEO_TRANSPORT = "files"
# 需要渠道附件时另加；以实际 StateStore 数据库目录为准，须先启动 Gateway 创建目录。
# STRATA_VIDEO_CHANNEL_ROOT = "/absolute/path/gateway-data/uploads/video"
```

Windows 将 `args` 和 `STRATA_VIDEO_ROOT` 替换为 Windows 绝对路径，可使用 TOML 单引号保留反斜杠；`any` 在 Windows 上同样表示只接受本机绝对路径，因此多盘符无需逐个列出。macOS/Linux 保持对应主机的绝对路径。`node` 必须在启动 MCP 的宿主 PATH 内，否则使用 Node 可执行文件绝对路径。

`env_vars` 只转发宿主实际已有的环境变量，不会自动创建密钥。CLI 从启动它的环境继承；Desktop/独立 App Server 必须在自己的启动环境中具备该变量，终端临时 export 不保证 GUI 或后台服务可见。不要把密钥提交到仓库。缺少任何必填设置，MCP 启动即失败，不回退到其他模型服务。

Codex 客户端的 `tool_timeout_sec` 应大于 MCP 总时限，留出取消收尾时间。锁定 CLI 的原生缺省调用超时为 300 秒，通用添加向导显式填写 60 秒，两者均短于视频默认 900 秒分析时限；Strata 预设显式填写 960 秒。修改配置后按所用客户端方式重新加载 MCP；视频脚本本身不改用户配置或重启服务。配置字段参见 [Codex MCP 文档](https://developers.openai.com/codex/mcp)。

## 使用

也可先运行 `codexc config → 工具与 MCP → 新增 MCP → Strata 视频分析预设`，输入服务根地址、模型 ID 和 API Key，再选择工具调用审批，随后查看脱敏摘要并确认保存；不询问任何目录。审批选项及优先级见[工具与 MCP 设置](user-guide.md)。预设固定使用文件引用模式 `files`（需要 Strata 启用 `video_files`），分析总时限 900 秒、启动超时 10 秒、调用超时 960 秒，默认启用；其他传输方式或分析时限可通过自定义 stdio 或原生配置设置。本机视频范围写为 `STRATA_VIDEO_ROOT=any`，即任意本机绝对路径都能分析（不限定目录，也不接受直属文件名）。预设要求当前 Gateway 配置已存在且通过结构校验；文件缺失、不可读或无效时停止，不猜测目录。渠道附件目录自动取 StateStore 数据库旁的 `uploads/video`（默认 `<数据目录>/data/uploads/video`），相对数据库路径以配置文件所在目录为基准，保留路径文本中的空格；范围、目录与目标 Codex 配置文件都会在确认摘要中显示。预设固定使用渠道提示引用的名称 `strata_video`，自动填写当前安装的 Node/脚本绝对路径，调用超时保持比分析总时限多 60 秒，思考默认 `medium`，预算由 Strata 管理。

交互保存使用当前 Codex Home 的用户配置，影响使用该配置的会话；确认前会显示目标路径、目录授权范围和启用状态。API Key 隐藏输入并写入该用户配置，不回显；若希望密钥只从宿主环境继承，可使用上方手工 `env_vars` 配置。已有同名条目不会被覆盖。最终确认前取消，不创建渠道附件目录、不写入 MCP；确认后再次核对 Gateway 推导出的目录，若已变化则停止。随后创建目录，按 Gateway 暂存器的要求拒绝符号链接、非目录和其他用户拥有的目录，并设置平台私有权限；目录准备失败时不保存 MCP。确认后的配置写入若失败，已准备的目录会保留。保存不等于 MCP 已连接，需要重新加载 MCP 或在新会话中使用；不会自动重启服务。保存的渠道目录是当时的配置值，之后更改 `storage.database_path` 时需同步调整 MCP 环境配置。

使用预设的 `any` 模式时，直接提供 MCP 所在主机的视频绝对路径。例如对 Codex 说：

> 使用 strata_video 的 analyze_video，分析 /data/videos/project/clip.mp4 中按时间顺序发生了什么，标明关键事件时间戳。

工具参数：

```json
{"video":"/data/videos/project/clip.mp4","question":"按时间顺序描述关键事件，时间只标可靠的近似值。"}
```

仅在手工配置的目录模式下（例如 `STRATA_VIDEO_ROOT=/data/videos`），才可用直属文件名读取 `/data/videos/clip.mp4`：

```json
{"video":"clip.mp4","question":"描述视频中的主要事件。"}
```

直属文件名最多 255 字符（仅目录模式），绝对路径最多 4096 字符；路径必须采用 MCP 主机的系统格式。Windows 使用盘符绝对路径，例如 `C:\\Videos\\project\\clip.mp4`（JSON 中反斜杠需转义），不接受 UNC、设备路径或备用数据流。POSIX 路径不接受反斜杠和冒号。不展开 `~` 或环境变量。目录模式下授权目录启动时解析为真实路径，绝对路径应使用该真实目录；`STRATA_VIDEO_ROOT=any` 时本机任意绝对路径都可用，工具参数仍不能改变这一范围，要收紧范围应由操作者改回目录模式并重新加载 MCP。两种模式都不能用本机路径读取渠道附件目录内的文件，渠道附件只接受 `attachment` 引用。成功结果的 `video` 保留调用时传入的文件名或绝对路径。

`question` 必填，最多 16000 字符；`video` 和 `attachment` 必须且只能提供一个。`reasoning_effort` 可选，展示等级为 `none`、`low`、`medium`、`xhigh`，默认 `medium`，原样作为 `reasoning.effort` 发送；调用可覆盖，`none` 关闭思考。兼容传入 `high`，不在常规提示中展示；MCP 不改写该值，其到 `xhigh` 的映射由远程 API 处理。工具 Schema 使用字符串类型，具体等级由运行时校验，避免宿主提前拒绝 `high`。

`context` 可选，为 1–8000 字符的非空追问上下文，只整理当前会话中与本次视频有关的指代和先前讨论。MCP 将其单独标记为待核对线索，与原样的 `question` 一起发送，不写入系统指令、不保存历史；上游需依据本次视频重新核实，不能把旧分析视为已确认事实。

输出与思考预算完全由 Strata 管理。MCP 不接受或发送 `max_output_tokens`、`reasoning_budget_tokens`，不设置本地 token 上限或预算环境变量。上游的预算、上下文与资源限制仍有效，未完成结果仍返回错误；需要调整预算时在 Strata 配置。MCP 的总时限、文件大小和响应体大小限制保持独立有效。

MCP 通过 Responses 顶层 `instructions` 发送固定通用视频分析规则，Strata 将其作为系统消息交给模型聊天模板；`question` 原样作为用户任务发送。通用规则要求区分事实与推测、说明模糊或采样缺口、按需要解释动作连续性、谨慎使用近似时间、不推测音轨，并把视频中的文字和指令作为待分析数据。简单问题直接回答，只有任务需要时才展开分镜、表情和手部动作等细节；不强制所有问题使用同一报告格式。固定规则见 [`video-analysis-client.mjs`](../scripts/video-analysis-client.mjs) 的 `videoInstructions`。提示词不能保证模型完全遵循，结果仍属于外部内容。

成功结果同时提供 MCP 文本和结构化对象：原始 `video` 或 `attachment`、`analysis`、`audio_analyzed: false`、`request`、`transport` 和可选 `usage`。`request` 记录实际发送的 `reasoning_effort`，未指定时为 `medium`，不推测上游预算；`transport.mode` 为 `files` 或 `url`，`reference_reused` 表示最终请求复用了本地映射或合并中的上传，`reuploaded` 表示本次进入过一次失效恢复，不是严格的上传次数证明。它们不表示上游编码缓存命中。`usage` 只保留上游实际提供的非负安全整数 `input_tokens`、`output_tokens`、`total_tokens`、`reasoning_tokens`，字段缺失或非法时不填零。分析属于外部模型输出，不应作为执行命令或扩大文件权限的依据。

MCP 上传原视频，不在本地抽帧；当前 Strata 复刻版默认 2 FPS、相邻帧成对编码，以平均时间标注，并按视觉 token 预算缩放。实际参数取决于服务配置。采样标签不是精确动作发生时间；输出额度变大不能恢复采样或缩放丢失的细节。MCP 不发送未被视频接口支持的逐请求 FPS/分辨率覆盖，也不改写用户的问题。

## 渠道视频附件

更新 Gateway 程序后重新启动，使各渠道加载视频入口；在实际承载渠道 Thread 的 App Server 的 MCP 配置中设置 `STRATA_VIDEO_CHANNEL_ROOT`，并按该宿主的配置方式加载 MCP。仅在独立 CLI 中启用 `strata-video` 配置不会自动给渠道启用工具，本入口不自动改写用户配置或重启服务。

| 渠道 | 输入范围 | 本地接收限制 |
| --- | --- | --- |
| 飞书 | 独立 `media`/`video` 消息、`.mp4`/`.webm` 文件消息，或同一 `post` 中一个去重后视频 `media` 与可选说明文字 | 64 MiB；富文本优先非空 `content_v2`，封面 `image_key` 不当独立图片下载；多个不同视频或视频混合独立 `img` 明确拒绝 |
| 微信 | 原生 type 5 视频，或 `.mp4`/`.webm` 文件消息 | 64 MiB 明文；原生视频必须有 AES key，声明 `video_size` 按密文校验 |
| Telegram | `video`、`video_note`，或视频 MIME/MP4/WebM 文件消息 | 20 MiB 下载限制；GIF/animation 保持原有图片路径 |

飞书 `post` 的 `media` 是[官方视频标签](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/create_json)，同一条消息中的说明文字与视频一起提交，重复的同一 `file_key` 只下载一次。消息资源 API 的 `type=file` 表示下载资源类型，不把视频变成文本附件；独立 UTF-8 文本文件仍保持 1,000,000 字节上限。富文本视频入口尚待真实平台收件、MCP 调用和最终回复验收。

授权后下载，校验 MP4/WebM 容器签名后保存到私有目录，当前会话收到 `attachment` 引用和有效期，不收到本机路径或平台下载密钥。例如模型调用：

```json
{"attachment":"feishu/12345678-1234-4123-8123-123456789abc.mp4","question":"按时间顺序描述视频。"}
```

示例引用不能实际使用，必须采用当前消息生成的值。附件引用包含随机 UUID，是单文件的持有者凭据，不是可伪造 Actor 参数的替代身份系统；不得转发给其他会话。它只在接收授权后交付给当前 Conversation，MCP 不提供枚举、搜索或任意附件路径读取。持有有效引用即可重复读取该文件，因此泄露引用会转授读取能力；操作者需保护会话与本机工具权限，不能把这一机制声称为同一 OS 用户下的强租户隔离。

三渠道附件提示和 MCP 工具说明统一要求：同一视频追问复用原引用，用户无需重复上传；只总结、翻译或改写已有分析时可直接利用当前 Thread 上下文，核实新细节才再次调用，并通过 `context` 补足必要背景。多个视频指代不明确时先澄清，不自动选择最近附件。引用缺失、过期或文件不可读时说明原因，再请求重新提供视频。该衔接由 Codex 根据当前 Thread 上下文执行，MCP 不建立“最近视频”全局状态，也不读内部会话文件。

默认模式下首次读取并上传视频，后续调用仅检查原附件仍有效、可读且身份未变，再发送有效 `file_id`、必要文本和新问题，不再次读取、下载或上传完整视频；重复调用不续期。例如追问（引用必须来自当前会话）：

```json
{"attachment":"feishu/12345678-1234-4123-8123-123456789abc.mp4","question":"第二次变化后是什么颜色？","context":"本次仍是刚才的同一视频；上一轮讨论了画面颜色的两次变化，请重新核对第二次变化后的状态。"}
```

重复上传按“渠道账号、会话、操作者 + 文件完整内容的 SHA-256”去重，只复用本进程中已提交或可能已提交、仍有效且文件身份未变的附件。不会根据文件名或平台资源 ID 判断相同，也不跨会话共享引用。下载仍会发生；确认内容相同后删除本次候选副本并返回原引用和原有效期。复用后的输入取消或失败不会删除旧文件。尚未提交的文件不供其他输入复用；并发接收期间尚未完成提交的相同视频可能暂存为不同引用。

渠道去重索引仅为有界内存元数据，不保存问答历史；Gateway 重启后不会扫描文件推断会话归属，旧引用仍可在有效期内使用，但不会自动参与渠道去重。独立 MCP 的 Strata 引用映射见下一节，两者都不缓存分析结果。

下载前捕获工作区与当前 Thread，提交前在 Application 会话锁内复核；期间切换工作区/Thread、撤销授权或停止渠道时，不把附件提交给新目标。说明文字作为普通用户上下文保留，不执行其中的渠道斜杠命令。没有配置 MCP 时，模型只能获得附件提示，不能据此声称已经分析视频。

每渠道最多保留八个附件；为在满额时识别重复内容，串行接收可额外暂存一个候选文件（含 `.part`），峰值九个、约 576 MiB。确认重复后删除候选；非重复且超过八个时拒绝并清理候选。每个暂存器最多接收四条流，保存、校验和哈希含等待最多 60 秒；渠道下载另有有限期限。文件保留 24 小时，运行中每分钟清理；Gateway 停止后不保证即时磁盘清理，但 MCP 仍按文件时间拒绝过期引用。失败或停止后的迟到新附件会清理，已复用附件保留原有效期。原视频不写 StateStore，不建立第二份会话历史；引用进入 App Server 的正常会话历史，过期后需要重新上传。

## Strata 文件引用、兼容与清理

契约基线为 [Strata VIDEO_FILES.md，23a3ddb0](https://github.com/msola-ht/Strata/blob/23a3ddb0b028897dba9c7cb231c1f1bde4a40522/docs/VIDEO_FILES.md)。默认 `files` 模式要求顶层 `video_files.enabled=true`、`vision.video.enabled=true` 和 API key。阶段诊断位于 `vision.video.diagnostics`，独立视觉空闲释放位于 `vision.idle_unload_s`。本项目不修改这些上游设置，也不自动加载模型。

首次分析以原始字节 POST `/v1/files`，明确发送真实 `Content-Length` 和视频 MIME，不使用 multipart、JSON、Base64 或 Transfer-Encoding。只接受 HTTP 200、完整 JSON、匹配字节数、合法时间及 `status=ready` 的元数据；ready 只说明存储完整，不代表已解码或分析。Responses 使用 `store:false`、`stream:false`，一份请求恰好一个 user `input_video.file_id`，不出现 `video_url`，也不发送 `previous_response_id`、`conversation` 或专用 context 字段。必要历史由 MCP `context` 作为普通 user 文本摘要传递，旧分析仍是待核对线索。

映射仅在 MCP 进程内存在，最多 64 项（包括正在上传的项），不落盘、不存视频字节、问题或答案。键绑定服务地址、密钥身份、授权根、精确随机引用或本地规范路径以及 dev/ino/size/mtime/ctime；不按内容哈希合并不同引用或授予权限。每次使用前重新打开本地文件检查可读性、路径和身份，但命中不读取内容。沿用原有持有者凭据模型，不新增跨会话授权，也不能抵抗引用泄露或同一 OS 用户篡改。

截止时间取上游 `expires_at` 与原渠道附件有效期的较早者；访问不会续期。每次查找清理过期项；无调用时元数据保持在固定容量内，进程退出全部释放。满额返回 `file_cache_full`，不淘汰有效引用后偷偷重复上传。MCP 不发 DELETE，也不在分析结束、取消、失效或进程退出时删除远端文件，避免伤及共享请求；由 Strata TTL 和自身租约回收。MCP 重启会丢失本地映射，之后可能再次上传；跨 MCP 进程不合并上传。操作者可用 Strata 自带 GET/DELETE 管理文件，本工具不暴露 file_id 读取能力或管理工具。

同一键的并发首次调用共享一次读取和上传。最多 4 个上传生产者，计数包含取消后的清理；生产者有独立总时限，后加入者不延长。单个等待者取消只退出自己的等待，最后一个等待者离开才取消未完成上传；失败、取消或不完整结果不发布映射。已经完整发布的上传可以保留供后续调用复用。上传成功但客户端未收到确认时可能留下远端文件直到 TTL；不承诺 exactly-once，不对不确定上传自动重试。

只有 Responses 的受控 `video_file_not_found`（HTTP 404）、`video_file_expired` / `video_file_deleted`（HTTP 410），或 HTTP 200 JSON 失败终态中的这三个错误码，会移除对应旧映射，并在本次总时限内最多重新授权、上传和重试一次。状态码与错误码不符合上述组合时原样报告受控错误，不推断文件已失效。并发失效只移除自己使用的旧映射，复用其他调用已经建立的新映射或进行中的上传。原文件已删除、过期、不可读或身份异常时停止并要求重新提供视频。缓存淘汰、缓存损坏、视觉加载失败、上下文不足、生成失败、409 not-ready、认证、限流、上传超时或容量故障均不触发自动重传。

没有自动探测或静默降级。旧版普通 404、`video_files_disabled`、401、429、5xx 等均保留错误；操作者通过自定义 stdio 或原生配置明确设置 `STRATA_VIDEO_TRANSPORT=url` 后才使用原 Base64 `video_url` 路径，结果和错误诊断中可见实际模式。Strata 预设固定采用 files；已有配置未写此变量时也采用 files，因此旧部署需显式设置 url。回滚只需恢复 url 并按宿主方式重新加载 MCP，无数据格式迁移，不需删除文件或修改 StateStore。

`file_id` 避免重复传输视频；有效引用与编码缓存是不同生命周期。上游缓存命中可跳过解码、抽帧、视觉编码，但仍组装提示词并推理；缓存淘汰会重新预处理，无需重新上传。编码器每次重新加载更新缓存身份，视觉空闲释放后可复用文件引用，但会重新预处理。URL 路径不使用这套缓存。只有上游 `source=file` 与 `cache=miss/shared/hit` 阶段日志能确认实际路径和编码命中，expert cache 不是视频缓存，客户端不推测命中。

## 资源、取消与错误

- `upstream_incomplete` 表示服务明确返回 `incomplete`；`details` 提供请求参数、可用用量及白名单原因。`max_output_tokens` 表示服务报告长度受限，不单凭该原因断言预算耗尽：低用量中断还可能是服务生成异常。`upstream_failed` 单独报告服务失败，只保留白名单错误码；未知或缺失终态返回 `upstream_format`。均不返回部分答案或思考正文；仅前述明确文件失效允许一次恢复，生成失败不自动重试。
- 未知上游错误正文、状态字符串、原因及错误码不会直接透传；HTTP/失败终态保留数字状态和文档白名单 `upstream_code`，以及请求参数和传输诊断。失败终态仍保留 `status:failed` 和上游提供的合法 `usage`；成功与失败用量均不包含模型思考内容。

- 渠道附件在首次等待前登记取消作用域，120 秒总时限包含排空前序输入、下载和等待提交；排空后、下载前捕获工作区与 Thread，不重置时限。`/stop` 会取消当前会话正在准备的视频，包含尚未开始下载的输入，防止停止后又启动新任务。下载期间切换工作区、Thread 或撤销授权后，原附件也不会提交。
- 确定尚未提交的失败会删除本次新暂存文件，不删除复用的旧附件；如果提交请求可能已经发出、但确认丢失，文件保留至原定过期时间并可参与去重，不自动重试，避免已进入 Thread 的附件引用失效。

- 每个 MCP 进程最多一个正在运行的分析；并发调用立即返回 `busy`。不同进程仍由 Strata 自己管理负载。
- 重复使用活动请求 ID 会取消原调用并只返回一次协议错误。慢读客户端不会阻止 MCP 读取取消通知和输入关闭；待输出的 UTF-8 字节（含下一条消息）上限为 8 MiB，超限会关闭连接并取消活动调用。该上限包含分析结果的文本与结构化双份表示。
- 视频上限 64 MiB，使用有界读取并检查文件是否在读取中变化。files 模式仅上传原始字节，url 模式的 Base64/JSON 内存和请求体大于原文件大小；不会自动截断视频或改变采样率。时长、帧数、视觉 Token 等沿用 Strata 服务端限制。
- 使用非流式 Responses JSON，等待完整结果，无心跳续期。总超时独立生效，不受 HTTP 数据到达影响，包含有界失效恢复；其他故障不自动重试。响应体上限 2 MiB。JSON `response.failed` 或 `status:failed` 均失败；若上游无视 `stream:false` 返回 SSE，按 `upstream_format` 拒绝，不消费流中部分文字，不因 HTTP 200 判成功。本工具不新增流式协议支持。
- 文件读取在分块之间检查取消，不保证能中断失去响应的内核文件 I/O；不要使用可能挂起的网络文件系统作为授权目录。
- MCP `notifications/cancelled`、stdin 关闭、SIGINT/SIGTERM 会中止当前 HTTP 请求并关闭本工具资源。上游是否及时停止编码/推理取决于部署的断连处理；本工具不调用卸载模型接口。
- 编码阶段取消可能停止视觉编码器以避免消费残留响应。新版 Strata 配置独立视觉空闲释放时，后续视频请求可走其编码器加载路径；加载失败仍以受控阶段错误返回。不要把旧版 URL 路径中“先发普通文本请求恢复”的历史观察当作新版通用恢复步骤。MCP 不自动发送额外推理请求、调用模型加载接口或重试被取消的视频。
- 只接受 HTTP 200、合法 JSON、`status: completed` 且含非空 assistant `output_text` 的结果。断流、无效响应、空结果、`incomplete`/`failed` 均返回错误，不把部分生成冒充成功。
- MCP 入站消息与上游 JSON 响应必须是有效 UTF-8；损坏字节会报错，不以替换字符继续处理文件名、问题或分析结果。初始化的 `capabilities` 必须是对象，不能是数组。
- 禁止 HTTP 重定向，模型参数不能更换目标地址或密钥。HTTP 明文只适合操作者信任的网络；跨不可信网络配置 HTTPS。工具不继承系统代理，直接连接配置的服务。
- 错误只返回固定分类与受限诊断，不返回上游错误原文、Authorization 或请求体。所有正常 stdout 都是 MCP JSON-RPC；配置错误写 stderr。

MCP 使用 [2025-06-18 生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、[工具调用](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)和[取消通知](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)，仅声明 tools 能力，不提供资源、提示模板或管理工具。工具按 [ToolAnnotations](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations) 声明 `readOnlyHint:false`、`destructiveHint:false`、`openWorldHint:true`：它可能在 Strata 新建并保留文件，不应在工具目录或渠道中展示为只读；这些提示不替代授权。

## 已观察的链路与限制

2026-10-12，目录配置修复后的工作区（基于 `190e2f12`）补充观察：

- 在隔离的任务自有 Codex Home 中，经真实 `codexc config` TTY 菜单和 Codex 配置 RPC 保存 Strata 预设。相对配置目录与含前导空格的数据库路径正确保留，保存后的 MCP 配置解析结果与 Gateway 配置加载器推导出的附件目录一致，新目录权限为 `0700`。相对配置文件路径且省略 `storage` 时，确认摘要使用正确的默认目录，没有重复拼接基础目录。
- 最终确认前取消、数据库路径类型错误、TOML 语法错误、确认期间数据库目录变化，以及附件根是符号链接时，均未写入 MCP；取消和配置错误没有创建默认附件目录。确认后的目录变化与链接目录分别返回明确的目录已变化、目录准备失败提示。未修改操作者配置或启动渠道服务。
- 保存后的配置通过真实 stdio 完成 MCP 初始化和工具清单查询；`any` 模式下直属文件名返回 `invalid_arguments`，渠道目录绝对路径返回 `unsafe_file`。未发送视频或调用 Strata，未观察 Windows/macOS 的目录保护及真实渠道收件、推理结果。

2026-10-12，基于 `main`（`c84cd44d`）的全分支审查补充了以下本地观察，均未发送真实渠道消息或运行真实 Strata 推理：

- 真实 stdio MCP 连接任务自有回环 HTTP 服务，首次只上传 27 字节故障材料，`Content-Length` 正确且无 Transfer-Encoding；默认 `medium` 和显式 `high` 均按预期发送。追问复用同一 file_id；`404 + video_file_expired` 返回受控错误且不重传，后续仍可复用；越界路径与未知思考等级被拒绝。占位结果不证明视频分析成功。
- 配置向导经真实 Codex 配置 RPC 向隔离的任务自有 Codex Home 写入 stdio MCP 条目，同名新增被拒绝、取消保存不改变文件。未更改操作者的 Codex 配置。
- Strata 预设不再询问任何目录：以替换的提示与配置客户端驱动、并用真实 TTY 走到保存时，提示序列都没有目录输入，写入 `STRATA_VIDEO_ROOT=any` 和按配置解析出的渠道附件目录；该目录按 0700 创建，已存在时可重复运行，被同名文件占用时在写入前返回明确错误。
- 预设运行使用当前 `CODEX_CONNECT_CONFIG_FILE` 或 `CODEX_CONNECT_HOME` 定位的数据目录；本次实际得到操作者配置旁（`[storage] database_path = "data/gateway.sqlite3"`）的 `data/uploads/video`。写入目标是隔离的临时 Codex Home，未改动操作者的 Codex 配置或 Gateway 配置。
- 真实 stdio MCP 配合任务自有回环 HTTP 观察服务验证任意路径模式：`STRATA_VIDEO_ROOT=any` 时授权目录外任意绝对路径可上传分析，直属文件名返回 `invalid_arguments`，渠道附件目录内的路径返回 `unsafe_file`，同一配置下 `attachment` 引用仍可读取，`tools/list` 的 `video` 参数说明随模式变化。配置校验也接受了覆盖渠道附件目录的本机范围，仍拒绝把本机视频目录设为渠道附件目录或置于其中。上游返回占位分析，不证明真实推理成功。
- 生产 Application 提交作用域的手工交互使用替换的 Router/Core/Turn 端口：目标捕获前停止返回 `true` 并阻止后续捕获；前序输入创建 Thread 后可捕获并提交；未捕获、重复捕获、重复提交、Thread 变化和撤权均被拒绝；确认丢失仍保留 `mayHaveSubmitted:true`。这些观察不等同于真实 App Server 的提交验收。
- 捕获 Thread 后、异步会话准备期间移除绑定的故障输入，修复前会把视频引用提交到替换 Thread；修复后返回 `video.unavailable`，Turn 请求数为零，`mayHaveSubmitted:false`。还拒绝了 Router 返回的 Thread 与当前绑定不一致的结果；首次未绑定的视频仍可经原有路径创建 Thread 并提交。
- 飞书真实 Inbox 同一事件循环先接收视频再接收 `/stop`，修复前停止时尚无视频取消作用域，随后仍下载提交；提前登记后返回 `stop:true`，没有下载或提交。引用读取期间取消会清理新附件并返回明确的 `video.unavailable`，不再显示泛化内部失败。
- 飞书 Inbox → Adapter → VideoStore → Application 的本地链路使用 FFmpeg 生成的 1738 字节 MP4，平台下载和 Codex 执行端口由任务替换：富文本说明保留，同一消息重复 Key 只下载一次，同内容二次消息复用引用且仅保留一个文件。未授权及混合视频图片被拒绝，伪视频内容返回 `video.unsupported`，取消后迟到的 SDK 下载流被销毁。未覆盖真实平台收件及模型回复。
- Telegram `bot.handleUpdate` 与微信 InputAdapter → 长轮询解析 → AES 下载解密 → 暂存 → 提交 → 游标链路使用 1700 字节生成 MP4、替换的平台/执行端口，均保留视频说明和原生引用；微信 1712 字节密文正确解密，视频追加到运行任务后发送确认。微信密文声明超限、非官方 CDN 均在下载前拒绝；Telegram 无声明长度、实际流为 20 MiB 加 1 字节时返回 `video.too-large`。微信 `/stop` 在首次等待期间取消视频时，没有下载或提交，返回受控取消/超时提示，不终止账号监控器。

2026-10-12，文件引用接入在 Linux / Node.js 24.21.0 下进行了手工 REPL 与真实 stdio MCP 入口交互。上游使用任务自有的本地 HTTP 观察端口、假凭据和非视频故障字节，返回明确标注的占位分析；没有模型推理，以下不是 Strata 实机验收，也没有新增或修改测试文件：

- 真实 stdio MCP 完成初始化、首次分析和追问，分别返回 `reference_reused:false/true`，EOF 后退出码为 0。HTTP 观察到一次原始上传、两次相同 file_id 的 Responses，`store:false`、`stream:false`、`reasoning.effort:high`，上下文保持普通 user 文本。
- 客户端额外追问命中时，FileHandle 内容读取计数为 0，累计上传仍为 1；观察到 Content-Length 与 26 字节故障输入一致，没有 Transfer-Encoding。该计数通过任务进程内临时观察文件读取端口获得，不代表真实视频解码成功。
- 并发两调用取消其中一个：一个返回 AbortError，另一个完成，仅增加一次上传。全部取消后两个调用均退出，下一调用重新上传，未复用取消结果。不同密钥、不同附件引用、不同服务端口分别获得独立 ID。
- 持续 `video_file_not_found` 只额外上传一次并停止；一次 `video_file_expired` 后恢复成功且只增加一次上传。加载失败、缓存损坏保持原引用；HTTP 200 的 `response.failed` 返回 `upstream_failed`，意外 SSE 返回 `upstream_format`。401 与 `video_files_disabled` 不降级，显式 url 模式才发送 Base64 `video_url`。
- 本地附件超过 24 小时返回 `attachment_expired`，越界引用返回 `invalid_arguments`，未知 transport 返回配置错误。模拟第一次 Responses 期间原文件被替换，恢复返回 `file_changed`，没有上传替换后的内容；这一观察覆盖审查中修复的跨重试身份问题。
- 本地观察服务器、MCP 子进程和任务临时目录均已清理。没有更改真实服务、用户配置或 Strata 仓库。

同日关联审查修正了工具只读声明，并收紧失效恢复的 HTTP/错误码组合。手工故障输入 `404 + video_file_expired` 在修复前产生两次上传、两次 Responses，修复后为一次上传、一次 Responses 并返回受控错误，后续正常问题仍复用原映射；合法 `410 + video_file_expired` 仍只增加一次上传并恢复。真实 stdio `tools/list` 返回 `readOnlyHint:false`，渠道展示函数实际输出“可能写入”；这些观察使用本地占位服务，不证明真实渠道已刷新工具元数据。

本轮没有提供可用 Strata 地址、模型和凭据，也未发送真实渠道消息。因此真实 `source=file`、视觉释放前 cache miss→hit、释放后的重新预处理、真实视频纠正旧结论及 TG 最终回复均未验证；容量满额、跨进程复用和 Windows/macOS 也未实机观察。跨进程上传合并本身不在当前内存映射能力内。以下旧版 URL 路径的历史证据不作为新 file_id 路径的验收依据。

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
- 容量和退出手工交互中，第九个非重复文件返回 `video.capacity`，目录保持八个文件；销毁正在等待数据的输入后，调用返回受控错误且无残留。相同或互相包含的本地/渠道根目录返回配置错误。
- 去重手工交互中，同作用域重复上传保留一个文件和原有效期，跨账号、会话或 Actor 得到独立引用；满额重复上传仍复用，过期文件不复用。飞书 Adapter 接共享暂存器的受控输入中，重复输入提交失败没有删除旧引用；提交确认丢失后重传仍能复用。三渠道真实平台收件尚未因此重新验收。
- 暂存引用经 stdio MCP 到真实 Strata 的追问中，两次调用使用同一引用；附带错误颜色结论和“忽略规则”文本时，模型依据视频重新回答绿色，未沿用黄色结论。8001 字符的 context 被本地拒绝，过期引用返回 `attachment_expired`。该样例不保证模型始终抵抗上下文中的指令。
- 飞书 Inbox、Telegram grammY 入口和微信 type 5 解析/解密进行了本地交互，使用真实视频字节和替换的平台下载/提交观察端口；覆盖拒绝未授权、撤权/关闭后的迟到结果、失败清理、说明文字不作为斜杠命令以及微信密文长度与明文长度区分。Application 提交守卫的本地交互使用生产会话锁和替换的路由/执行端口，工作区、Thread、权限变化及等待锁期间撤权均拒绝提交。这些观察不等同于真实平台收件、真实 App Server 绑定切换或渠道最终回复验收。

没有进行 Codex Desktop 界面、Windows/macOS 或 Node.js 22.13 的实机验收；当前 Linux 主机没有图形会话。合成视频说明接入和简单时序路径可用，不代表真实复杂视频的识别准确率。
