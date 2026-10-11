# 第三方模型 Provider 接入指南

本指南定义新增“受管第三方模型 Provider”（例如 OpenCode Go 套餐形态的第三方 DeepSeek
服务商）的标准流程、决策点、实现清单、安全边界与验收要求。新增通讯渠道（飞书、Telegram、
微信）不适用本指南，走 [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)。

当前受管第三方 Provider 是编译期注册的：DeepSeek、OpenCode Go、CCG 与 CLP 共用同一套受管管道，
Provider 特化只存在于定义能力元数据、Bootstrap 有界工厂、账户和 Setup。
新增 Provider 时优先复用管道，不得动态加载代码，也不得把未知 Provider 回退到 OpenAI 账户查询。

## 1. 接入前决策清单

开始实现前必须逐项确认，未确认或无法验证的项失败关闭：

| 决策点 | 选项 | 说明 |
| --- | --- | --- |
| Provider id | 小写字母/数字/`-`/`_`，1–64 位 | 决定 `sf-<id>.config.toml` Profile、`~/.codex-connect/providers/<id>/` 目录、`modelProvider`、环境变量名 |
| 显示名称 | 1–64 字符 | 出现在 `/model`、WebUI 与完成卡片 |
| wire API | App Server 仅 `responses` | Chat 上游需显式独立转换；CLP 与上游接口为 `chat_completions` 的自定义第三方 Provider 使用 `model-api` 模块与 Chat 桥，不把 Chat 写入 Codex `wire_api`。转换覆盖 `function`、`namespace`、自由格式 `custom`、客户端 `tool_search` 与 multi-agent v2 的 `agent_message` 输入项；模型目录可用 `applyPatchToolType: freeform` 与 `supportsSearchTool` 开启自由格式 `apply_patch` 与客户端检索；未映射的顶层工具声明原样交给上游，不注册本地执行身份，也不承诺托管工具执行与回程；第三方 `wire_api = "responses"` 上游由 ProviderProxy 在提交前归一化 Codex 私有输入项，`agent_message` 降级为普通 `user` 消息、工具参数 schema 的 `encrypted` 布尔标记被删除，HTTP 与 Responses WS 一致，官方 OpenAI 端点保持原文透传；受管 DeepSeek 入口仍关闭内置网页搜索 |
| WebSocket | 支持 / 不支持 | 不支持时必须显式声明 `supports_websockets = false` |
| 认证 | 按 Provider 校验的 API Key | 编译期受管 Provider 的 Key 只进入子进程环境或专用私有凭据文件，不写入命令行、日志或 Gateway 配置 |
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
注册后自动获得：watcher 目录路径、Remote / Desktop 的 `-p <Provider ID>` 与 `-p <profileName>` 选择、
`codexc remote --profile <profileName>` 规范名称、
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
- 同目录写入 `models.manifest.json`：目录来源与下载时间（CLP 另记 relay 提交与跟随模型，OCG 额外记录下载
  `sha256`）；Profile（切换模式）与固定基础配置仍位于 `~/.codex`，原生 `codex --profile` 只识别该目录；
- 目录按 Provider 隔离；同名模型（如两个 Provider 都提供 `deepseek-flash`）是独立选项，
 模型 key 为 `provider + model`；
- 可选模型以各 Provider 生成的模型目录为准：OCG/CCG 初始以 DS 完整目录为基础，复制 Flash 内容增加 V4.1，并按 Provider 映射模型 ID；配置后可通过共享模型管理显式添加上游支持的 Responses 模型和选择启用列表。新增模型的准确 ID 与能力必须确认，不把 Cline 专属路由或 Chat 参数复制给其他提供商；
- 默认模型写入 Profile 后，Profile 顶层 `model_reasoning_effort` 必须镜像目录默认值，
  运行时校验不一致即失败关闭。

模型选择复用 `scripts/provider-model-selection.mjs`，保护默认模型并限制启用数量；OCG/CCG 共享目录事务复用 `scripts/managed-provider-model-management.mjs`。CLP 保留官方候选目录下载与 Chat 能力映射，自定义 Responses 保留模板 ID 映射与版本 5 目录格式。通用提示词由 `runtime/third-party-coding-instructions.mjs` 提供，显式写入新定义；不得直接替换版本 5 生成器缺省值，否则既有目录的逐字段一致性校验会失败。

自定义 Responses 的设置向导在能力填写后统一多选启用模型，当前默认模型必须保留；停用即从本次保存的 `definitions/models` 移除。模板更新保留已有自定义提示词。目录写入继续使用现有备份及未完成事务恢复机制；不自动迁移或重写既有数据。

自定义 Responses 出站复核与配置加载共用版本 5、允许字段及定义／生成目录一致性校验。目录 `.pending` 或全局 DS/RS 上下文同步标记存在时，普通 HTTP 和 Responses WS 均拒绝新请求；读取前后检查标记，目录或事务不可用统一返回 `503 provider_catalog_unavailable`。恢复有效目录并完成事务后，下一次请求重新复核，不缓存失败或成功名单。

