# 第三方模型 Provider 接入指南

本指南定义新增“受管第三方模型 Provider”（例如 OpenCode Go 套餐形态的第三方 DeepSeek
服务商）的标准流程、决策点、实现清单、安全边界与验收要求。新增通讯渠道（飞书、Telegram、
微信）不适用本指南，走 [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)。

当前受管第三方 Provider 是编译期注册的：DeepSeek 与 OpenCode Go 共用同一套受管管道，
Provider 特化只存在于定义能力元数据、Bootstrap 有界工厂、目录更新、计价、账户和 Setup。
新增 Provider 时优先复用管道，不得动态加载代码，也不得把未知 Provider 回退到 OpenAI 账户查询。

## 1. 接入前决策清单

开始实现前必须逐项确认，未确认或无法验证的项失败关闭：

| 决策点 | 选项 | 说明 |
| --- | --- | --- |
| Provider id | 小写字母/数字/`-`/`_`，1–64 位 | 决定 `sf-<id>.config.toml` Profile、`~/.codex-connect/providers/<id>/` 目录、`modelProvider`、环境变量名 |
| 显示名称 | 1–64 字符 | 出现在 `/model`、WebUI 与完成卡片 |
| wire API | `responses` / `chat_completions` / `messages` | 决定 App Server `model_providers.<id>.wire_api` 与本地代理透传方式 |
| WebSocket | 支持 / 不支持 | 不支持时必须显式声明 `supports_websockets = false` |
| 认证 | `sk-` API Key | Key 只进入子进程环境或私有凭据存储，不写入命令行、日志或 Gateway 配置 |
| 模型目录来源 | 官方目录下载器 / `/models` / 审查后的 JSON | 与 DeepSeek 官方目录一致时可复用现有下载器 |
| 计价形态 | 无 / 通用远程目录 / 固定 USD / GO 式 USD 峰谷 + 包含额度 / DS 式 CNY 计划 + 汇率 | 决定计价器实现与是否需要汇率 |
| 账户形态 | 无 / 余额 / GO 式用量窗口（5h/7d/月 + 本地重算 + 请求窗口快照） | 决定账户适配器实现与 `/usage` 展示 |
| 运行模式 | switching / exclusive | 必须同时支持；marker `mode` 区分 |
| 能力边界 | 文字 / 图片 / 音频 / 网页搜索 / 上下文压缩 | 按真实工具合同声明，不能只看价格页或 `/models` |

## 2. 上游资料清单

接入前需要拿到并审查以下上游资料：

- OpenAI 兼容 base URL 与认证方式；
- wire API 的请求/响应/流式事件文档，以及 `/responses/compact` 等压缩接口是否可用；
- 模型目录来源（`/models` 响应或官方目录 JSON），包含模型名、显示名、上下文窗口、
  支持思考等级、默认思考等级、输入能力、压缩阈值字段；
- 价格来源（官方价格页或 JSON），包含币种、单价、峰谷时段、长上下文档位、套餐包含额度；
- 账户接口文档：余额或用量窗口（窗口周期、重置时间、已用百分比）；
- 限流与错误语义（429/5xx/重试），以及是否有 Key 预检接口。

## 3. 实现步骤

### 3.1 定义注册

在 `runtime/model-provider-definitions.mjs` 新增冻结定义并加入
`managedModelProviderDefinitions`：

- `id`、`displayName`、`codexProfileName`、`profileFileName`、`catalogFileName`、
  `catalogManifestFileName`、`managedMarkerFileName`、`backupDirectoryName`；
- `baseUrl`、`wireApi`、`apiKeyEnvironmentKey`、`supportsWebsockets`；
- `defaultModel`、`defaultReasoningEffort`、受控 `models` 列表。
- `capabilities`：只允许声明已实现的实例展开、模型目录来源与更新适配器、计价适配器、
  账户适配器和 `needsExchangeRate`；无自动目录更新、无计价或无账户能力时显式使用 `none`，
  静态或人工审查目录可把来源也设为 `none`；通用远程价格目录使用 `remote`，不得把任意 URL、
  脚本或动态插件放入定义。启用目录更新适配器时必须声明非空受控来源。

