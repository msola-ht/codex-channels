# 第三方模型 Provider 接入指南

本指南定义新增“受管第三方模型 Provider”（例如 OpenCode Go 套餐形态的第三方 DeepSeek
服务商）的标准流程、决策点、实现清单、安全边界与验收要求。新增通讯渠道（飞书、Telegram、
微信）不适用本指南，走 [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)。

当前受管第三方 Provider 是编译期注册的：DeepSeek、OpenCode Go 与 CCG 共用同一套受管管道，
Provider 特化只存在于定义能力元数据、Bootstrap 有界工厂、账户和 Setup。
新增 Provider 时优先复用管道，不得动态加载代码，也不得把未知 Provider 回退到 OpenAI 账户查询。

## 1. 接入前决策清单

开始实现前必须逐项确认，未确认或无法验证的项失败关闭：

| 决策点 | 选项 | 说明 |
| --- | --- | --- |
| Provider id | 小写字母/数字/`-`/`_`，1–64 位 | 决定 `sf-<id>.config.toml` Profile、`~/.codex-connect/providers/<id>/` 目录、`modelProvider`、环境变量名 |
| 显示名称 | 1–64 字符 | 出现在 `/model`、WebUI 与完成卡片 |
| wire API | `responses` / `chat_completions` / `messages` | 决定 App Server `model_providers.<id>.wire_api` 与本地代理透传方式 |
| WebSocket | 支持 / 不支持 | 不支持时必须显式声明 `supports_websockets = false` |
| 认证 | `sk-` API Key | 编译期受管 Provider 的 Key 只进入子进程环境或专用私有凭据文件，不写入命令行、日志或 Gateway 配置 |
| 模型目录来源 | 官方目录下载器 / `/models` / 审查后的 JSON | 与 DeepSeek 官方目录一致时可复用现有下载器 |
| 账户形态 | 无 / 余额 / GO 式用量窗口（5h/7d/月 + 本机 Token + 请求窗口快照） | 决定账户适配器实现与 `/usage` 展示 |
| 运行模式 | switching / exclusive | 必须同时支持；marker `mode` 区分 |
| 能力边界 | 文字 / 图片 / 音频 / 网页搜索 / 上下文压缩 | 按真实工具合同声明，不能只看官方页面或 `/models` |

## 2. 上游资料清单

接入前需要拿到并审查以下上游资料：

- OpenAI 兼容 base URL 与认证方式；
- wire API 的请求/响应/流式事件文档，以及当前 CLI 通过 `/responses` 执行的流式压缩是否可用；
- 模型目录来源（`/models` 响应或官方目录 JSON），包含模型名、显示名、上下文窗口、
  最大上下文窗口、支持思考等级、默认思考等级与输入能力；
- 账户接口文档：余额或用量窗口（窗口周期、重置时间、已用百分比）；
- 限流与错误语义（429/5xx/重试），以及是否有 Key 预检接口。

## 3. 实现步骤

### 3.1 定义注册

在 `runtime/model-provider-definitions.mjs` 新增冻结定义并加入
`managedModelProviderDefinitions`：

- `id`、`displayName`、唯一规范 `profileName`、`profileFileName`、`catalogFileName`、
  `catalogManifestFileName`、`managedMarkerFileName`、`backupDirectoryName`；
- `baseUrl`、`wireApi`、`apiKeyEnvironmentKey`、`supportsWebsockets`；
- `defaultModel`、`defaultReasoningEffort`、受控 `models` 列表。
- `capabilities`：只声明已实现的实例展开与账户适配器；无账户能力时显式使用 `none`。模型目录由 Setup 管理，程序更新器不刷新目录。

`profileName` 必须使用项目受管的 `sf-` 前缀，`profileFileName` 必须由
`${profileName}.config.toml` 派生；`codexc remote`、原生 `codex --profile` 和磁盘文件不得再定义别名。
注册后自动获得：watcher 目录路径、`codexc remote --profile <profileName>` 规范名称、
文件布局、`/model` 的 Provider 选项、App Server 启动参数。
Runtime 按 `instanceAdapter` 将所有单实例定义和显式多账户定义展开为运行时注册表；Bootstrap
按账户适配器创建账户窄适配器，并以精确 Provider ID 登记。未知能力和
重复 Provider 适配器均启动失败关闭，不回退 OpenAI。OpenCode Go 与 CCG 多账户实例继承基础定义的能力
元数据；watcher 另保留未配置的共享模型目录，并按 Provider 合并重复定义与路径。