OCG/CCG 与自定义 `rs-*` 的普通代理及聚合下游均在发送前复核当前目录：HTTP 和 Responses WS 拒绝未知／已停用模型，旧会话不自动换模型。HTTP 错误为 `409 provider_model_disabled` 或目录不可用的 `503 provider_catalog_unavailable`；WS 返回对应 error 后关闭连接。CLP 保留专属错误码，独立 Relay 沿用自己的授权。名单约束即时读取，目录展示与能力仍按原服务刷新流程应用。

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
  5h/7d/月窗口 `resetsAt` 快照并写入当前指标库 `quota_windows` 列，
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

### 3.7 验证边界

至少覆盖：

- 定义与文件布局；
- Profile 镜像校验与失败关闭；
- 账户适配器：余额或用量窗口、本机 Token 统计、窗口边界、窗口快照归属与缺失回退；
- Setup：新增、更新、恢复、回滚；
- 生命周期：60 秒全局空闲宽限判定、自动解除后的关闭前通知、关闭后按需重连；
- Transport 或共享行为变化时核对锁定版本协议与实际运行行为。

### 3.8 文档

- 更新 `docs/index.md` 官方资料、支持矩阵与“本项目实现映射”；
- 新增 Provider 专题文档（参考 `docs/deepseek.md`、`docs/opencode-go.md`）；
- 更新根 `index.md` 文档索引；用户可见的入口变化同步到根 `README.md`。

## 4. 安全边界

DS、OCG、CCG 与 CLP 固定模式的主 `~/.codex/config.toml` 只保存带随机版本的 `env_key`，Key 位于
`~/.codex-connect/providers/<storage-id>/primary-credentials/<provider-id>/<版本>.json`。
JSON 使用版本 1，字段限于 `schemaVersion`、`providerId`、`origin`、`apiKey`，私有读取严格核对版本、Provider 和固定上游 Origin；
Unix 文件/目录分别为 `0600`/`0700`，Windows 使用私有 ACL，主配置可供 Codex 沙盒读取且不包含 Key。
每次明确重配先写新私有版本，再在同一文件事务内发布引用；旧版本与现有初始备份、归档保留，避免旧引用失效。
失败时先恢复已有文件再清理新增文件；并发冲突或恢复失败明确报错并保留尚未删除的恢复资料。删除账户保留凭据版本与私有备份。

已有明文固定配置不会被程序更新或启动自动转换；App Server 启动与 Relay 读取均拒绝该配置。
通过 `codexc setup` 的对应账户“重新配置”，或 WebUI 账户重新配置，输入 Key 并确认保存；设置入口只读模型元数据，旧私有版本缺失或损坏也可明确重配。
旧备份若含 `experimental_bearer_token`，恢复到共享主配置的操作明确拒绝，保留原文件供人工恢复；
须先显式配置为私有引用，不把明文备份复制回主配置。代码回退也不能自动改回明文，应保留主配置与对应私有版本，使用支持该引用的版本重新配置。

受管 App Server 在每次启动目标主实例时才将其 Key 注入对应子进程环境，先剥离其他受管/自定义 Key；Relay 独立读取同一私有版本并纳入材料指纹与观察路径。
固定、切换与聚合实例在启动时改用随机的临时 `env_key` 名称，并在该实例的官方 `shell_environment_policy.set` 中将同名值覆盖为空，防止工具 shell 默认继承认证值；用户已有过滤规则保持不变，磁盘引用不变。此措施不等于隔离同一操作系统用户，也不替代插件各自的权限边界。锁定上游的用户 Hook 与 `notify` 仍继承宿主环境，不受 shell 环境策略控制；只配置可信的 Hook/通知命令，不能将此方案描述成所有子进程均无凭据。
共享主配置同时拒绝可识别的明文认证 Header（如 `Authorization`、API Key、Cookie），普通非认证 Header 不因此删除；拒绝时保留原文件和恢复材料，不自动清理用户配置。
Gateway 自定义固定 Provider 的独立 API 凭据入口不接受 `auth`、`gateway_oauth`、`aws` 或 `env_http_headers`；这些上游认证形式不在当前接入合同内。独立 Relay 还拒绝自定义固定 Provider 的额外 `http_headers`，避免静默遗漏出站 Header。已有配置遇到拒绝时保持原样，需显式调整后再启用。
原生 `codex` 独立启动只读取 `env_key` 指定的环境变量，不会自动打开 Gateway 私有 JSON；没有该变量会由 Codex 报错。
共享终端路径使用 `codexc remote`，连接已受管启动的 App Server。切换模式继续使用原私有 Profile，不把 Key 写入主配置。

- Provider id 使用受控列表；模型名来自下载的官方目录，目录缺少的模型不开放；
- base URL 只允许 HTTP(S)，不得包含用户名、密码、查询或片段；
- 编译期受管 Provider 的 API Key 只进入目标子进程环境或专用私有凭据文件；用户自定义 Provider
  按第 6 节写入私有 Profile 或独立私有凭据，主配置仅保存 `env_key` 引用。两类 Key 都不得进入命令行、Gateway 配置、日志或平台消息；