注册后自动获得：watcher 目录路径、`codexc remote --profile <id>` 别名、
`agents.external` 角色、文件迁移、`/model` 的 Provider 选项、App Server 启动参数。
Runtime 按 `instanceAdapter` 将所有单实例定义和显式多账户定义展开为运行时注册表；Bootstrap
按计价适配器创建解析器并以精确 Provider ID 登记，按账户适配器创建账户窄适配器。未知能力和
重复 Provider 适配器均启动失败关闭，不回退 OpenAI。OpenCode Go 多账户实例继承基础定义的能力
元数据；watcher 另保留未配置的共享模型目录，并按 Provider 合并重复定义与路径。

### 3.2 模型目录与 manifest

- 在 `~/.codex-connect/providers/<id>/` 生成 `models.json`，schema 与现有目录一致：每个模型必须有
  `context_window`、非空 `supported_reasoning_levels`、合法 `default_reasoning_level`、
  `auto_compact_token_limit`、`display_name` 与输入能力；
- 同目录写入 `models.manifest.json`：来源 URL、sha256、下载时间；Profile（切换模式）与固定
  基础配置仍位于 `~/.codex`，原生 `codex --profile` 只识别该目录；
- 目录按 Provider 隔离；同名模型（如两个 Provider 都卖 `deepseek-v4-flash`）是独立选项，
  模型 key 为 `provider + model`；
- 默认模型写入 Profile 后，Profile 顶层 `model_reasoning_effort` 必须镜像目录默认值，
  运行时校验不一致即失败关闭。

### 3.3 计价

- GO 形态（USD 峰谷 + 包含额度）：由 `managed-provider-capabilities.ts` 按能力元数据创建
  `opencode-go-model-pricing.ts` 解析器，并按账户 Provider ID 有界匹配；
- DS 形态（CNY 计划 + 汇率）：由同一工厂创建 `deepseek-model-pricing.ts`，并由定义中的
  `needsExchangeRate` 决定是否装配汇率；
- 其他形态：使用通用远程价格目录或按实际合同新建 resolver；
- 无专用价格时使用 `none`，明确返回无价格；只有经审查允许使用通用远程目录时才使用 `remote`；
- 价格按请求开始时间判定：生效时间前的请求使用保存的价格快照，生效时间后按当前基线重算；
  峰谷档位优先沿用快照 `pricing_bucket`，缺失时才按当前基线判定。

### 3.4 账户

- GO 形态：通过 `opencode-go-account-adapter.ts` 工厂按账户 Provider ID 创建适配器，复用
  usage URL、凭据读取、计价器和指标库 Provider 过滤；
- 余额形态：通过 `deepseek-account-adapter.ts` 受控创建；该适配器只接受 DeepSeek Provider，
  不会把未知 Provider 当作余额账户。
- 无账户：`/usage` 明确显示不支持，不回退 OpenAI；
- 指标库本地用量与 Token 汇总必须按 Provider 过滤；GO 形态还需在统计代理注册窗口
  快照 provider（参考 `opencode-go-quota-windows.mjs`），在请求发生时记录官方
  5h/7d/月窗口 `resetsAt` 快照并写入指标库 `quota_windows` 列（指标库 Schema v9；当前指标库为
  Schema v10，另含子代理父 Turn 关联），
  读取时优先按快照归属窗口，快照缺失或与当前官方窗口不一致时才回退到按请求开始时间判定。
  窗口总额度（如 OpenCode Go 5 小时 $12、7 天 $30、月度 $60）随窗口展示，用于按已用
  百分比换算金额；总额由 Provider 定义或套餐常量提供，不来自官方用量接口。

### 3.5 生命周期与空闲停止

- 受管 Provider 的统计代理与隔离 App Server 支持按需启动；当前只有 OpenCode Go 账户实例启用
  空闲自动停止，避免使用过的账户无限常驻；
- 自动停止条件（全部满足）：无 Conversation 绑定、不是 `agents.external` 当前默认 Provider、
  Gateway 最近无 Turn 活动、没有受管 Remote TUI 租约，且空闲超过固定阈值 5 分钟；
- 停止只终止隔离 App Server 子进程与启动记录，保留 Profile、模型目录与 Thread
  持久数据；再次选择模型、恢复 Thread 或使用对应 Remote TUI 时自动按需拉起；