### 3.2 模型目录与 manifest

- 在 `~/.codex-connect/providers/<id>/` 生成 `models.json`，schema 与现有目录一致：每个模型必须有
  `context_window`、非空 `supported_reasoning_levels`、合法 `default_reasoning_level`、
  `display_name` 与输入能力；`max_context_window` 存在时作为窗口占比的换算基准，上下文窗口
  只由「模型上下文窗口」按模型名统一写入，其余字段保持下载原样；`auto_compact_token_limit`
  是独立的上游压缩阈值，不换算为上下文窗口，修改窗口时也不清空该字段；
- 同目录写入 `models.manifest.json`：来源 URL、sha256、下载时间；Profile（切换模式）与固定
  基础配置仍位于 `~/.codex`，原生 `codex --profile` 只识别该目录；
- 目录按 Provider 隔离；同名模型（如两个 Provider 都提供 `deepseek-flash`）是独立选项，
 模型 key 为 `provider + model`；
- 可选模型以各 Provider 生成的模型目录为准：OCG/CCG 以 DS 完整目录为基础，复制 Flash 内容增加 V4.1，并按 Provider 映射模型 ID；目录不再声明的旧模型名不会出现在 `/model` 与 Setup 选项中；
- 默认模型写入 Profile 后，Profile 顶层 `model_reasoning_effort` 必须镜像目录默认值，
  运行时校验不一致即失败关闭。

### 3.3 本地价格

本项目不在本地计算或估算模型价格与费用，不抓取价格目录、不刷新汇率，也不保存价格快照；
新增 Provider 不实现计价器。官方账户接口返回的余额、配额窗口与用量百分比可进入账户适配器。

### 3.4 账户

- GO 形态：通过 `opencode-go-account-adapter.ts` 工厂按账户 Provider ID 创建适配器，复用
  usage URL、凭据读取和指标库 Provider 过滤；
- 余额形态：通过 `deepseek-account-adapter.ts` 受控创建；该适配器只接受 DeepSeek Provider，
  不会把未知 Provider 当作余额账户。
- 无账户接口：`/usage` 明确显示不支持，不回退 OpenAI；仍可使用显式账户 ID 隔离多个凭据和运行实例；
- 指标库本地用量与 Token 汇总必须按 Provider 过滤；GO 形态还需在统计代理注册窗口
  快照 provider（参考 `opencode-go-quota-windows.mjs`），在请求发生时记录官方
  5h/7d/月窗口 `resetsAt` 快照并写入指标库 `quota_windows` 列（指标库 Schema v9；当前指标库为
  Schema v19，另含子代理运行级父子 Turn 关联与逐请求上游 `User-Agent`），
  读取时对 5 小时滚动窗口按当前时间范围和请求开始时间判定，对 7 天/月度固定窗口优先按快照
  归属；快照缺失或请求开始时已经过期才回退到请求时间。账户窗口只展示官方已用百分比、重置时间
  和本地 Token，不展示总额或费用。

### 3.5 生命周期与空闲 Client 关闭

- 受管 Provider 的统计代理与隔离 App Server 支持按需启动；Gateway 全局空闲策略统一关闭已连接
  Provider Client 并停止对应 App Server 进程（含主实例），不按 Provider 类型区分；
- 关闭条件（全部满足）：没有任何前台或后台 Conversation 绑定、没有进行中的 Provider 操作或
  启动任务，且该空闲状态持续 60 秒；宽限期内新消息、恢复 Thread、Provider 操作或启动任务会取消
  本轮关闭。关闭不删除 Thread 持久数据；服务进程保持运行，再次选择模型、恢复 Thread 或使用对应
  Remote TUI 时自动按需启动并重连；
- `codexc remote` 必须在 TUI 生命周期内持有 Supervisor Provider 租约；租约存在时手动停止必须
  失败关闭，连接退出或异常断开时自动撤销租约；