- 受管私有文件在 Unix 使用 `0600`、`O_NOFOLLOW` 与属主校验，在 Windows 使用共享私有 ACL 与重解析点校验；共享主配置采用前述独立合同；
- 配置或目录校验失败时等待修复，不允许部分启动或隐式回退；
- 新增 Provider 不得动态加载 npm 包或执行任意代码。

## 5. 验收流程

开发时先运行受影响的静态检查与构建；普通提交由 pre-commit 执行按范围选择的 `verify:commit`，PR CI 使用 `verify:ci` 完整静态检查与构建，不提前重复。下列源码安装、服务重启及线上检查只用于已获授权的部署验收：

```bash
npm run install:global
codexc restart all
codexc doctor
```

功能验收：

- `/model` 能看到带新 Provider 前缀的模型，并可按序号选择；
- 新会话、同 Provider 历史 Thread、跨 Provider 新建 Thread 的模型与思考等级符合预期；
- `codexc remote -p <Provider ID>` 能拉起隔离 App Server 并共享会话；
- `/usage` 按账户形态展示余额或配额窗口与本机 Token 用量；
- 修改默认模型/思考等级后，watcher 校验通过并定向应用到受影响且已启用的 Provider；原生客户端租约或权威活动 Thread 会推迟应用；
  设置应用后 Gateway 同步刷新受管模型目录与默认模型，已有 Thread 和手动选择保持不变；
  重启或目录刷新失败时报告应用失败，并沿用 watcher 的冷却重试流程，刷新成功后才报告已应用；

## 6. 用户配置的主 Provider

Gateway 将使用 Responses 接口、复用 Codex 官方模型目录的自定义提供商称为“Codex 兼容 Provider”，
并提供固定与切换两种运行模式。此入口的模型 ID 必须来自官方目录，不支持任意第三方模型 ID。
它读取 `~/.codex/config.toml` 的 `model_provider` 和 `[model_providers.<id>]`；若
`model_provider` 为 `openai` 或未配置时使用官方 OpenAI，不自动激活候选。
自定义 Provider 必须显式选择，只在 Gateway 监管的 App Server 子进程中生效。
Gateway 在 App Server 前启动本地统计代理；原配置中的认证方式、模型名、
`supports_websockets` 等字段仍由 Codex 处理。当前只支持 `wire_api = "responses"`，不为它伪造
账户余额或用量接口。

示例：