- `codexc remote` 必须在 TUI 生命周期内持有 Supervisor Provider 租约；租约存在时自动释放和
  手动停止都必须失败关闭，连接退出或异常断开时自动撤销租约；
- **释放通知**：每次成功自动释放后必须向渠道通知一次，说明该 Provider/账户已空闲停止
  及自动恢复行为，不静默释放；同一次释放只通知一次。

### 3.6 Setup

- GO 形态优先复用/参数化 `opencode-go-setup.mjs`；否则新建 `scripts/<id>-setup.mjs`；
- 必须包含：API Key 校验、switching/exclusive 选择、模型目录下载与校验、Profile/
  基础配置写入、管理标记、`agents.external` 切换、首次备份、失败回滚；
- 文件权限 `0600`，目录 `0700`，符号链接与越权读取失败关闭；
- `codexc setup` 菜单同步加入入口。

### 3.7 测试

至少覆盖：

- 定义与文件布局（`model-provider-file-layout.test.ts` 风格）；
- Profile 镜像校验与失败关闭（`model-provider-runtime.test.ts` 风格）；
- 计价基线 schema、峰谷档位、生效时间与历史快照；
- 账户适配器：余额或用量窗口、本地用量重算、窗口边界、窗口快照归属与缺失回退；
- Setup：新增、更新、恢复、回滚、角色切换；
- 生命周期：空闲停止判定、释放后自动拉起、释放通知一次；
- 协议与真实 App Server 合同测试只在 Transport 或共享行为变化时新增。

### 3.8 文档

- 更新 `docs/index.md` 官方资料、支持矩阵与“本项目实现映射”；
- 新增 Provider 专题文档（参考 `docs/deepseek.md`、`docs/opencode-go.md`）；
- 更新根 `index.md` 文档索引；用户可见的入口变化同步到根 `README.md`。

## 4. 安全边界

- Provider id 与模型名使用受控列表，未知模型不开放；
- base URL 只允许 HTTP(S)，不得包含用户名、密码、查询或片段；
- API Key 只进入子进程环境或私有凭据存储，不进入命令行、配置、日志或平台消息；
- 受管文件必须 `0600`，读取使用 `O_NOFOLLOW` 与属主校验；
- 配置、目录、基线校验失败时保留旧基线并等待修复，不允许部分启动或隐式回退；
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
- `codexc remote --profile <id>` 能拉起隔离 App Server 并共享会话；
- `/usage` 按账户形态展示余额或配额窗口与模型本地用量；
- 修改默认模型/思考等级后，watcher 校验通过并在无活动 Turn 时自动重启；
- 峰谷价格按请求开始时间验证：生效时间前后、快照存在与缺失、窗口重置边界；
- `agents.configure <id> <model>` 能切换共享第三方子代理并保持 Key 隔离。

## 6. 用户配置的主 Provider

Gateway 支持 Codex 用户配置中的一个自定义主 Provider，不要求模型目录或 Gateway
Setup。它读取 `~/.codex/config.toml` 的 `model_provider` 和 `[model_providers.<id>]`；若
`model_provider` 显式配置为 `openai` 时锁定官方 OpenAI，不自动激活候选；未配置且只存在一个候选
时沿用该候选兼容旧配置。自定义 Provider 只在 Gateway 监管的 App Server 子进程中选择。
Gateway 在 App Server 前启动本地统计代理；原配置中的认证方式、模型名、
`supports_websockets` 等字段仍由 Codex 处理。当前只支持 `wire_api = "responses"`，不把该 Provider
加入 `/model` 的跨 Provider 菜单，也不为它伪造账户余额或用量接口。

示例：