- **释放通知**：渠道会话空闲自动解除后先向当前渠道发送一次自动解除提示；60 秒宽限期结束仍无任何
  绑定或活动时，先向所有已知授权渠道发送一次“所有模型连接已空闲，空闲的 App Server 即将停止”的通知，
  再关闭 Provider Client 并停止未被租约占用的 App Server 进程。没有已知授权渠道时只记录日志，
  不向未知会话广播；手动新建、切换或后台任务结束导致的无绑定关闭不发送这条全局提示。

### 3.6 Setup

- GO 形态优先复用/参数化 `opencode-go-setup.mjs`；否则新建 `scripts/<id>-setup.mjs`；
- 必须包含：API Key 校验、switching/exclusive 选择、模型目录下载与校验、Profile/
  基础配置写入、管理标记、首次备份、失败回滚；
- 文件权限 `0600`，目录 `0700`，符号链接与越权读取失败关闭；
- `codexc setup` 菜单同步加入入口。

### 3.7 测试

至少覆盖：

- 定义与文件布局（`model-provider-managed-runtime.test.ts` 风格）；
- Profile 镜像校验与失败关闭（`model-provider-runtime.test.ts` 风格）；
- 账户适配器：余额或用量窗口、本机 Token 统计、窗口边界、窗口快照归属与缺失回退；
- Setup：新增、更新、恢复、回滚；
- 生命周期：60 秒全局空闲宽限判定、自动解除后的关闭前通知、关闭后按需重连；
- 协议与真实 App Server 合同测试只在 Transport 或共享行为变化时新增。

### 3.8 文档

- 更新 `docs/index.md` 官方资料、支持矩阵与“本项目实现映射”；
- 新增 Provider 专题文档（参考 `docs/deepseek.md`、`docs/opencode-go.md`）；
- 更新根 `index.md` 文档索引；用户可见的入口变化同步到根 `README.md`。

## 4. 安全边界

- Provider id 使用受控列表；模型名来自下载的官方目录，目录缺少的模型不开放；
- base URL 只允许 HTTP(S)，不得包含用户名、密码、查询或片段；
- 编译期受管 Provider 的 API Key 只进入目标子进程环境或专用私有凭据文件；用户自定义 Provider
  可按第 6 节显式写入 `0600` Codex 私有配置。两类 Key 都不得进入命令行、Gateway 配置、日志或平台消息；
- 受管文件必须 `0600`，读取使用 `O_NOFOLLOW` 与属主校验；
- 配置或目录校验失败时等待修复，不允许部分启动或隐式回退；
- 新增 Provider 不得动态加载 npm 包或执行任意代码。

## 5. 验收流程

```bash
npm run verify:commit
npm run install:global
codexc service restart all
codexc doctor
```

功能验收：

- `/model` 能看到带新 Provider 前缀的模型，并可按序号选择；
- 新会话、同 Provider 历史 Thread、跨 Provider 新建 Thread 的模型与思考等级符合预期；
- `codexc remote --profile sf-<Provider ID>` 能拉起隔离 App Server 并共享会话；
- `/usage` 按账户形态展示余额或配额窗口与本机 Token 用量；
- 修改默认模型/思考等级后，watcher 校验通过并在无活动 Turn 时自动重启 App Server；
  设置应用后 Gateway 同步刷新受管模型目录与默认模型，已有 Thread 和手动选择保持不变；
  重启或目录刷新失败时报告应用失败，并沿用 watcher 的冷却重试流程，刷新成功后才报告已应用；

## 6. 用户配置的主 Provider

Gateway 将使用 Responses 接口、复用 Codex 官方模型目录的自定义提供商称为“Codex 兼容 Provider”，
并提供固定与切换两种运行模式。此入口的模型 ID 必须来自官方目录，不支持任意第三方模型 ID。
它读取 `~/.codex/config.toml` 的 `model_provider` 和 `[model_providers.<id>]`；若
`model_provider` 显式配置为 `openai` 时锁定官方 OpenAI，不自动激活候选；未配置且只存在一个候选
时沿用该候选兼容旧配置。自定义 Provider 只在 Gateway 监管的 App Server 子进程中选择。
Gateway 在 App Server 前启动本地统计代理；原配置中的认证方式、模型名、
`supports_websockets` 等字段仍由 Codex 处理。当前只支持 `wire_api = "responses"`，不为它伪造
账户余额或用量接口。

示例：