```toml
model = "gpt-5.6-terra"
model_provider = "thirdparty"

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
该候选，显式配置为 `openai` 或未配置时使用官方 OpenAI。配置自定义主 Provider 时不能同时设置顶层 `openai_base_url`。通过
`codexc provider` 的
`list` / `add` / `switch` / `remove` 管理候选与激活状态。`list --json` 提供稳定的脚本输出，包含当前
主实例、固定候选、切换 Provider 与备份候选摘要，不包含 API Key 或其他认证字段；自定义 Provider 条目在能安全
读取元数据时另含 `upstreamWireApi`（`responses` 或 `chat_completions`），供脚本区分直连与经网关 Chat 桥转换的条目。
`codexc provider switch openai` 不运行登录直接切回官方 OpenAI（执行前会二次确认，并提示
将把 `model_provider` 写回 `openai`；从自定义切回且未指定模型时会清空顶层 `model`），官方凭据保留；切回时自定义候选块移入
`~/.codex-connect/private/primary-providers.json`（0600）并从 config 清理，之后
`codexc provider switch <ID>` 会从备份自动恢复（同样先二次确认，并提示改写主配置的
`model_provider` / `model`）。命令行 `switch` 传 `--yes` 可跳过该确认（仅命令行，Setup 菜单仍会确认）。
`codexc setup` 的“官方 → 登录并恢复官方”
会运行 `codex login --device-auth`（打开终端显示的链接并输入验证码）并执行相同的备份与清理。
从自定义候选切回官方时同时清除该候选留下的顶层 `model`；当前已经是官方模式时保留官方模型。
候选从备份恢复后会消费对应备份项；官方模式下可从 Setup 直接把备份候选编辑为固定或切换模式，或经二次确认删除
备份候选，不需要先切换到第三方。恢复、编辑或 `remove` 都先提交配置，成功后才消费同名备份；
配置写入失败时原备份保持不变，配置已提交但备份清理失败时明确提示部分成功。备份不可安全读取时，
只允许编辑当前 config 中的候选，切换和删除失败关闭。

未声明独立凭据时，`requires_openai_auth = true` 使用 Codex 当前 API Key/ChatGPT 认证；已有 Provider 也可按 Codex 官方配置使用
`env_key`，普通切换保留该引用。两者共存时，锁定上游优先读取 `env_key`，缺失时不回退官方认证；`requires_openai_auth` 仍影响账户语义，切换不能据此将其清为 `false`。经 Gateway 新增或替换的自定义固定 Key 只把凭据环境变量名称写入主配置，实际 Key 保存在
`~/.codex-connect/providers/custom/<ID>/primary-credentials/<版本>.json` 的当前用户私有文件中。
Windows 的主配置允许上游沙箱只读访问，其所有权与写入完整性检查不保证内容机密性，所以不能在其中保存
`experimental_bearer_token`。已有明文候选仍可列表查看、显式编辑或切回官方，但 Gateway 拒绝启动该固定实例；
在 `codexc setup` 中编辑并保存，或显式切换该明文候选，会转为私有凭据，启动不会自动迁移或删除原文件。通过 Setup 新建只使用独立 Key 的 Provider 时
设置 `requires_openai_auth = false`，不依赖官方 auth.json，官方登录状态不受切换影响。
主配置选中官方 `openai` 时，管理状态会检查 `CODEX_HOME/auth.json`（默认
`~/.codex/auth.json`）；未检测到该鉴权文件按 OpenAI 官方未登录处理，WebUI Provider 状态不把
官方 OpenAI 作为主 Provider 展示，Setup 总览与 `codexc provider list` 标注“未登录”，
会话 `/model` 不列出官方 OpenAI 模型，只有第三方模型可继续选择。
渠道启动通知同时标注“OpenAI 官方未登录”并给出 `codex login` 或 `/model` 的选择提示；已有官方
Thread 不自动迁移 Provider，若 Turn 返回结构化 `unauthorized`，完成卡片按 OpenAI 官方与其他
Provider 分别提示重新登录、改选第三方或更新对应凭据。
渠道未绑定 Thread 且没有手动选择时，只有一个可选第三方 Provider 就自动使用它的 Profile 默认模型，
不需要另设 Gateway 默认模型；状态、模型菜单和创建 Thread 使用同一提供商与模型。
普通消息及 Goal 查询/设置/清除、Review、Compact、Fork 的自动建会话入口均遵循该规则，
先执行这些命令不会把后续消息绑定回未登录的官方 Provider。
多个第三方 Provider 可选时不按目录顺序决定默认值；仅当全部已配置切换实例都属于同一家 DS、OCG、
CCG 或 CLP 时使用该家注册表标记的默认账户，混合其他 Provider 时先通过 `/model` 选择提供商和模型，再发送消息；
选择在当前 Conversation 中沿用。官方不可用时，Gateway 的官方 `codex.default_model` 不阻断第三方选择。
已有 Thread 保留自身 Provider，不因官方退出登录而自动迁移。
同一 Provider 内选模型只标记模型待生效；只有实际离开旧 Provider 的 Thread 才提示创建新 Session，
目标 Thread 建立后该提示消失。
`codexc remote` 与 `codexc app` 默认都连接主实例，不根据官方登录状态自动选择第三方；Remote 显式受管 `--profile` 仍选择对应实例。
上述自动选择只用于渠道未绑定会话。两个 CLI 入口的 `-p` / `--provider` 均接受已配置的完整
Provider ID（推荐 `ds-main`、`clp-main`、`ocg-main`、`ccg-main`、`my-provider`）和注册表中精确登记的
规范 `sf-*` Profile 名称，不通过剥除前缀推测别名。`agg` 与 `sf-agg` 都选择聚合实例，
内部 `codexc-aggregate` 不作为公开选择值；任一保留值与注册 Provider 或 Profile 重名时，两种聚合选择均拒绝。
自定义 `agg` 可明确使用 `sf-custom-agg`。Remote 的 `--profile` 继续用于个人 Profile 或规范受管 Profile，
与 `-p` / `--provider` 互斥；`--` 后原样透传。Desktop 仍要求主 Provider 为 OpenAI，并限于 macOS / Windows 预览入口。
Gateway 不读取或复制凭据，只把用户配置交给 App Server。`base_url` 必须是无凭据、无查询
和片段的 HTTP(S) 地址；自定义 Provider ID 只能使用 ASCII 字母、数字、`-` 或 `_`，且不能占用
`openai`、`ollama`、`lmstudio`、`amazon-bedrock`、DeepSeek 保留命名空间 `deepseek` / `ds-*`、OpenCode Go 保留命名空间
`ocg` / `ocg-*`、CCG 保留命名空间 `ccg` / `ccg-*`、CLP 保留命名空间 `clp` / `clp-*`，或其他项目受管 Provider ID。`opencode-go` 是当前管理命令与磁盘目录名称。

修改后运行 `codexc restart all`。若上游不支持 Responses WebSocket，必须保留
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
`codexc remote -p <Provider ID>` 或 `codexc app -p <Provider ID>` 连接该隔离实例；
规范 Profile 名称 `sf-custom-<Provider ID>` 也可传给 `-p` / `--provider`，Remote 还可显式使用
`--profile sf-custom-<Provider ID>`，与原生 Codex 及磁盘文件的命名保持一致。
渠道 `/model` 复用 Codex 官方模型目录并以精确自定义 Provider ID 展示同名模型，
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
`base_url`，从 URL 主机名派生的 Provider ID 与推荐的 `OpenAI` 中选择，输入独立 API Key，
再选择固定/切换模式、Responses WebSocket，并手工输入上游
模型 ID。该 ID 必须存在于 Codex 官方模型目录；Setup 不请求第三方 `/models`，也不生成第三方
目录、`models.json` 或自定义 `model_catalog_json`；官方目录快照只在服务启动时生成。新增拒绝覆盖
config 或私有备份中的已有 ID；编辑保持 ID 不变，同一 URL Origin 可留空保留 Key，Origin 变化时必须重新输入，旧 Key
不会用于新上游；无效旧 URL 同样要求新 Key，但不阻止修复。上游 `base_url` 接受不带凭据、查询和片段的 HTTP(S) 地址；
HTTP 请求与 API Key 均以明文出站，仅建议在受信任的内网或本机服务使用；保存预览会显式标记明文 HTTP 传输。
选择 `OpenAI` 时固定同名 `name`，允许 Codex 使用远程压缩；上游仍须兼容对应接口。小写 `openai` 是
Codex 内置保留 ID。固定模式通过 Codex 的 `config/batchWrite` 原子写入用户配置；切换模式不修改
主配置，而维护逐 Provider 的私有 Profile 和注册表。新增默认推荐切换模式，编辑保持原模式；确认预览
明确显示 Key 的私有存储位置。固定模式主配置只保存 `env_key` 引用，切换模式的 Key 明文保存在私有 Profile
中的 `experimental_bearer_token`；Unix 使用 0600，Windows 使用当前用户私有 ACL。Key 输入不显示不回显；自定义固定模式不能保留其他自定义
切换 Profile，从切换模式改为固定模式前必须先删除其他自定义切换 Provider；受管切换 Provider 可以
共存，受管固定模式必须先恢复官方模式。写入后仍需运行
`codexc restart all` 生效。此处的 Setup 新增/编辑表单只接受独立 API Key，不接受额外
Provider 块或其他认证、Header、Query 配置。若待编辑 Provider 仍是主配置候选，需先运行
`codexc provider switch openai` 将候选移入私有备份，再编辑为切换模式；Setup 不会留下
同名主配置块和切换 Profile。

固定凭据文件使用严格的版本 1 合同：`schemaVersion`、`providerId`、上游 `origin` 和 `apiKey` 四个字段；
不支持的版本、Provider 或 Origin 不匹配、非私有文件均拒绝读取，不回退到进程中同名变量。新增或替换固定 Key，以及将明文凭据或切换 Profile 转为固定模式时，
先创建新的不可变凭据版本，再提交 `config/batchWrite`；旧版本保持不变。普通切换及备份恢复保留完整 Provider 配置、已有 `env_key` 引用和 `requires_openai_auth` 标志，不强制 OAuth 或无认证 Provider 提供独立 Key。已声明的 `env_key` 缺失时仍拒绝切换，不回退其他认证方式。明确确认配置未引用新版本时仅删除本次新文件，
响应丢失且无法确认时保留新旧版本，由实际主配置的 `env_key` 决定读取哪份，不自动重试或覆盖旧 Key。
切回官方时备份候选的凭据引用也保留；显式删除 Provider 时才删除该 Provider 已验证归属的凭据版本。
切换预览、执行和备份恢复共用运行时的认证校验；`auth`、`gateway_oauth`、`aws` 和 `env_http_headers` 不受自定义固定模式支持，写入前明确拒绝，保留原主配置、备份和凭据。普通非认证 `http_headers` 仍保留。
凭据版本损坏或无法安全读取时保留文件，并以 `credential-cleanup-failed` 报告 Provider 已删除但凭据清理未完成。
备份应同时保留主配置、`private/primary-providers.json` 与该 Provider 的 `primary-credentials` 目录；恢复时一并还原，
不要只恢复主配置引用而丢掉对应 Key。回退到旧 Gateway 前应恢复操作前的完整备份；新 Gateway 不会替用户生成旧明文合同。

服务仅把选中固定 Provider 的 Key 注入其 App Server 子进程环境；配置管理临时 Client 只执行配置及模型目录元数据操作，
无需加载 Key，因此缺失或损坏的私有凭据仍可显式编辑修复。Key 不进入启动参数。`codexc remote` 连接共享实例，无需向 TUI 注入 Key。直接运行官方 `codex` 不会自动读取 Gateway 私有
JSON 凭据文件；使用固定模式时应运行 `codexc remote`，若自行启动官方 CLI 执行模型请求，则须在该进程环境中提供主配置 `env_key`
指定的 Key，并自行管理其环境保密性。

自定义固定 Provider 的代理目标和凭据绑定到同一次服务启动；修改 Provider、上游地址或凭据后，旧服务拒绝按需重建主实例，须执行 `codexc restart all`。空闲释放后恢复也遵守此限制，不会将新 Key 注入旧代理。

## 7. 自定义 Responses Provider

`codexc setup → 模型与提供商 → 第三方 Provider → 自定义第三方` 与
`codexc provider add --custom-models` 提供相同的新增入口；编辑、列表、切换、删除复用
`provider` 管理链路。WebUI 的 Provider 设置中选择“自定义 Responses Provider”。
此类型使用 `rs-` 开头的 Provider ID（其后 1-61 位 ASCII 字母、数字、`-` 或 `_`），
以便模型目录缺失时明确报错，不回退到官方目录。显示名称禁止使用上游具有特殊语义的 `OpenAI`，
避免启用官方专用协议能力。已有 Codex 兼容 Provider 不自动转换或迁移。

填写平台的 Responses 基础地址（例如 `https://www.zzshu.cc/v1`）、API Key 和一个或多个模型。
自定义第三方 Provider 支持两种上游接口，在填写基础地址后选择：`Responses` 直连上游，或 `Chat Completions` 由网关的 Chat 桥转换（`function`、`namespace`、自由格式 `custom`、客户端 `tool_search` 与 `agent_message` 均由桥处理）。选 Chat Completions 时 WebSocket 强制关闭、客户端检索默认声明（连接器等工具照常按需检索），不提供 Responses 私有能力（加密推理回放、远程压缩、Fast 档位），模型转发（Relay）对该 Provider 只宣告原生 Chat 并按 Chat 转发，不宣告 Responses；自动审批等带结构化输出的请求同时声明工具时，桥把要求的 JSON schema 追加到系统消息并省略 `response_format`，以适配不接受两者并存的 Chat 上游（托管 CLP 上游已验证接受，保持 `response_format`）。该降级只由提示词保证，桥不校验最终文本是否为 JSON，降级事实记为请求诊断 `conversion.structuredOutput=prompt`；模型仍由统计代理按 Provider 目录拒绝目录外或已停用模型。选择结果写在 `~/.codex-connect/providers/responses/<Provider ID>/provider.json`（0600，缺失按 `responses`），修改后运行 `codexc restart all`。
CLI 新增或编辑时分别询问是否导入官方 Codex、DeepSeek 模型，勾选平台支持的条目后，逐项填写平台模型 ID，确认“模板 ID → 平台 ID”。多选时按空格勾选、回车确认；空选会提示尚未导入，并提供返回选择或跳过本类模板的选项。两类均可导入，也可跳过后手填。
官方模板读取当前 Codex CLI 的内置目录，排除不会原样作为请求等级发送的 Codex 专用 `ultra` / `persistent` 模式；其余等级与默认值仍需通过 RS 校验，不能转换时明确报错并使用手填入口；DS 优先读取现有本地共享目录；没有时复用 DS 官方脚本下载与提取流程，不执行脚本。读取失败明确报错，不回退其他来源。
官方 Codex 与 DS 模板均导入模型 ID、显示名称、当前上下文窗口、源目录声明的最大上下文窗口、支持的思考等级、默认思考等级及图片输入能力。DS 模板另保留非空 `model_messages.instructions_template`；工具配置、等级说明、详细程度、压缩参数和多代理元数据不复制，模板的工具声明不代替新增模型时的 `apply_patch` 确认与填写 Key 后的客户端检索检测。模型 ID 可映射为平台实际名称；生成目录的其余必需字段使用项目统一默认值。请求使用填写的平台 ID，同一 Provider 内不允许重复。导入后选择默认模型，可调整能力并继续手动添加其他模型。编辑时，唯一已有模板映射会预填平台 ID；同 ID 须明确确认才用模板替换已有模型的名称、能力及关联，默认不覆盖，拒绝则保留原值。按 ID 合并，不重复添加已有条目；同一批导入仍禁止两个模板占用同一平台 ID，未选中的模型继续保留供后续编辑。
模板副本独立保存。DS 模型可选择“跟随模板上下文”，须先配置本地 DS 目录；CLI 或 WebUI 修改 DS 上下文时，现有受管目录事务会同步关联的 RS 模型，平台 ID 与其他能力保持独立。CLI 编辑及 WebUI 可关闭跟随，关闭后保留当前窗口。删除最后一个 DS 账户或重建缺失的 DS 目录前，必须先关闭关联 RS 模型的跟随，避免留下失效关联；同一窗口值再次应用时也会修正跟随副本的差异。没有启用跟随的副本不受源目录变化影响；模型 ID、能力仍须符合平台实际支持情况。WebUI 可编辑保存后的平台 ID 和能力，目前模板勾选入口在 CLI。
每个模型声明准确 ID、显示名称、上下文窗口、图片输入能力、支持的思考等级与默认等级；第三方自定义模型默认声明自由格式 `apply_patch`，CLI 新增或编辑时确认且默认勾选，WebUI 勾选状态可关闭，关闭后不写入目录。客户端 `tool_search` 在 Responses 上游默认不声明：声明后 Codex 会把 `tool_search_call` / `tool_search_output` 输入项回传上游，上游不接受这些输入项时触发检索的回合会失败。填写 API Key 后，CLI 提供“自动检测”，发送一次极短请求验证上游是否接受检索输入项（最长 15 秒，可能计费，只覆盖输入项接受度，不代表模型一定会调用检索）；检测通过才为目录内全部模型声明，未通过或无法确认保持不声明，WebUI 需手工勾选。选择 Chat Completions 时检索输入项由网关转换，CLI 直接声明，WebUI 在切换上游接口时自动勾选，两处都可以再手动关闭。缺少 `tool_search` 时客户端无法按需检索，会把全部工具定义内联进每次请求；默认模型必须属于目录。
上下文窗口接受 1024–100000000 Token；CLI 与 WebUI 提供 32K、128K、256K 常用窗口预设（32768 / 131072 / 262144 Token），也可填写其他值。思考等级仅接受锁定 Codex 支持的
`none/minimal/low/medium/high/xhigh/max`；留空表示不声明可选等级，启动请求显式使用 `none`，
避免继承官方主配置的思考等级。不会请求第三方 `/models` 或自动推断模型能力。