```toml
model = "gpt-5.6-terra"

[model_providers.thirdparty]
name = "Third-party Responses"
base_url = "https://proxy.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

可配置多个自定义主 Provider 候选块，但同一时刻只激活一个：`model_provider` 显式选中时激活
该候选，显式配置为 `openai` 时锁定官方 OpenAI；`model_provider` 未配置且只有一个候选时仍沿用
该候选兼容旧配置。配置自定义主 Provider 时不能同时设置顶层 `openai_base_url`。通过
`codexc primary-provider` 的
`add` / `switch` / `remove` 管理候选与激活状态。`codexc primary-provider switch openai` 不运行
登录直接切回官方 OpenAI，官方凭据保留；切回时自定义候选块移入
`~/.codex-connect/private/primary-providers.json`（0600）并从 config 清理，之后
`codexc primary-provider switch <ID>` 会从备份自动恢复。`codexc setup` 的“官方 → 登录并恢复官方”
会运行 `codex login --device-auth`（打开终端显示的链接并输入验证码）并执行相同的备份与清理。
从自定义候选切回官方时同时清除该候选留下的顶层 `model`；当前已经是官方模式时保留官方模型。
候选从备份恢复后会消费对应备份项；`remove` 同时删除配置候选和同名备份，配置事务失败时恢复备份。

`requires_openai_auth = true` 使用 Codex 当前 API Key/ChatGPT 认证；也可以按 Codex 官方配置使用
`env_key`，或写入 `experimental_bearer_token` 直接使用 API Key（Key 明文保存在 0600 的
`~/.codex/config.toml`，Codex 官方标注该字段用于程序化使用）。第三方主 API 使用自己的 Key 时
设置 `requires_openai_auth = false`，完全不依赖官方 auth.json，官方登录状态不受切换影响。
Gateway 不读取或复制凭据，只把用户配置交给 App Server。`base_url` 必须是无凭据、无查询
和片段的 HTTP(S) 地址；自定义 Provider ID 只能使用 ASCII 字母、数字、`-` 或 `_`，且不能占用
`openai`、`ollama`、`lmstudio`、`amazon-bedrock`、OpenCode Go 保留命名空间
`opencode-go` / `opencode-go-*`，或其他项目受管 Provider ID。

修改后运行 `codexc service restart all`。若上游不支持 Responses WebSocket，必须保留
`supports_websockets = false`，否则 App Server 可能在渠道中出现 WebSocket 建连失败。

已存在的 Thread 在 Codex 中保留创建时的 Provider：恢复旧会话时，官方实现会用线程保存的
`model_provider` 覆盖当前配置。因此切换 `model_provider` 后，旧会话仍走原 Provider（例如内置
`openai` 加顶层 `openai_base_url`，仍会先尝试 WebSocket 再回退 HTTPS），自定义 Provider 的
`base_url` 与 `supports_websockets` 不会对旧 Thread 生效。要让新 Provider 生效，先使用
`/new` 创建新会话；新 Thread 才读取当前 `model_provider` 并使用本地统计代理，且
`supports_websockets = false` 生效后不会再发起 WebSocket 连接。

会话内通过 `/model` 选择的模型和 Provider 会作为该会话的待生效偏好，覆盖配置文件默认值；
`/model clear` 可清除该偏好，让下一个新 Thread 重新使用 `model_provider` 默认值。Gateway
会把自定义主 Provider 的 Thread 路由到主 App Server 实例，不会为它启动独立实例。

该模式不支持自定义 Provider 的独立模型目录、`/usage` 账户适配、价格专用计价器或 Gateway 内跨 Provider
切换；自定义主 Provider 也不能作为共享 `agents.external` 角色使用，该角色仍由 DeepSeek / OpenCode Go
等受管 Provider 提供，可与自定义主 Provider 配置共存。需要这些能力时必须按本指南前述的编译期受管
Provider 流程接入。

可以通过 `codexc setup` 的“模型与提供商 → 第三方 → 自定义 第三方”引导写入上述配置：填写 Provider ID、
上游 `base_url`、认证方式（直接写入 API Key / 当前 API Key / `env_key` / 无认证）、是否支持
Responses WebSocket 和默认模型；Provider ID 固定为 `OpenAI`，避免手输填错（小写 `openai` 是
Codex 内置保留 ID，不能作为自定义 Provider）。Setup 通过 Codex 的 `config/batchWrite` 原子写入用户配置，
Key 输入不显示不回显；写入后仍需运行 `codexc service restart all` 生效。

## 关联文档

- [`docs/opencode-go.md`](opencode-go.md)：GO 形态参考实现；
- [`docs/deepseek.md`](deepseek.md)：余额 + CNY 计划价参考实现；
- [`docs/surface-integration-guide.md`](surface-integration-guide.md)：通讯渠道接入；
- [`docs/index.md`](index.md)：协议支持矩阵与实现映射；
- [`docs/codex-cli-upgrade-decisions.md`](codex-cli-upgrade-decisions.md)：Provider 边界决策。