```toml
model = "gpt-5.6-terra"

[model_providers.thirdparty]
name = "Third-party Responses"
base_url = "https://proxy.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
request_max_retries = 1
stream_max_retries = 0
```

可配置多个自定义主 Provider 候选块，但同一时刻只激活一个：`model_provider` 显式选中时激活
该候选，显式配置为 `openai` 时锁定官方 OpenAI；`model_provider` 未配置且只有一个候选时仍沿用
该候选兼容旧配置。配置自定义主 Provider 时不能同时设置顶层 `openai_base_url`。通过
`codexc primary-provider` 的
`list` / `add` / `switch` / `remove` 管理候选与激活状态。`list --json` 提供稳定的脚本输出，包含当前
主实例、固定候选、切换 Provider 与备份候选摘要，不包含 API Key 或其他认证字段。
`codexc primary-provider switch openai` 不运行登录直接切回官方 OpenAI（执行前会二次确认，并提示
将把 `model_provider` 写回 `openai`；从自定义切回且未指定模型时会清空顶层 `model`），官方凭据保留；切回时自定义候选块移入
`~/.codex-connect/private/primary-providers.json`（0600）并从 config 清理，之后
`codexc primary-provider switch <ID>` 会从备份自动恢复（同样先二次确认，并提示改写主配置的
`model_provider` / `model`）。命令行 `switch` 传 `--yes` 可跳过该确认（仅命令行，Setup 菜单仍会确认）。
`codexc setup` 的“官方 → 登录并恢复官方”
会运行 `codex login --device-auth`（打开终端显示的链接并输入验证码）并执行相同的备份与清理。
从自定义候选切回官方时同时清除该候选留下的顶层 `model`；当前已经是官方模式时保留官方模型。
候选从备份恢复后会消费对应备份项；官方模式下可从 Setup 直接把备份候选编辑为固定或切换模式，或经二次确认删除
备份候选，不需要先切换到第三方。恢复、编辑或 `remove` 都先提交配置，成功后才消费同名备份；
配置写入失败时原备份保持不变，配置已提交但备份清理失败时明确提示部分成功。备份不可安全读取时，
只允许编辑当前 config 中的候选，切换和删除失败关闭。

`requires_openai_auth = true` 使用 Codex 当前 API Key/ChatGPT 认证；也可以按 Codex 官方配置使用
`env_key`，或写入 `experimental_bearer_token` 直接使用 API Key（Key 明文保存在 0600 的
`~/.codex/config.toml`，Codex 官方标注该字段用于程序化使用）。第三方主 API 使用自己的 Key 时
设置 `requires_openai_auth = false`，完全不依赖官方 auth.json，官方登录状态不受切换影响。
主配置选中官方 `openai` 时，管理状态会检查 `CODEX_HOME/auth.json`（默认
`~/.codex/auth.json`）；未检测到该鉴权文件按 OpenAI 官方未登录处理，WebUI Provider 状态不把
官方 OpenAI 作为主 Provider 展示，Setup 总览与 `codexc primary-provider list` 标注“未登录”，
会话 `/model` 不列出官方 OpenAI 模型，只有第三方模型可继续选择。
渠道启动通知同时标注“OpenAI 官方未登录”并给出 `codex login` 或 `/model` 的选择提示；已有官方
Thread 不自动迁移 Provider，若 Turn 返回结构化 `unauthorized`，完成卡片按 OpenAI 官方与其他
Provider 分别提示重新登录、改选第三方或更新对应凭据。
未绑定 Thread 且没有手动选择时，只有一个可选第三方 Provider 就自动使用它的 Profile 默认模型，
不需要另设 Gateway 默认模型；状态、模型菜单和创建 Thread 使用同一提供商与模型。
普通消息及 Goal 查询/设置/清除、Review、Compact、Fork 的自动建会话入口均遵循该规则，
先执行这些命令不会把后续消息绑定回未登录的官方 Provider。
多个第三方 Provider 可选时不按目录顺序决定默认值；仅当全部已配置切换实例都属于同一家 DS、OCG
或 CCG 时使用该家注册表标记的默认账户，混合其他 Provider 时先通过 `/model` 选择提供商和模型，再发送消息；
选择在当前 Conversation 中沿用。官方不可用时，Gateway 的官方 `codex.default_model` 不阻断第三方选择。
已有 Thread 保留自身 Provider，不因官方退出登录而自动迁移。
同一 Provider 内选模型只标记模型待生效；只有实际离开旧 Provider 的 Thread 才提示创建新 Session，
目标 Thread 建立后该提示消失。
`codexc remote` 未指定 Profile 且官方未登录时，自动连接唯一已配置的第三方实例；多个同一家 DS、
OCG 或 CCG 实例且没有混合其他 Provider 时连接该家默认账户，其他多 Provider 配置明确提示指定 `--profile`。
显式 Profile 和固定模式仍按原配置执行。
Gateway 不读取或复制凭据，只把用户配置交给 App Server。`base_url` 必须是无凭据、无查询
和片段的 HTTP(S) 地址；自定义 Provider ID 只能使用 ASCII 字母、数字、`-` 或 `_`，且不能占用
`openai`、`ollama`、`lmstudio`、`amazon-bedrock`、DeepSeek 保留命名空间 `deepseek` / `ds-*`、OpenCode Go 保留命名空间
`ocg` / `ocg-*`、CCG 保留命名空间 `ccg` / `ccg-*`，或其他项目受管 Provider ID。`opencode-go` 仅保留为管理命令和既有磁盘目录的历史名称。