选择 Responses 时，上游必须兼容锁定版 Codex 的 Responses 流式事件、函数调用、工具结果接续及其请求字段；
“提供 Responses 地址”不代表所有模型均兼容。此入口只按所选上游接口使用直连 Responses 或网关 Chat 桥转换，
不为具体平台添加专用协议补丁。
这些实例仍关闭网页搜索；模板中的能力元数据不代替上游接口兼容性验证，也不自动启用 WS 或改变审批策略。手填模型和官方 Codex 基础模板使用通用编程指令，不额外声明远程压缩、免费额度、Fast、推理摘要或详细程度；DS 导入保留模板的非空编程指令，缺少时使用通用编程指令；工具和请求参数继续采用项目的保守配置。当前目录合同没有可独立设置的最大输出 Token 字段。

固定模式把 Provider、默认模型、思考等级及目录引用写入主配置；切换模式保持官方主配置，写入独立的
`sf-custom-rs-<标识符>` Profile，并由现有监管服务启动。渠道 `/model` 从各自真实 App Server
获取目录，跨 Provider 选择仍在新 Thread 生效；已有 Thread 不迁移。切回官方后保留候选和自定义目录，
再次启用候选时使用目录记录的默认模型；删除 Provider 成功且凭据备份清理成功后才清理模型目录和私有恢复快照。
清理中断留下孤立目录时，可再次执行 `codexc provider remove <Provider ID>` 按原 ID 清理残留。