修改后运行 `codexc service restart all`。若上游不支持 Responses WebSocket，必须保留
`supports_websockets = false`，否则 App Server 可能在渠道中出现 WebSocket 建连失败。
Gateway 管理的 DeepSeek、OpenCode Go 与自定义 Provider 统一使用一次 HTTP 失败重试、零次流
断开重连，即首次 HTTP 请求失败后最多再试一次，避免 Codex 默认请求重试和流重连相乘；已有配置
也会在 App Server 服务启动时应用同一边界。OpenAI 官方 Provider 保持 Codex 原生重试策略。

已存在的 Thread 在 Codex 中保留创建时的 Provider：恢复旧会话时，官方实现会用线程保存的
`model_provider` 覆盖当前配置。因此切换 `model_provider` 后，旧会话仍走原 Provider（例如内置
`openai` 加顶层 `openai_base_url`，仍会先尝试 WebSocket 再回退 HTTPS），自定义 Provider 的
`base_url` 与 `supports_websockets` 不会对旧 Thread 生效。要让新 Provider 生效，先使用
`/new` 创建新会话；新 Thread 才读取当前 `model_provider` 并使用本地统计代理，且
`supports_websockets = false` 生效后不会再发起 WebSocket 连接。

会话内通过 `/model` 选择的模型和 Provider 会作为该会话的待生效偏好，覆盖配置文件默认值；
`/model clear` 可清除该偏好，让下一个新 Thread 重新使用 `model_provider` 默认值。Gateway
在固定模式把自定义 Thread 路由到主 App Server；切换模式保持官方 `openai` 主实例，并通过
`~/.codex/sf-custom-<Provider ID>.config.toml` 启动独立自定义 App Server。每个 Profile 完整保存该
Provider 的选择、地址、API Key、默认模型、`model_reasoning_effort = "medium"`、服务层级、
`request_max_retries = 1` 和 `stream_max_retries = 0`；受管 Provider 的新 Profile 也写入同一重试
边界，主 `~/.codex/config.toml` 保持官方配置。
`codexc remote --profile sf-custom-<Provider ID>`
使用与原生 Codex 及磁盘文件相同的 Profile 名称连接该隔离实例；渠道 `/model` 复用 Codex 官方模型目录并以精确自定义 Provider ID 展示同名模型，
跨 Provider 选择沿用现有新 Thread 路由边界。锁定版 App Server 不接受 `--profile`，后台服务会先
严格校验每个 Profile，再把非敏感字段转换为 `-c` 启动参数；API Key 只进入目标子进程环境，
不进入命令行。多个切换模式 Provider 通过私有显式注册表同时保留，并使用独立 Socket 与统计代理。

Codex 兼容 Provider 不接受用户自定义模型目录、第三方 `models.json` 或第三方 `/models` 刷新。服务启动时会用
配置的 Codex CLI 执行 `debug models --bundled`，把 Codex 官方目录原子写入
`~/.codex-connect/providers/custom/official-models.json`（0600），并通过 `model_catalog_json`
注入固定/切换自定义 App Server；目录只随本机锁定的 Codex CLI 版本更新。
自定义 Provider 切换模式可以与受管切换模式
共存，但不能与任何受管固定模式同时启用。需要手填模型时使用下面的自定义 Responses Provider；需要账户能力时，仍按本指南前述的编译期
受管 Provider 流程接入。

可以通过 `codexc setup` 的“模型与提供商 → 第三方 Provider → Codex 兼容”新增或编辑固定、切换模式 Provider：填写上游
`base_url`，从 URL 主机名派生的 Provider ID 与推荐的 `OpenAI` 中选择，只以直接写入 API Key
（`experimental_bearer_token`）认证，再选择固定/切换模式、Responses WebSocket，并手工输入上游
模型 ID。该 ID 必须存在于 Codex 官方模型目录；Setup 不请求第三方 `/models`，也不生成第三方
目录、`models.json` 或自定义 `model_catalog_json`；官方目录快照只在服务启动时生成。新增拒绝覆盖
config 或私有备份中的已有 ID；编辑保持 ID 不变，同一 URL Origin 可留空保留 Key，Origin 变化时必须重新输入，旧 Key
不会用于新上游；无效旧 URL 同样要求新 Key，但不阻止修复。远程上游强制 HTTPS，HTTP 仅允许本机回环地址。
选择 `OpenAI` 时固定同名 `name`，允许 Codex 使用远程压缩；上游仍须兼容对应接口。小写 `openai` 是
Codex 内置保留 ID。固定模式通过 Codex 的 `config/batchWrite` 原子写入用户配置；切换模式不修改
主配置，而维护逐 Provider 的私有 Profile 和注册表。新增默认推荐切换模式，编辑保持原模式；确认预览
明确显示 Key 明文写入的 0600 配置位置。Key 输入不显示不回显；自定义固定模式不能保留其他自定义
切换 Profile，从切换模式改为固定模式前必须先删除其他自定义切换 Provider；受管切换 Provider 可以
共存，受管固定模式必须先恢复官方模式。写入后仍需运行
`codexc service restart all` 生效。Codex 兼容 Provider 入口只接受上述直接 API Key 字段，不接受额外
Provider 块或其他认证、Header、Query 配置。若待编辑 Provider 仍是主配置候选，需先运行
`codexc primary-provider switch openai` 将候选移入私有备份，再编辑为切换模式；Setup 不会留下
同名主配置块和切换 Profile。

## 关联文档

- [`docs/opencode-go.md`](opencode-go.md)：GO 形态参考实现；
- [`docs/ccg.md`](ccg.md)：DS 基础目录适配、多账户隔离与 Command Code Credits 查询的参考实现；
- [`docs/deepseek.md`](deepseek.md)：余额 + CNY 计划价参考实现；
- [`docs/surface-integration-guide.md`](surface-integration-guide.md)：通讯渠道接入；
- [`docs/index.md`](index.md)：协议支持矩阵与实现映射；
- [`docs/codex-cli-upgrade-decisions.md`](codex-cli-upgrade-decisions.md)：Provider 边界决策。


## 7. 自定义 Responses Provider

`codexc setup → 模型与提供商 → 第三方 Provider → 自定义第三方` 与
`codexc primary-provider add --custom-models` 提供相同的新增入口；编辑、列表、切换、删除复用
`primary-provider` 管理链路。WebUI 的 Provider 设置中选择“自定义 Responses Provider”。
此类型使用 `rs-` 开头的 Provider ID（其后 1-61 位 ASCII 字母、数字、`-` 或 `_`），
以便模型目录缺失时明确报错，不回退到官方目录。显示名称禁止使用上游具有特殊语义的 `OpenAI`，
避免启用官方专用协议能力。已有 Codex 兼容 Provider 不自动转换或迁移。