### 自定义 Provider 的 WS 检测

CLI Setup 的 Codex 兼容 Provider 和自定义 Responses Provider，新增与编辑均可在地址、模型及 Key 填写后选择“自动检测”“关闭，使用 HTTP/SSE”或“手动启用”。WebUI 保持手动开关。
自动检测使用当前 Key、选定模型及共享代理，按锁定 Codex 协议向 `/responses` 建立 WS，并发送 `response.create`、`generate=false` 预热；不读取仓库或现有会话内容，不在检测时保存配置，不保证第三方平台免计费。
握手和预热成功仅表示连接与预热可用。可另行确认发送一次极短文字请求（可能产生费用），只有收到有效模型文字输出及完成事件才显示请求验证成功；不代表工具、多轮或所有模型已兼容。WS 检测不回退 HTTP，因此成功不会来自 HTTP/SSE。
认证失败、限流、超时、路径错误或无法识别的响应均显示无法确认，不把它们当作平台必然不支持 WS；错误仅展示安全分类和 HTTP 状态码。检测最长 15 秒，可按 Ctrl+C 取消整个 Setup；重试需主动选择，不自动重发模型请求。未验证成功默认建议关闭，也可手动启用；最终预览确认后才写入开关。

### 存储、备份与恢复

每个 Provider 的 `~/.codex-connect/providers/responses/<Provider ID>/models.json` 使用版本 5 格式，
包含 `schemaVersion`、`defaultModel`、`definitions` 及由定义生成的 `models`；生成的每个模型条目声明 `multi_agent_version: v2`，由 Codex 解析为多代理 v2 运行时，不写入主配置的 `features.multi_agent_v2`。模型定义可携带 `template: { source, model, followContext }` 关联。`maxContextWindow` 可选，用于独立保留源模型声明的最大窗口；不再保存完整模板快照，输入旧 `snapshot` 字段会明确拒绝。只接受当前版本，未知字段和不支持的版本原样保留并明确拒绝，不推断模型关联；版本 4 目录在本版本失败关闭，既不自动迁移也不写回，读取该目录的 Gateway 启动与管理界面会一起失败（`codexc provider recover` 只处理未完成写入事务，不处理版本升级），移除与切回官方 OpenAI 只依赖注册表与目标 Provider 自身的材料，其他 Provider 目录不可读不阻塞本次操作，因此目录缺失或不支持时仍可 `codexc provider remove` 后按原 ID 重建。Codex 读取其中的
`models`，Gateway 严格核对版本与生成结果；不接受未知字段、重复 ID、任意外部路径或手写的第三方目录。
模型目录保存为两空格缩进的 JSON，DS 上下文同步也保留该排版；账户注册表、账户初始备份与 `models.manifest.json` 同样使用两空格缩进。文件通过现有私有文件工具原子写入，目录 0700、文件 0600，Windows 使用现有私有 ACL 工具。
上游接口选择单独保存在同目录的 `provider.json`（版本 1，仅含 `upstreamWireApi`，取值 `responses` 或
`chat_completions`），沿用同一私有文件工具原子写入，目录 0700、文件 0600，不含 Key。文件缺失按 `responses`
处理以兼容既有目录，Provider ID 不是 `rs-` 前缀时不读写该文件；版本、字段或取值不受支持时失败关闭并拒绝加载，
不回退为 `responses`。选择 Chat Completions 时写入，改回 Responses 时删除；编辑 Provider 时未显式改动上游接口就沿用文件中的已保存值，
元数据不可安全读取时列表省略该字段、保存要求显式选择而不是静默改成 `responses`；删除 Provider 在备份清理成功后
连同模型目录一起清理，清理中断可按原 ID 重跑 `codexc provider remove`。该文件与主配置、Profile、注册表一并记入
`~/.codex-connect/private/responses-providers/<Provider ID>.json` 备份（两空格缩进 JSON）；写入是单文件原子替换，失败时保持原值，
随模型目录保存事务失败时按既有规则保留备份与 pending 并拒绝启动，不自动重试，修改后须执行 `codexc restart all`。
WebUI 的 Provider 预览与保存请求上限为 2 MiB，其他管理接口仍为 64 KiB。模型数量上限仍为 64 个。模型目录（定义和生成结果）不得超过 2 MiB，超限在写入前拒绝。上下文不得超过模板原始最大窗口。模型文件不含 Key。Key 写入私有 Profile 或独立私有凭据版本，主配置只含引用；连接配置的恢复快照单独位于
`~/.codex-connect/private/responses-providers/<Provider ID>.json`（0600，可能含凭据，勿分享）。