填写平台的 Responses 基础地址（例如 `https://www.zzshu.cc/v1`）、API Key 和一个或多个模型。
CLI 新增或编辑时分别询问是否导入官方 Codex、DeepSeek 模型，勾选平台支持的条目后，逐项填写平台模型 ID，确认“模板 ID → 平台 ID”。多选时按空格勾选、回车确认；空选会提示尚未导入，并提供返回选择或跳过本类模板的选项。两类均可导入，也可跳过后手填。
官方模板读取当前 Codex CLI 的内置目录，排除不会原样作为请求等级发送的 Codex 专用 `ultra` / `persistent` 模式；其余等级与默认值仍需通过 RS 校验，不能转换时明确报错并使用手填入口；DS 优先读取现有本地共享目录；没有时复用 DS 官方脚本下载与提取流程，不执行脚本。读取失败明确报错，不回退其他来源。
官方 Codex 模板仅复制名称、上下文窗口、思考等级和图片能力。DS 模板保存完整模型快照，包括指令、工具类型、详细程度、思考等级描述、输入能力及原始最大上下文；生成时仅覆盖平台 ID、明确调整的参数和跟随的当前上下文。请求使用填写的平台 ID，同一 Provider 内不允许重复。导入后选择默认模型，可调整能力并继续手动添加其他模型。编辑时，唯一已有模板映射会预填平台 ID；同 ID 须明确确认才用模板替换已有模型的名称、能力及关联，默认不覆盖，拒绝则保留原值。按 ID 合并，不重复添加已有条目；同一批导入仍禁止两个模板占用同一平台 ID，未选中的模型继续保留供后续编辑。
模板副本独立保存。DS 模型可选择“跟随模板上下文”，须先配置本地 DS 目录；CLI 或 WebUI 修改 DS 上下文时，现有受管目录事务会同步关联的 RS 模型，平台 ID 与其他能力保持独立。CLI 编辑及 WebUI 可关闭跟随，关闭后保留当前窗口。删除最后一个 DS 账户或重建缺失的 DS 目录前，必须先关闭关联 RS 模型的跟随，避免留下失效关联；同一窗口值再次应用时也会修正跟随副本的差异。没有启用跟随的副本不受源目录变化影响；模型 ID、能力仍须符合平台实际支持情况。WebUI 可编辑保存后的平台 ID 和能力，目前模板勾选入口在 CLI。
每个模型声明准确 ID、显示名称、上下文窗口、图片输入能力、支持的思考等级与默认等级；默认模型必须属于目录。
上下文窗口接受 1024–100000000 Token。思考等级仅接受锁定 Codex 支持的
`none/minimal/low/medium/high/xhigh/max`；留空表示不声明可选等级，启动请求显式使用 `none`，
避免继承官方主配置的思考等级。不会请求第三方 `/models` 或自动推断模型能力。

上游必须兼容锁定版 Codex 的 Responses 流式事件、函数调用、工具结果接续及其请求字段；
“提供 Responses 地址”不代表所有模型均兼容。此入口不转换 Chat Completions，不提供平台专用协议补丁。
这些实例仍关闭网页搜索；模板中的能力元数据不代替上游接口兼容性验证，也不自动启用 WS 或改变审批策略。手填模型和官方 Codex 基础模板使用通用编程指令，不额外声明远程压缩、免费额度、Fast、推理摘要或详细程度；DS 保留各自模板指令及模型能力。当前目录合同没有可独立设置的最大输出 Token 字段。

固定模式把 Provider、默认模型、思考等级及目录引用写入主配置；切换模式保持官方主配置，写入独立的
`sf-custom-rs-<标识符>` Profile，并由现有监管服务启动。渠道 `/model` 从各自真实 App Server
获取目录，跨 Provider 选择仍在新 Thread 生效；已有 Thread 不迁移。切回官方后保留候选和自定义目录，
再次启用候选时使用目录记录的默认模型；删除 Provider 成功且凭据备份清理成功后才清理模型目录和私有恢复快照。
清理中断留下孤立目录时，可再次执行 `codexc primary-provider remove <Provider ID>` 按原 ID 清理残留。

### 自定义 Provider 的 WS 检测