预览及直接保存时，先用当前锁定 Codex CLI 的 `debug models` 在隔离临时目录校验最终生成目录；校验失败不写入模型目录、Profile 或主配置，不输出原始错误内容。准备好的预览在保存时复核目录未变更。保存前核对配置版本、Profile 与目录修订，并备份受影响配置；上一目录保存在同目录 `models.json.backup`。
`models.json.pending` 标记未完成的保存；已知写入失败且主配置未改变时恢复目录和原 Profile。
无法确认配置写入结果或发生进程中断时保留备份和 pending，拒绝启动，不自动重发写入。
DS/RS 窗口联动在写入前将本次全局设置涉及的 DS、OCG、CCG 目录、Profile 和关联 RS 目录按路径去重，把前后内容一并备份到 `~/.codex-connect/private/responses-context-sync.json.backup`，事务期间使用同名无 `.backup` 后缀的恢复记录。文件为 0600，可能含 Profile 凭据，不可分享。失败时核对当前内容并回滚；无法确认时保留记录并阻止加载。恢复命令指定该事务内任一 RS ID，将整批恢复所有关联文件，拒绝覆盖后来修改的内容。
先停止服务、核对或恢复私有快照中的配置，再明确选择目录恢复方向：

```bash
codexc provider recover rs-example rollback
codexc provider recover rs-example keep
```