CLI Setup 的 Codex 兼容 Provider 和自定义 Responses Provider，新增与编辑均可在地址、模型及 Key 填写后选择“自动检测”“关闭，使用 HTTP/SSE”或“手动启用”。WebUI 保持手动开关。
自动检测使用当前 Key、选定模型及共享代理，按锁定 Codex 协议向 `/responses` 建立 WS，并发送 `response.create`、`generate=false` 预热；不读取仓库或现有会话内容，不在检测时保存配置，不保证第三方平台免计费。
握手和预热成功仅表示连接与预热可用。可另行确认发送一次极短文字请求（可能产生费用），只有收到有效模型文字输出及完成事件才显示请求验证成功；不代表工具、多轮或所有模型已兼容。WS 检测不回退 HTTP，因此成功不会来自 HTTP/SSE。
认证失败、限流、超时、路径错误或无法识别的响应均显示无法确认，不把它们当作平台必然不支持 WS；错误仅展示安全分类和 HTTP 状态码。检测最长 15 秒，可按 Ctrl+C 取消整个 Setup；重试需主动选择，不自动重发模型请求。未验证成功默认建议关闭，也可手动启用；最终预览确认后才写入开关。

### 存储、备份与恢复

每个 Provider 的 `~/.codex-connect/providers/responses/<Provider ID>/models.json` 使用版本 3 格式，
包含 `schemaVersion`、`defaultModel`、`definitions` 及由定义生成的 `models`。模型定义可携带 `template: { source, model, followContext, snapshot? }` 关联。DS 的 `snapshot` 必填，官方 Codex 基础模板不保存快照；未知字段及审批策略元数据拒绝导入，不静默裁剪。只接受当前版本，不自动升级版本 2 等旧目录或给已有模型推断关联；旧目录需保留备份后按新格式重新配置。Codex 读取其中的
`models`，Gateway 严格核对版本与生成结果；不接受未知字段、重复 ID、任意外部路径或手写的第三方目录。
模型目录保存为两空格缩进的 JSON，DS 上下文同步也保留该排版。文件通过现有私有文件工具原子写入，目录 0700、文件 0600，Windows 使用现有私有 ACL 工具。
完整模型目录（含快照和生成结果）不得超过 2 MiB，超限在写入前拒绝。上下文不得超过模板原始最大窗口。模型文件不含 Key。Key 仍写入现有私有 Profile／主配置；连接配置的恢复快照单独位于
`~/.codex-connect/private/responses-providers/<Provider ID>.json`（0600，可能含凭据，勿分享）。

预览及直接保存时，先用当前锁定 Codex CLI 的 `debug models` 在隔离临时目录校验最终生成目录；校验失败不写入模型目录、Profile 或主配置，不输出原始错误内容。准备好的预览在保存时复核目录未变更。保存前核对配置版本、Profile 与目录修订，并备份受影响配置；上一目录保存在同目录 `models.json.backup`。
`models.json.pending` 标记未完成的保存；已知写入失败且主配置未改变时恢复目录和原 Profile。
无法确认配置写入结果或发生进程中断时保留备份和 pending，拒绝启动，不自动重发写入。
DS/RS 窗口联动在写入前将本次全局设置涉及的 DS、OCG、CCG 目录、Profile 和关联 RS 目录按路径去重，把前后内容一并备份到 `~/.codex-connect/private/responses-context-sync.json.backup`，事务期间使用同名无 `.backup` 后缀的恢复记录。文件为 0600，可能含 Profile 凭据，不可分享。失败时核对当前内容并回滚；无法确认时保留记录并阻止加载。恢复命令指定该事务内任一 RS ID，将整批恢复所有关联文件，拒绝覆盖后来修改的内容。
先停止服务、核对或恢复私有快照中的配置，再明确选择目录恢复方向：

```bash
codexc primary-provider recover rs-example rollback
codexc primary-provider recover rs-example keep
```

`rollback` 使用上一目录；首次创建没有上一目录时删除未完成目录。`keep` 保留新目录。
恢复会校验所选目录与当前配置的模型、路径及思考等级，并核对 Profile 与注册表是否一致、运行时能否加载；缺失注册项或 Profile 时须先恢复对应配置，不能仅保留目录。冲突时保留未完成标记并拒绝完成，不覆盖用户后来修改的配置。首次创建前主配置不存在时，可以回滚到无主配置、无模型目录的原始状态；配置损坏或权限错误不能按文件不存在处理。
可在自定义 Responses Provider 交互菜单中执行同一恢复流程。完成后运行 `codexc service restart all`。
回退到不支持此类型的 Gateway 版本前，先恢复官方主 Provider 并删除所有 Responses 切换 Provider，
保留私有备份供重新安装支持版本后人工恢复；不通过删除数据库或静默迁移实现回退。