`rollback` 使用上一目录；首次创建没有上一目录时删除未完成目录。`keep` 保留新目录。
恢复会校验所选目录与当前配置的模型、路径及思考等级，并核对 Profile 与注册表是否一致、运行时能否加载；缺失注册项或 Profile 时须先恢复对应配置，不能仅保留目录。冲突时保留未完成标记并拒绝完成，不覆盖用户后来修改的配置。首次创建前主配置不存在时，可以回滚到无主配置、无模型目录的原始状态；配置损坏或权限错误不能按文件不存在处理。
可在自定义 Responses Provider 交互菜单中执行同一恢复流程。完成后运行 `codexc restart all`。

## 关联文档

- [`docs/opencode-go.md`](opencode-go.md)：GO 形态参考实现；
- [`docs/ccg.md`](ccg.md)：DS 基础目录适配、多账户隔离与 Command Code Credits 查询的参考实现；
- [`docs/cline-pass.md`](cline-pass.md)：CLP 账户、Chat 转换与用量；
- [`docs/deepseek.md`](deepseek.md)：官方账户余额查询参考实现，不计算本地价格或费用；
- [`docs/surface-integration-guide.md`](surface-integration-guide.md)：通讯渠道接入；
- [`docs/index.md`](index.md)：协议支持矩阵与实现映射；
- [`docs/codex-cli-upgrade-decisions.md`](codex-cli-upgrade-decisions.md)：Provider 边界决策。
