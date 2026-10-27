# 第三方模型 Provider 接入指南

本指南维护受管第三方模型 Provider 的现行接入合同、模型管理和恢复边界，并规定新增 Provider
的决策、实现与验收要求。通用执行顺序遵循[开发流程](development-rules.md#development-workflow)；
新增通讯渠道走 [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)。

聚合提供商当前关闭，本文只将独立提供商列为可用入口；保留的聚合实现及材料保护合同只用于
说明停用代码的边界，不表示支持启动或续接。关闭策略与旧服务加载要求见[用户配置的主 Provider](#6-用户配置的主-provider)。

## 日常模型管理

WebUI 从「模型管理 → 模型配置」查看各提供商模型；CLI 从 `codexc setup → 模型与提供商 → 第三方提供商 → 模型管理` 进入。
DS、CLP、CCG、OCG 及 OLC 按提供商各展示一组共用模型，自定义提供商各自展示；同名模型以提供商与模型 ID 精确选择。连接、账户和 Key 仍在既有接入入口设置。OLC 支持 CLI、Setup 和 WebUI 的添加、重配、默认及移除共享事务；首次添加选择模式、Key，再从公开远端元数据候选选择一个默认模型，确认后只生成所选模型，无需手填能力或推理验证。新增账户从已有目录选择模型，编辑账户保留当前默认模型；已有目录不经账户表单覆盖或刷新。新增或更换 Key 的预览及保存各读取一次固定 balance 认证接口，不发送推理请求；无变化不请求、不写入。首次选模令牌十分钟失效，绑定精确账户、Key、目录与公共底座修订。固定模式使用官方版本化主配置 writer 和私有凭据版本，切换模式保留既有私有 Profile 合同；未完成目录事务须先恢复。高级逐模型 Responses 验证为可选收费诊断，只有另行确认后才发推理请求；公开元数据与目录定义均不能作为真实云端能力验收。命令和恢复说明见[用户指南](user-guide.md)。
CLI 模型操作按添加、编辑、默认设置、模板更新、诊断和移除排列，仅显示目录支持的操作。受管目录提供「账户默认模型与共享思考等级」和「模型上下文窗口」；默认模型只属于所选账户，思考等级和窗口由同族账户共享。取消未保存的操作返回模型操作菜单，模型操作菜单可返回提供商列表；从账户入口进入后，返回保留在所属账户菜单。

第三方新增模型从 ID 自动带入显示名称时，使用 `/` 分隔的最后一个非空路径段，例如 `cline-pass/deepseek-v4.1-flash-1017` 带入 `deepseek-v4.1-flash-1017`、`vendor/model-name/` 带入 `model-name`。不含 `/` 的 ID 保持原样；没有非空路径段时须手动填写名称。上游 ID、已有模型名称、来源明确提供的名称及手动填写的名称不改写。

- 自定义 Responses/Chat 目录支持添加、编辑、默认设置和独立本地移除。模型编辑只提交模型字段，保存时重新读取连接和凭据；已有 ID 不可直接改名，需先添加再移除旧 ID。
- CCG、OCG、CLP 和自定义目录提供商共用按 ID 新增入口：选择独立填写或继承同一目录中的模型，预览后保存。独立填写使用通用编程提示词，逐项声明上下文、思考、图片及工具能力；继承复制保存快照，不复制凭据或模板关联。这些提供商不从官方列表自动发现。
- CCG/OCG 保留 DS 模板导入，CLP 使用仓库 DS 模板生成固定映射，均只追加明确选择的条目。DeepSeek 原生目录仍按其既有流程管理，暂不开放单模型移除；官方共享目录继续使用原有合同。
- OLC 默认提供“添加受管模型”，从公开 `/api/tags` 与 `/v1/models` 的精确 ID 交集发现缺失候选，并由 `/api/show` 自动取得窗口、思考与图片声明；不发送推理请求，只追加所选模型。思考 `false` 映射为 `none`；布尔开关的 `true` 使用兼容值 `high` 表示开启，不代表强度。命名等级保留精确值，`false` 可与命名等级共同保留；缺失元数据或不能唯一映射时不猜测。图片仅在声明 `vision` 时启用，最大上下文保留上游声明，默认配置窗口取上游值与 393216 的较小值，两者分别保存；Responses 默认启用 freeform 与客户端 `tool_search` 适配，关闭 WS、原图、摘要、详细程度和原生网页搜索。首次目录 manifest 为 `source: "ollama-cloud"`、空 `modelTemplates`；普通新增不伪造 `modelDiscovery` 或模板关联，不覆盖已有目录。来源及边界见[共享模型、远端选择与可选验证](ollama-cloud.md#共享模型远端选择与可选验证)。
- OLC 保留显式 `discovery: true` 的高级收费诊断入口，普通添加无需先通过诊断。已配置账户可在 CLI/Setup 或 WebUI 选择具体账户、一个准确候选及包含来源默认值的思考等级，另行确认可能收费的验证；每级两个 SSE Responses 请求验证普通函数与配对模拟结果续答，来源默认等级另加两轮 JSON，共最多 16 次、每次 768 输出 Token/128 KiB、总期限 90 秒含前后来源复核，无重试。SSE 必须实际交付与终态一致的 `output_item.done` 和文本增量，不以 JSON 快照替代原生流式证据。通过后仍需统一新增预览及确认保存，生成能力沿用普通添加的元数据及默认适配策略；诊断不证明思考质量、图片、freeform、客户端工具搜索或长上下文已通过。发现与验证令牌绑定精确账户、来源和本地修订；每次提交及保存前复核凭据与目录。
- OLC 不再提供按 ID 独立填写或继承新增，CLI、Setup、WebUI 及后端均拒绝该输入；模型 ID 原样保留 `:tag`。原生 `web_search` 声明不开放，托管 live 搜索另由精确账户设置控制；本地时钟和异步提问工具保留。已有 OLC 目录支持账户默认模型、共享思考等级和窗口调整及预览后本地移除。仅高级诊断成功保存时记录有界 `modelDiscovery`，与 `modelTemplates` 分开，保留逐模型 ID、元数据摘要/指纹、时间、本地窗口策略及验证范围；移除仅裁剪目标来源记录。旧 manifest 仍可读，不迁移或补写旧模型。两条 HTTP 出口共用请求级 custom 与客户端工具搜索表示适配；真实云端工具往返仍需独立验收，详见[OLC freeform 合同](ollama-cloud.md#freeform-工具适配)。

OLC 首次选模、普通添加和 `discover` 共用一小时的私有公开元数据缓存，命中后不查询远端。WebUI“强制刷新”或 `codexc provider ollama-cloud discover --refresh` 显式同步；失败报错且保留旧缓存，不使用过期数据生成新候选。缓存与十分钟确认令牌及持久模型目录相互独立，存储及恢复说明见 [OLC 共享模型](ollama-cloud.md#共享模型远端选择与可选验证)。

移除先预览再确认，保护所有共用该目录账户的默认模型、最后一个模型和当前主提供商的 Gateway 显式默认值。
配置或目录变化后必须重新预览。旧接入编辑、启用选择和联网刷新不能通过取消旧项绕过移除流程；新增或曾移除模型需显式选择才加入。
保存前备份原目录，保存不自动重启服务；按结果提示重启以刷新 App Server 展示。
历史会话与任务保留，失效引用可能执行失败，不自动替换模型。

共用目录的 Relay Key 授权不会被删除：移除后调用受目录约束，重新加入可能恢复旧授权；永久撤销应在 Key 管理操作。
目录变化也可能撤销该提供商其他 Relay 在途请求；关闭的聚合入口不参与刷新。CLP 与其他受管提供商一样共用渠道和 Relay 模型目录，移除会限制 Relay 后续调用；Key 授权仍需独立管理。
移除没有回收站；恢复需明确重新添加、导入或核对备份，不能用旧备份覆盖后续变更。
写入或回读结果不确定时停止修改，核对目录和备份；自定义目录保留 pending 时使用既有恢复入口。WebUI 账户页保留操作结果及审计降级提示；写入结果不确定后必须先成功回读才能继续修改，成功回读不会把先前不确定的写入标为成功。停止结果单独区分已停止、未运行和租约占用。

当前受管第三方 Provider 是编译期注册的：DeepSeek、OpenCode Go、CCG 与 CLP 共用同一套受管管道，
Provider 特化只存在于定义能力元数据、Bootstrap 有界工厂、账户和 Setup。
新增 Provider 时优先复用管道，不得动态加载代码，也不得把未知 Provider 回退到 OpenAI 账户查询。

## 异步提问与时钟工具

所有第三方提供商默认开放 Codex 的 `request_user_input_async`，覆盖 Responses、Chat Completions、
固定模式和切换模式；聚合模式当前关闭。目录声明使用固定底座 `experimental_supported_tools` 中的
`send_user_message_async`，实际工具名仍为 `request_user_input_async`。模型发出问题后可继续执行，用户回答送回原 Thread；
任务仍在执行时追加到当前轮，已结束时开启下一轮。模型是否主动提问由其行为决定。
该工具由 Codex 本地执行，不需要上游提供专用异步提问 API；仍需模型正确调用函数工具。
Codex 显式关闭用户输入工具的配置和主代理限制继续生效。

第三方同时声明 `clock`，由上游提供 `clock.curr_time`（UTC 当前时间）与 `clock.sleep`（可被新输入
打断的等待）。不依赖第三方的专用 API；上游 `sleep_tool` 开关及 `current_time_reminder` 配置条件
仍然生效，不强制覆盖显式关闭设置。DS 官方 Flash 经 Responses 与 Chat 的人工观察均确认取时间、
2 秒等待及通过 `turn/steer` 提前结束 20 秒等待；无效 0 毫秒等待被上游拒绝，其他模型未逐项实测。

新建自定义模型会保存这两项本地工具声明，其模板草稿也带入相同声明；已有模型可通过模板更新中的“本地工具”范围明确合并。
项目管理的 App Server 启动时仍为有效模型目录补齐声明，已有提供商配置无需重新保存或迁移。
启动投影不改源模型目录、模型选择、凭据、窗口和提示词；私有运行目录每次启动重新生成，失败则拒绝启动，
不回退到未开放的目录。更新程序后需在合适时机按服务管理流程重启 App Server 才会生效，
仅重启 Gateway 不会替换已运行实例。直接运行原生 `codex` 而不连接项目管理的 App Server 不适用此策略。

## 重复思考保护

Gateway 对已绑定、已订阅的第三方提供商会话启用重复思考保护，包括 DS、CLP、CCG、OCG及自定义 CP，覆盖固定与切换模式；OpenAI 官方不启用。只依赖 App Server 实际返回的原始思考或思考摘要文本增量，不按模型名称猜测能力。只返回加密内容、没有推理增量的模型无法检测，与渠道“思考状态显示”开关无关。

同一 Thread／Turn／推理 Item／内容段内，200–4096 个 Unicode 码点的逐字相同片段连续出现三次时，请求中断该 Thread 的当前轮次。原始思考与摘要各自检测，交错返回也不拼接或重复计算；空白、标点参与比较，不做近义或跨段判断，不把完成快照和历史重新计入。

命中先提示原因与正在停止，收到官方 `interrupted` 终态后才提示已停止、等待手动继续；失败或 10 秒内未确认时提示使用 `/stop`。Gateway 不自动继续，不删除 Queue、不暂停或清除 Goal；原生中断保留普通队列并暂停自动派发。它只中断当前 Turn，不递归停止子代理，也不能阻止其他客户端或触发型代理邮件启动新轮次。未绑定子线程和 Gateway 离线期间不在本保护范围内。

检测不读取会话文件、不记录思考正文，仅使用有界内存并分批执行。每轮待处理增量上限 32,768 个 UTF-16 码元、128 个片段，最多同时保留 32 个轮次；超限重置窗口或释放旧检测缓冲，并显示范围受限提示。超大增量只保留尾部，突发输入超限和超过 4096 字的重复片段可能漏检；已结束轮次不再补发中断。切换内容段、工具边界、请求错误、对应 Provider 断线、绑定失效、轮次结束及 Gateway 关闭均隔离或清理检测状态。进程内保留最近 128 个已触发或已结束轮次的标识以拒绝迟到重放，不持久化；中断等待 Provider 就绪后、提交前再次复核绑定。内容本身逐字重复也可能是正常推理，误停后可手动继续。

## 1. 接入前决策清单

开始实现前必须逐项确认，未确认或无法验证的项失败关闭：

| 决策点 | 选项 | 说明 |
| --- | --- | --- |
| Provider id | 小写字母/数字/`-`/`_`，1–64 位 | 决定 `sf-<id>.config.toml` Profile、`modelProvider`、环境变量名；受管账户材料位于 `providers/<家族>/<id>/`，自定义 CP 位于 `providers/<id>/` |
| 显示名称 | 1–64 字符 | 出现在 `/model`、WebUI 与完成卡片 |
| wire API | App Server 仅 `responses` | Chat 上游需显式独立转换；CLP 与上游接口为 `chat_completions` 的自定义第三方 Provider 使用 `model-api` 模块与 Chat 桥，不把 Chat 写入 Codex `wire_api`。转换覆盖 `function`、`namespace`、自由格式 `custom`、客户端 `tool_search` 与 multi-agent v2 的 `agent_message` 输入项；模型目录可用 `applyPatchToolType: freeform` 与 `supportsSearchTool` 开启自由格式 `apply_patch` 与客户端检索；未映射的顶层工具声明原样交给上游，不注册本地执行身份，也不承诺托管工具执行与回程；第三方 `wire_api = "responses"` 上游由 ProviderProxy 在提交前归一化 Codex 私有输入项，`agent_message` 降级为普通 `user` 消息、工具参数 schema 的 `encrypted` 布尔标记被删除，HTTP 与 Responses WS 一致，官方 OpenAI 端点保持原文透传；原生网页搜索遵循 Provider 搜索配置并保留工具透传与上游策略，历史模型搜索元数据不参与门控 |
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
元数据；watcher 按精确 Provider ID 及其账户目录监控变化。

### 3.2 模型目录与 manifest

CLP 的 CLI 模型管理提供“本地编辑已有模型”：直接读取已保存配置，按设置组选项修改并预览差异，不下载模板。适用于固定映射之外按 ID 添加的模型。精确 ID、请求格式、来源关联、其他模型及未选字段保持不变；修改共享目录会影响同族账户，默认等级按已有规则同步切换 Profile。无变化或取消不写入，过期确认被拒绝；保存沿用受管目录备份与恢复。另有“编辑请求改写”入口（CLI 与 WebUI 模型操作均提供），只编辑模型级 `providerOptions` JSON；字段不设白名单，格式校验、合并规则、拒绝项和上游限制见 [CLP 请求改写](cline-pass.md#请求改写)。完整本地编辑目前由 CLI 提供，WebUI 继续使用已有名称、上下文、默认值和模板更新入口；模板更新仍须明确选择可用来源，不把本地编辑伪装成下载成功。

- DS、CLP、OCG、CCG、OLC 分别在 `~/.codex-connect/providers/deepseek|clp|opencode-go|ccg|ollama-cloud/` 保存一份共用 `models.json`，不按账户拆分模型文件，schema 与现有目录一致：每个模型必须有
  `context_window`、非空 `supported_reasoning_levels`、合法 `default_reasoning_level`、
  `display_name` 与输入能力；`max_context_window` 存在时作为可设置窗口的上限，上下文窗口
  由模型管理按提供商和模型写入，同一提供商账户共用该值；`auto_compact_token_limit`
  是独立的上游压缩阈值，不换算为上下文窗口，修改窗口时也不清空该字段；
  显式更新模板的压缩设置时，来源阈值缺失或为空表示“跟随默认”，通过省略目标字段保存，不写入 `null`；来源是有效数值时保留该数值。未选择压缩设置则保留原字段，不在读取时自动清理旧目录。
- 同目录写入 `models.manifest.json`：目录来源与下载时间（CLP 新目录记录固定 DS 来源关联，既有 Cline 提交记录保留；OCG 额外记录下载
  `sha256`）；Profile（切换模式）与固定基础配置仍位于 `~/.codex`，原生 `codex --profile` 只识别该目录；
- 目录按 Provider 隔离；同名模型（如两个 Provider 都提供 `deepseek-flash`）是独立选项，
  模型管理 key 为提供商加模型，思考等级、上下文、启用名单、移除与刷新由同族账户共用；账户各自选择默认模型；
- 可选模型以各 Provider 生成的模型目录为准：OCG/CCG 初始从 DS 官方脚本下载完整目录，复制 Flash 内容增加 V4.1，并按 Provider 映射模型 ID；配置后可通过账户模型管理查看已有模型、显式添加上游支持的 Responses 模型或发现／导入新模型，移除走独立的本地移除入口。新增模型的准确 ID 与能力必须确认，不把 Cline 专属路由或 Chat 参数复制给其他提供商；
- 新增模型的显示名称使用模型本身的名字，不自动添加 CLP、OCG、CCG 平台前缀；手动填写的名称保留原意，已有目录不自动批量改名，可通过显示名称编辑入口修改。
- 默认模型写入 Profile 后，各账户 Profile 顶层 `model_reasoning_effort` 必须镜像所选共享模型的默认值，目录写入和相关镜像在同一事务中保存，
  运行时校验不一致即失败关闭。

CLI 与 WebUI 的默认设置共用版本化预览与保存计划。默认模型只修改所选账户；所选模型的默认思考等级修改同一提供商共享目录，影响同族账户，使用该模型作为默认值的切换 Profile 同步镜像等级。预览分别列出账户默认模型目标与共享思考等级影响账户，明确确认后才保存；目录、账户注册表、运行模式或相关配置变化会拒绝旧预览，须重新核对。当前值未变化时仍复核修订和快照，但不写目录、Profile 或备份，也不要求重启。带有不受支持窗口覆盖的配置由读取端拒绝，默认设置不作为清理入口；窗口在独立模型目录入口修改。相同模型 ID 属于其他提供商时不联动，也不自动重启服务或改写历史 Thread。

保存后回读所选账户默认模型、同族模型等级及其他账户默认选择；固定模式还回读主配置，不能只凭配置写入返回就宣称成功。回读失败或发现不一致返回 `save-unconfirmed`，保留当前配置及既有目录备份，勿自动重试；先核对实际配置与备份。此操作没有新增跨主配置与目录的恢复记录，不能把目录 `recover` 当作主配置的自动回滚。
固定模式配置写入失败且确认未生效时，只有目录写入后的相关文件未发生后续修改，才自动恢复旧目录；否则保留现场并报保存结果未确认，避免覆盖后续编辑。

模型选择复用 `scripts/provider-model-selection.mjs`，保护默认模型并限制数量。CCG、OCG、CLP 与自定义目录的按 ID 添加，以及 OLC 的公开元数据选模添加，共用 `scripts/provider-model-additions.mjs` 和 CLI/WebUI 流程，持久化分别交给原有受管目录或自定义 v5 事务。OLC 默认读取远端候选且不发送推理请求，显式 `discovery: true` 才进入可选收费诊断；CLP 固定 DS 映射与模板候选读取仓库模板，不再下载 Cline 目录。通用编程指令由 `runtime/third-party-coding-instructions.mjs` 提供。

统一模板更新保留原思考等级及当前上下文；新模板不再支持原等级或窗口时拒绝更新，包括非账户默认模型，不自动换等级。CCG／OCG 添加和模板导入使用与受管移除相同的目录／来源持久事务；无内容变化不更新备份或要求重启。DS 账户重新配置保留已保存目录，不补全提示词或归一化能力。完整统一覆盖与边界见[当前链路与后续统一方案](unified-model-management-design.md#当前链路与后续统一方案)。

DS 官方账户的来源投影关闭详细程度与摘要参数声明；CCG／OCG 的初建、导入和更新均保留 DS 源目录中的对应声明，不把 DS 官方端点的限制套用到其他平台。模板能力仍须按实际平台确认。
这些来源投影均排除 `service_tiers` 和 `additional_speed_tiers`，不把服务档位或加速选项作为模板配置带入；原始来源快照保留用于审核。

WebUI 编辑已有自定义提供商与仅编辑模型均须携带打开编辑器时的资源修订；其间 CLI、另一页面或外部操作修改相关设置后，预览及写入拒绝旧表单，须刷新后重新编辑，不能通过修改连接设置把旧模型模板写回。

`runtime/model-template-prompts.mjs` 负责补全缺失的基础提示文本，保留显式值；`approvals: null` 按已确认规则继承基础审批提示词，缺失的 `token_budget` 整组携带必要开关与阈值。`runtime/model-template-catalog.mjs` 在显式创建或更新时读取仓库基础快照，把完整提示词固化到目录或定义的 `modelMessages`。加载已有目录只按其已保存内容生成并校验，不注入当前模板，避免模板更新改变磁盘定义／生成目录的一致性。

自定义提供商编辑先选择“模型管理”或“连接、凭据与运行模式”。模型管理复用统一模型入口，只修改模型字段；连接编辑保留已有模型及默认模型，不重新询问模型能力或发起工具探测。添加与编辑保存保留全部已有模型，移除请使用独立移除入口，当前默认模型不能移除。模型填写完成后选择默认模型，新增模型可在同次保存中设为默认；最后查看预览并确认才写入，没有中途保存。普通编辑不会重新补全已有提示词；专用模板更新入口在明确选择“提示词”后替换目标模型的提示词。目录写入继续使用现有备份及未完成事务恢复机制；不自动迁移或重写既有数据。

自定义模型整表保存同时确认目录默认模型、实际 Provider 默认模型和思考等级的前后值；固定模式原有独立思考等级可能随此次默认设置改变。CLI 编辑保留已有模型顺序，不因默认项位于中间而重排目录。仅调整当前上下文时，保留未选择的有效最大窗口和工具输出截断策略。目录和实际默认值均无变化时返回未变化，不写配置、目录或恢复材料；只有默认选择变化时不轮换模型目录备份。

新增自定义模型 ID 禁止控制字符、零宽格式字符和孤立代理字符。当前目录格式此前接受的精确 ID 仍可读取，并可通过独立移除入口清理；最后模型、目录默认及实际默认模型等保护继续适用，不自动清洗或改写 ID。

受管账户预览绑定相关配置、账户注册表及凭据版本的私有修订；另一 CLI 或页面完成 Key 轮换后，旧确认会被拒绝，须重新读取和预览。已有自定义切换提供商时不能配置受管固定模式，须先显式处理这些提供商。默认账户、默认模型及上下文未变化时不写文件、不轮换备份、不要求重启。

第三方模板在显式创建或更新时，为自动审批模式提示词和拒绝后的提示词追加“使用中文回复用户”的要求，涵盖审批结果、拒绝原因及后续操作说明，命令、路径和技术标识符保留原文。原审批约束保留，重复投影不重复追加，显式空文本不注入。仓库原始快照不修改，已有目录需在模板更新中选择“提示词”并确认保存后才获得该要求，普通读取不自动更新。

官方底座和 DS 来源的模板投影从 `runtime/model-catalog-base.json` 的 `experimental_supported_tools`
受控补齐 `send_user_message_async`、`clock` 两项本地工具声明，保留来源的其他工具声明，不复制其他底座能力。
主提示词保留来源正文及显式空值，仅执行已知来源身份中性化；不再追加额外的中文取时间与等待指导。
缺失的辅助提示词仍按上述补全规则处理，独立的审批中文回复要求保留。CLP 生成目录在定义编译后补齐这两项声明；
CP v5 使用可选定义字段 `experimentalSupportedTools` 保存本地工具声明，编译为 `experimental_supported_tools`；
未声明该字段的旧定义维持原编译字节，工具字段仍为 `[]`。新建自定义模型从固定底座补齐两项，已有模型仅在明确选择“本地工具”模板更新后合并；读取不迁移或改写用户文件。
运行副本仍设 `use_responses_lite: false`，来源模板的 Lite 元数据保留。已有模型如需清除旧版追加的中文时钟尾段，
须显式选择“提示词”并确认模板更新；仅更新能力不改提示词。原始底座与 DS JSON 快照不修改。

#### 当前目录布局与旧版本恢复

当前仅支持以下目录布局：

- DS、CLP、CCG、OCG、OLC 各自在 `providers/deepseek|clp|ccg|opencode-go|ollama-cloud/models.json` 保存一份共用模型目录，manifest 和模型设置备份位于同目录。
- 账户管理标记、安装备份及私有凭据位于家族下的完整账户 ID 目录，例如 `providers/clp/clp-main/`、`providers/deepseek/ds-main/`、`providers/ccg/ccg-main/`、`providers/opencode-go/ocg-main/` 和 `providers/ollama-cloud/olc-main/`。
- 自定义 `cp-*` 各自表示不同提供商，使用 `providers/<cp-ID>/models.json`，不并入受管家族共用目录。

旧 `providers/<家族>/accounts/<账户>/`、平级 `providers/<完整账户 Provider ID>/` 布局及旧目录引用不受支持。新版保留检测并拒绝加载，不迁移、合并或删除用户文件；即使模型已经共用，也不能沿用旧账户身份材料路径。当前版本不提供旧布局迁移入口，程序安装与更新不处理此类历史数据。

历史目录迁移的未完成记录为 `~/.codex-connect/private/provider-catalog-isolation.json`。该记录存在时，账户配置加载、目录使用、自定义目录首次创建及 `codexc provider recover` 的所有恢复分支均拒绝继续。应先保持相关服务和客户端停止，保留全部原文件、备份和标记，使用产生该事务的对应旧版本及其恢复入口处理；不要删除标记、改写引用或套用当前模型设置恢复命令绕过保护。历史恢复须核对后续修改和对应代码，不能用旧备份覆盖现有数据；当前版本不承诺替旧版恢复或反向合并后续模型修改。

模型设置恢复与上述历史目录迁移不同：当前 CP 目录 pending、受管共用目录 settings-pending 及历史上下文恢复入口仍按各自合同保留。共用目录设置在同一事务中保存模型、来源和相关 Profile，schema 2 guards 记录同族注册表、管理标记等只读前置条件；任一同族账户均可发起受控恢复，不覆盖其他家族或后续修改。只有历史目录迁移保护解除且当前布局有效，才能继续相应模型设置恢复。

自定义 Responses 出站复核与配置加载共用版本 5、允许字段及定义／生成目录一致性校验。目录 `.pending`、旧 DS/CP 上下文事务或历史目录迁移未完成标记存在时，普通 HTTP 和 Responses WS 均拒绝新请求；读取前后检查标记，目录或事务不可用统一返回 `503 provider_catalog_unavailable`。恢复有效目录并完成事务后，下一次请求重新复核，不缓存失败或成功名单。受管账户出站同样检查历史目录迁移未完成记录。

OCG/CCG 与自定义 `cp-*` 的普通代理及聚合下游均在发送前复核当前目录：HTTP 和 Responses WS 拒绝未知／已停用模型，旧会话不自动换模型。自定义固定模式与切换模式使用相同的目录保护，固定模式按实际 `cp-*` 身份选择目录，内部主实例路由键不参与模型名单判断；Chat 上游同样在转换前复核。HTTP 错误为 `409 provider_model_disabled` 或目录不可用的 `503 provider_catalog_unavailable`；WS 返回对应 error 后关闭连接。CLP 保留专属错误码，独立 Relay 沿用自己的授权。名单约束即时读取，目录展示与能力仍按原服务刷新流程应用。

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
  失败关闭，连接退出或异常断开时自动撤销租约；账户移除和停止也必须核对已注册但尚在启动的实例，由 Supervisor 串行释放并检查租约，不能仅凭尚未运行就跳过保护；
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

DS、OCG、CCG、CLP 与 OLC 固定模式的主 `~/.codex/config.toml` 只保存带随机版本的 `env_key`，Key 位于
`~/.codex-connect/providers/<家族>/<provider-id>/primary-credentials/<版本>.json`。
JSON 使用版本 1，字段限于 `schemaVersion`、`providerId`、`origin`、`apiKey`，私有读取严格核对版本、Provider 和固定上游 Origin；
Unix 文件/目录分别为 `0600`/`0700`，Windows 使用私有 ACL，主配置可供 Codex 沙盒读取且不包含 Key。
每次明确重配先写新私有版本，再通过官方用户层 `config/read` 和带 `expectedVersion` 的 `config/batchWrite` 发布主配置引用。
DS、CLP、CCG、OCG 与 OLC 的新增、重配、模式转换和删除共用该字段写入边界；只编辑本次计划中实际变化的字段，保留未选字段及其他账户，不用旧快照全文件替换主配置。
官方用户层读取会将路径字段规范化；事务在读取前后复核磁盘原始字节，以取得对应版本，不把规范化后的对象与原始 TOML 全量比较。写后回读同样复核字节稳定性，并按实际磁盘字段确认本次变更。未选路径保持原文；本次变更涉及 `model_catalog_json` 时按配置目录或其用户主目录语义解析为绝对路径后提交，以满足官方写入校验，恢复时仍指向原目录文件。
旧版本与现有初始备份、归档保留，避免旧引用失效；这不是跨主配置与私有文件的原子事务。
写入响应丢失先回读；已确认字段保存则继续，无法确认或结果不一致时保留私有文件、凭据及备份，不自动重放或恢复备份。
已确认失败时先恢复已有文件再清理新增文件；必要的主配置回滚只逆转本次字段，仍需重新读取并带版本条件写入。
并发冲突或恢复失败明确报错并保留尚未删除的恢复资料；原本不存在的主配置在字段清除后可保留空 TOML，不删除上游创建的文件。
版本冲突检测与字段持久化遵循锁定 Codex 的官方合同；官方版本比较与最终文件替换之间并无全局文件锁，不能据此承诺任意原生写入的系统级串行化。
删除账户保留凭据版本与私有备份。

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

静态检查与提交门禁遵循[验证规则](development-rules.md#verification)。功能验收应覆盖受影响的
拒绝、失败和恢复路径，并观察真实用户入口到结果；下列源码安装、服务重启及线上检查只用于
已获授权的部署验收：

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
request_max_retries = 4
stream_max_retries = 5
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
两种入口共用切换计划；受管账户仍处于固定模式时，在登录或写入前拒绝切换，需先在 Setup 将对应账户改为切换模式。设备登录期间切换影响范围变化时拒绝提交，需重新确认。
从自定义候选切回官方时同时清除该候选留下的顶层 `model`；当前已经是官方模式时保留官方模型。
自定义模型 Provider 留下的顶层模型目录和思考等级也随切换计划清理。
候选从备份恢复后会消费对应备份项；官方模式下可从 Setup 直接把备份候选编辑为固定或切换模式，或经二次确认删除
备份候选，不需要先切换到第三方。恢复、编辑或 `remove` 都先提交配置，成功后才消费同名备份；
配置写入失败时原备份保持不变，配置已提交但备份清理失败时明确提示部分成功。备份不可安全读取时，
只允许编辑当前 config 中的候选，切换和删除失败关闭。

未声明独立凭据时，`requires_openai_auth = true` 使用 Codex 当前 API Key/ChatGPT 认证；已有 Provider 也可按 Codex 官方配置使用
`env_key`，普通切换保留该引用。两者共存时，锁定上游优先读取 `env_key`，缺失时不回退官方认证；`requires_openai_auth` 仍影响账户语义，切换不能据此将其清为 `false`。经 Gateway 新增或替换的自定义固定 Key 只把凭据环境变量名称写入主配置，实际 Key 保存在
`~/.codex-connect/providers/custom/<ID>/primary-credentials/<版本>.json` 的当前用户私有文件中；使用独立模型目录的 `cp-` Provider 则归入 `providers/<ID>/primary-credentials/`。
普通环境变量引用在 Windows 忽略名称大小写，在 Unix 精确匹配；复制后的环境对象若含多个已定义的同名大小写变体，Gateway 拒绝使用歧义凭据。Gateway 私有版本引用仍严格读取对应文件，不回退环境变量。
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
CCG、CLP 或 OLC 时使用该家注册表标记的默认账户，混合其他 Provider 时先通过 `/model` 选择提供商和模型，再发送消息；
选择在当前 Conversation 中沿用。官方不可用时，Gateway 的官方 `codex.default_model` 不阻断第三方选择。
已有 Thread 保留自身 Provider，不因官方退出登录而自动迁移。
同一 Provider 内选模型只标记模型待生效；只有实际离开旧 Provider 的 Thread 才提示创建新 Session，
目标 Thread 建立后该提示消失。
`codexc remote` 与 `codexc app` 默认都连接主实例，不根据官方登录状态自动选择第三方；Remote 显式受管 `--profile` 仍选择对应实例。
上述自动选择只用于渠道未绑定会话。两个 CLI 入口的 `-p` / `--provider` 均接受已配置的完整
Provider ID（推荐 `ds-main`、`clp-main`、`ocg-main`、`ccg-main`、`my-provider`）和注册表中精确登记的
规范 `sf-*` Profile 名称，不通过剥除前缀推测别名。聚合提供商当前关闭，`agg`、`sf-agg` 和内部
`codexc-aggregate` 选择均明确拒绝；渠道不注册聚合目录，Supervisor 不登记聚合实例。
聚合代码、派生目录、历史 Thread 和旧绑定保留，不自动迁移或删除；旧绑定不能继续调用聚合实例，
须显式选择一个独立提供商后新建会话。已运行的旧服务需在任务结束后正常重启 App Server 和 Gateway
才能加载关闭策略；代码更新本身不会自动停止服务。
自定义 `agg` 可明确使用 `sf-custom-agg`。Remote 的 `--profile` 继续用于个人 Profile 或规范受管 Profile，
与 `-p` / `--provider` 互斥；`--` 后原样透传。Desktop 仍要求主 Provider 为 OpenAI，并限于 macOS / Windows 预览入口。
Gateway 不读取或复制凭据，只把用户配置交给 App Server。`base_url` 必须是无凭据、无查询
和片段的 HTTP(S) 地址；自定义 Provider ID 只能使用 ASCII 字母、数字、`-` 或 `_`，且不能占用
`openai`、`ollama`、`lmstudio`、`amazon-bedrock`、DeepSeek 保留命名空间 `deepseek` / `ds-*`、OpenCode Go 保留命名空间
`ocg` / `ocg-*`、CCG 保留命名空间 `ccg` / `ccg-*`、CLP 保留命名空间 `clp` / `clp-*`，或其他项目受管 Provider ID。`opencode-go` 是当前管理命令与磁盘目录名称。

修改后运行 `codexc restart all`。若上游不支持 Responses WebSocket，必须保留
`supports_websockets = false`，否则 App Server 可能在渠道中出现 WebSocket 建连失败。
所有通过 Codex 的 Provider（官方、第三方固定及切换）统一采用锁定 Codex 0.164.0 的重试语义：HTTP 失败最多重试 4 次、流失败最多重试 5 次。第三方启动显式注入 `4/5`；代理和 Chat 桥不叠加重发。新建受管 Profile 写入相同值，已有配置文件不自动改写，启动覆盖统一实际行为；Profile 中已有重试字段仍按非负安全整数读取。

所有 Codex 实例保留原生网络重连、取消和 WebSocket→HTTP 降级，不注入第三方专属的 `unbounded_connection_retries` 开关。该功能由 Codex 的默认值、用户设置及受管要求共同决定；锁定版本默认开启，符合条件的普通采样连接失败可能持续退避重连。HTTP、流重试和传输降级是不同层，因此不承诺整个 Turn 的固定发送次数或总时长。HTTP 重试针对可恢复的 5xx 和传输错误，使用 Codex 退避及上游等待建议；Chat 桥保留经过校验的 `Retry-After`。独立 Relay 不经过 Codex，不自行重试，由调用方决定。

启动就绪前通过 `config/read` 核验实际第三方 Provider 的 `4/5`，受管 Provider 覆盖冲突或核验失败会拒绝就绪。官方 OpenAI 保持内置默认；不把同名原始配置块误认为已覆盖内置 Provider。更新程序后重启 App Server 激活进程策略。

已存在的 Thread 在 Codex 中保留创建时的 Provider：恢复旧会话时，官方实现会用线程保存的
`model_provider` 覆盖当前配置。因此切换 `model_provider` 后，旧会话仍走原 Provider（例如内置
`openai` 加顶层 `openai_base_url`，仍会先尝试 WebSocket 再回退 HTTPS），自定义 Provider 的
`base_url` 与 `supports_websockets` 不会对旧 Thread 生效。要让新 Provider 生效，先使用
`/new` 创建新会话；新 Thread 才读取当前 `model_provider` 并使用本地统计代理，且
`supports_websockets = false` 生效后不会再发起 WebSocket 连接。

会话内通过 `/model` 选择的模型和 Provider 会作为该会话的待生效偏好，覆盖配置文件默认值；
`/model clear` 可清除该偏好，让下一个新 Thread 重新使用 `model_provider` 默认值。Gateway
在固定模式把自定义 Thread 路由到主 App Server；切换模式保持官方 `openai` 主实例，并通过
自定义目录提供商的 `~/.codex/sf-cp-<名称>.config.toml`（ID 为 `cp-<名称>`），或 Codex 兼容类型的 `~/.codex/sf-custom-<Provider ID>.config.toml` 启动独立自定义 App Server。每个 Profile 完整保存该
Provider 的选择、地址、API Key、默认模型、`model_reasoning_effort = "medium"`、服务层级、
`request_max_retries = 4` 和 `stream_max_retries = 5`；受管 Provider 的新 Profile 也写入同一重试
边界，主 `~/.codex/config.toml` 保持官方配置。
`codexc remote -p <Provider ID>` 或 `codexc app -p <Provider ID>` 连接该隔离实例；
规范 Profile 名称 `sf-cp-<名称>` 或 Codex 兼容类型的 `sf-custom-<Provider ID>` 也可传给 `-p` / `--provider`，Remote 还可显式使用
`--profile <规范 Profile 名称>`，与原生 Codex 及磁盘文件的命名保持一致。
渠道 `/model` 复用 Codex 官方模型目录并以精确自定义 Provider ID 展示同名模型，
跨 Provider 选择沿用现有新 Thread 路由边界。锁定版 App Server 不接受 `--profile`，后台服务会先
严格校验每个 Profile，再把非敏感字段转换为 `-c` 启动参数；API Key 只进入目标子进程环境，
不进入命令行。多个切换模式 Provider 通过私有显式注册表同时保留，并使用独立 Socket 与统计代理。

Codex 兼容 Provider 不接受用户自定义模型目录、第三方 `models.json` 或第三方 `/models` 刷新。服务启动时会用
配置的 Codex CLI 执行 `debug models --bundled`，把 Codex 官方目录原子写入
`~/.codex-connect/providers/custom/official-models.json`（0600），并通过 `model_catalog_json`
注入固定/切换自定义 App Server；目录只随本机锁定的 Codex CLI 版本更新。该只读目录不接受第三方扩展能力声明，Codex 兼容 Provider 的原生网页搜索保留工具透传与上游策略，使用该 Provider 的搜索覆盖，缺省跟随用户全局设置。
主 Provider 切换在预览和执行中校验最终模型：显式模型优先，其次目标 switching Profile，最后沿用主配置。切入官方目录目标时，非法继承会拒绝并要求明确选择，完全缺省仍保留默认继承；切回 OpenAI 的既有清除第三方默认模型行为不变。
自定义 Provider 切换模式可以与受管切换模式
共存，但不能与任何受管固定模式同时启用。需要手填模型时使用下面的自定义提供商；需要账户能力时，仍按本指南前述的编译期
受管 Provider 流程接入。

可以通过 `codexc setup` 的“模型与提供商 → 第三方提供商 → 自定义提供商”新增或编辑固定、切换模式 Provider；新增选择官方模型目录：填写上游
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
切换 Profile 转固定模式前，共享事务还在 Gateway 数据目录的 `providers/profile-conversion-backups/<随机 ID>.json`
保存本次主配置、旧 Profile、注册表、目标 Provider、配置修订及预期修改；私有备份写入并回读确认后才删除 Profile。
每次转换独立保存，成功或失败都保留，不覆盖旧快照、不自动清理。它包含凭据，不得提交或公开。
结果未知时先停止后续修改并重新读取主配置：完整转换成功则保留当前状态；需要回退时先另存当前材料，
确认主配置仍为转换前状态且不引用目标固定 Provider，再恢复快照中的目标 Profile 与注册项。
不得整份覆盖主配置或注册表；有后续修改、同名条目、部分提交或无法读取时保留材料并人工核对。
此快照供人工恢复，`codexc provider recover` 仍只处理其既有目录恢复合同。
具体审查与验证见 [Provider 事务审查](provider-transaction-review.md#p01-转换失败时保留完整连接配置)。
切回官方时备份候选的凭据引用也保留；显式删除 Provider 时才删除该 Provider 已验证归属的凭据版本。
切换预览、执行和备份恢复共用运行时的认证校验；`auth`、`gateway_oauth`、`aws` 和 `env_http_headers` 不受自定义固定模式支持，写入前明确拒绝，保留原主配置、备份和凭据。固定模式编辑也校验合并后的实际 Provider 配置，包括请求期限约束，不会静默删除不支持的字段。普通非认证 `http_headers` 仍保留，Chat 桥同样转发端到端附加头，并重写目标 Host、正文长度和内容协商字段，过滤跳级头及本地诊断关联头。
凭据版本损坏或无法安全读取时保留文件，并以 `credential-cleanup-failed` 报告 Provider 已删除但凭据清理未完成。
备份应同时保留主配置、`private/primary-providers.json` 与该 Provider 的 `primary-credentials` 目录；恢复时一并还原，
不要只恢复主配置引用而丢掉对应 Key。回退到旧 Gateway 前应恢复操作前的完整备份；新 Gateway 不会替用户生成旧明文合同。

服务仅把选中固定 Provider 的 Key 注入其 App Server 子进程环境；配置管理临时 Client 只执行配置及模型目录元数据操作，
无需加载 Key，因此缺失或损坏的私有凭据仍可显式编辑修复。Key 不进入启动参数。`codexc remote` 连接共享实例，无需向 TUI 注入 Key。直接运行官方 `codex` 不会自动读取 Gateway 私有
JSON 凭据文件；使用固定模式时应运行 `codexc remote`，若自行启动官方 CLI 执行模型请求，则须在该进程环境中提供主配置 `env_key`
指定的 Key，并自行管理其环境保密性。

自定义固定 Provider 的代理目标和凭据绑定到同一次服务启动；修改 Provider、上游地址或凭据后，旧服务拒绝按需重建主实例，须执行 `codexc restart all`。空闲释放后恢复也遵守此限制，不会将新 Key 注入旧代理。

## 独立提供商的搜索模式

CLI 使用 `codexc config → 提供商联网搜索`，也可从 `codexc setup → 模型与提供商 → 提供商联网搜索` 进入同一流程。选择精确提供商账户、搜索模式，查看变更前后值并确认后保存；“跟随全局”删除该提供商覆盖。官方和固定提供商共用主配置，菜单提示转到 `codexc config → Codex 新会话与用户偏好 → 联网搜索模式`。CLI 与 WebUI 共用预览、事务锁、备份、过期确认检查和回读流程；取消或值未变化不写入，不发搜索探测请求，也不自动重启服务。

WebUI `#/models/providers` 的行内“操作 → 提供商联网搜索”为选中的独立提供商设置搜索模式。
支持具有独立 config 的第三方受管账户、Codex 兼容提供商和自定义切换提供商；
按精确 Provider ID 隔离，不按家族、显示名称或共享模型目录联动。模型目录搜索列保持只读，
全局模式在“设置 → 全局设置 → 行为与偏好”中管理。选择“跟随全局”或 `disabled`、`cached`、`indexed`、`live` 后，
先查看预览，再明确确认保存；保存后回读配置，并提示 `restart-app-server`，WebUI 不直接执行重启。
运行中的 Gateway 可按现有活动与租约条件安全应用受管账户变更；自定义实例须按提示重启 App Server。
OpenAI 官方账户和使用主配置的固定提供商读取 `config.toml` 的全局 `web_search`，在全局设置中修改，
不在提供商卡片中提供另一份覆盖。

OLC 的托管网页搜索适配仅支持 `live`，使用请求所选账户的 Ollama 搜索额度，可能收费。OLC 未设置时默认关闭：切换账户的 Profile 缺项不继承全局，CLI／WebUI 显示“默认关闭”，选择它会移除显式覆盖；固定模式保留主配置的显式值，主配置缺项时也关闭。已保存的合法模式不被默认值覆盖，需搜索时显式选择 `live`。`cached`、`indexed` 不会自动降级为实时，请求中的不支持控制在模型出站前拒绝。`disabled` 不声明搜索工具。两种模式均与同族共享模型目录的客户端 `tool_search` 能力无关。独立 Relay 按其 API 请求中的工具声明处理，不读取 App Server 的搜索偏好。配置保存不执行搜索，也不证明账户搜索权限或真实云端往返已验收。

搜索值直接保存在对应提供商 config 的顶层，例如 `$CODEX_HOME/sf-clp-main.config.toml`：

```toml
web_search = "disabled"
```

文件由已登记的精确 Provider ID 解析，不接受用户输入任意路径。`web_search` 只允许上述四种模式；
OLC 缺项默认关闭，其他切换提供商缺项跟随主配置；保存“默认关闭”（OLC）或“跟随全局”（其他提供商）会移除该字段，保留其他配置。文件或模式无效时明确拒绝。
不再读取、写入或兼容 `codexc-provider-search.toml`，也不自动删除或迁移旧文件；升级后须重新设置
此前仅保存在旧文件中的搜索值。现有提供商 config 中的合法值直接作为该提供商的设置。

保存前预览并复核相关文件修订，配置并发变化时拒绝提交。写入对应提供商 config 时，
使用私有事务记录 `<提供商配置文件>.search-pending` 及本事务独立的
`<原文件>.search-backup-<transactionId>` 备份，不覆盖历史备份。成功回读全部写入并完成修订复核后
才清除 pending；普通写入失败尝试回滚，无法确认结果时保留材料并拒绝后续读取和保存。
本功能不改写主配置的全局 `web_search`，也不在读取时改写用户文件。同一切换提供商编辑连接、模型或重新配置账户时保留 Profile 的搜索值；切换到固定模式后使用主配置的全局值。

未完成的搜索设置事务没有自动恢复入口，须按以下顺序人工核对：

1. 停止相关配置编辑，保留 pending 及本事务全部备份；不要删除标记后直接重试保存。
2. 按 pending 的 `files` 逐项核对 `path`、`existed`、`expectedSha256` 和可选 `backup`。
   当前文件必须仍是本事务输出（SHA-256 等于 `expectedSha256`），或已恢复为该项备份的内容；
   原本不存在且已回滚的文件应保持不存在。内容不符可能表示后续编辑，须停止覆盖和清理并保留现场。
3. 对 `existed=true` 的文件，从该项 `backup` 成套恢复原内容，保留原有私有权限；
   对 `existed=false` 的文件，仅在校验其确为本事务输出后移除，不删除其他文件。
4. 核对所有项的原内容或原不存在状态均已完整恢复后，才删除本次 pending，保留备份。
   重新启动配置读取并确认结果，再恢复编辑；运行中的实例不会因文件恢复自动重启。

回退程序前保留关联 config、pending 及备份的成套副本，未完成事务须先按上述流程处理；
不能用不匹配的事务材料恢复。旧版本可能优先读取旧独立文件，回退前须核对该版本实际读取的搜索值，
不能据新版本界面推断回退后的状态。

原生 TUI 通过 `--profile` 加载提供商 config。锁定 Codex 的 `app-server` 不支持这个入口，项目仍从
同一 config 的已校验字段生成必要的启动参数，包括显式的 `web_search`；不再从另一份搜索文件追加覆盖。
CLP 等 Chat 上游仍须通过 `codexc remote -p <提供商>` 连接受管转换桥，直接原生 Profile 不会启动转换桥。
搜索设置由新启动的 App Server 消费，适用于其新建和冷恢复的 Thread；已运行实例或已加载会话不会
即时更新。保存后应在现有任务结束后正常重启 App Server；Gateway 的旧代码也须重启才能加载新行为。
原生 `codexc remote` 显式传入的 `--search` 或 `-c web_search=...` 继续优先。
搜索模式只是请求策略，不证明上游模型会执行搜索；诊断结果也不会自动修改该设置。

## 7. 自定义提供商

`codexc setup → 模型与提供商 → 第三方提供商 → 自定义提供商 → 添加提供商 → 自定义模型目录` 与
`codexc provider add --custom-models` 提供相同的新增入口；编辑、列表、切换、删除复用
`provider` 管理链路。WebUI 的 Provider 设置中选择“自定义提供商”。
此类型使用 `cp-` 开头的 Provider ID（其后 1-61 位 ASCII 字母、数字、`-` 或 `_`）。CLI 添加时选择自定义标识符、或在 WebUI 添加此类型时，`cp-` 前缀固定，只填写后面的名称；例如输入 `llm`，保存为 `cp-llm`。编辑已有提供商时 ID 不变。
例如 `cp-llm`，终端使用 `codexc remote -p cp-llm` 或 `codexc app -p cp-llm`，规范 Profile 与文件分别为 `sf-cp-llm` 和 `sf-cp-llm.config.toml`。`cp-` 表示自定义提供商，与上游协议无关；协议独立选择 Responses 或 Chat Completions。
所有 Provider 的固定、切换模式以及独立 Relay 共用统一请求策略。完整协议事件空闲为 300 秒，WebSocket 建连为 15 秒，对齐锁定 Codex 0.164.0 的有效默认值；生成没有固定总期限。HTTP 首响应头额外保留 300 秒网络等待，错误正文最多 5 秒，非流式正文最多 300 秒；下游交付受阻最多 30 秒，终态和关闭收尾最多 5 秒。聚合与 Chat 桥外层不重复启动内层模型计时器。

代理本地期限使用同一套错误分类：上传 408 `upload_timeout`、准备 504 `preparation_timeout`、上游等待 504 `upstream_timeout`、交付与收尾 504 `delivery_timeout`。可发送结构化错误时，用 `timeout_stage` 区分 `upload/prepare/headers/body/stream/delivery/terminal`；响应头已经发送时不改写 HTTP 状态。上游已返回的错误及安全 `Retry-After` 不因诊断正文读取失败而被替换。Chat 桥和 Relay 的直接适配器显式请求 `Accept-Encoding: identity`，成功响应只接受缺省或 `identity` 编码，并精确校验 JSON/SSE 媒体类型；透明 Responses 代理仍保留上游传输合同。

第三方 App Server 启动时显式注入统一的 `stream_idle_timeout_ms=300000`、`websocket_connect_timeout_ms=15000`，已有显式冲突值会被拒绝，用户文件不自动改写。启动后通过 `config/read` 复核合并后的 Provider 配置，受管层覆盖导致的不一致不会被当成已就绪。Provider 启动、租约、设置应用及 Desktop 附加等可能启动实例的监管操作统一等待最多 60 秒，包含实例就绪、配置核验及连接收尾；这是控制面等待，不是模型请求总期限。当前锁定版内置 OpenAI 不接受同名 Provider 块替换，使用内置默认，不提供一个实际上无法覆盖官方行为的全局可调超时选项。

Chat 桥以完整 Chat 数据事件计空闲，Codex 仍以实际收到的完整 Responses 事件计空闲；注释心跳、零碎字节以及桥内尚未通过完整校验的工具参数不会伪造客户端进展。上传、目录复核、排队和服务停止继续使用各自的资源预算。更新程序后分别重启 App Server 和 Relay 生效；Gateway 重启不会替代这两个独立服务的策略激活。
模型目录缺失时明确报错，不回退到官方目录。显示名称禁止使用上游具有特殊语义的 `OpenAI`，
避免启用官方专用协议能力。已有 Codex 兼容 Provider 不自动转换或迁移。

填写平台的 Responses 基础地址（例如 `https://www.zzshu.cc/v1`）、API Key 和一个或多个模型。
自定义第三方 Provider 支持两种上游接口，在填写基础地址后选择：`Responses` 直连上游，或 `Chat Completions` 由网关的 Chat 桥转换（`function`、`namespace`、自由格式 `custom`、客户端 `tool_search` 与 `agent_message` 均由桥处理）。选 Chat Completions 时 WebSocket 强制关闭，客户端检索由用户逐项手动声明或选择探测后回填，不提供 Responses 私有能力（加密推理回放、远程压缩、Fast 档位），模型转发（Relay）对该 Provider 只宣告原生 Chat 并按 Chat 转发，不宣告 Responses；自动审批等带结构化输出的请求同时声明工具时，桥把要求的 JSON schema 追加到系统消息并省略 `response_format`，以适配不接受两者并存的 Chat 上游（托管 CLP 上游已验证接受，保持 `response_format`）。该降级只由提示词保证，桥不校验最终文本是否为 JSON，降级事实记为请求诊断 `conversion.structuredOutput=prompt`；模型仍由统计代理按 Provider 目录拒绝目录外或已停用模型。选择结果写在 `~/.codex-connect/providers/<Provider ID>/provider.json`（0600，缺失按 `responses`），修改后运行 `codexc restart all`。
CLI 和 WebUI 使用共用的独立模型草稿：新建提供商先填写准确模型 ID 和能力，使用通用编程提示词；已配置提供商从统一“添加模型”入口选择独立填写或继承同一目录中的模型。独立填写必须明确上下文、思考等级和默认值、图片及工具能力，保存不调用模型，也不证明平台支持。新建连接时的可选工具探测仍须单独触发。
模板更新的官方来源读取仓库 `runtime/model-catalog-base.json` 的单一固定快照，DS 来源读取 `runtime/model-catalog-deepseek.json`；不读取当前 CLI 内置名单、账户模型目录或 Cline 官方模型文件。基础辅助提示词仍从固定快照补齐，不因新增模型而声明 OpenAI 身份或能力。
独立草稿使用通用编程提示词及 `send_user_message_async`／`clock` 本地工具声明，不自动关联模板或带入 DS 专属窗口、压缩和采样参数。显式 `instructions` 优先于 `modelMessages.instructions_template`，两者均未提供时才采用通用指令，首次配置和统一新增使用相同规则。上下文必须填写；最大窗口未单独声明时采用当前窗口。继承复制来源当前保存的提示词、能力、窗口、压缩／截断和其他模型参数，移除模板关联；来源后续变化不联动。模型 ID 在当前提供商内必须唯一，已有 ID 的新增会明确拒绝。
保存的模型与模板来源后续变化独立；既有 `template.source/model` 和历史 `template.followContext` 保留读取语义，不隐式改写或产生跟随行为。更新提示词、能力或运行设置须明确选择来源和范围；已有平台 ID 不能在编辑中改名，改名需先添加再本地移除旧 ID。

自定义 v5 定义中，省略 `reasoningEfforts` 或 `supportsImages` 表示未知，空思考数组或图片 `false` 表示明确不支持；思考未知或不支持时默认等级为 `null`。`applyPatchToolType` 缺省为未知、`null` 为不支持、`freeform` 为支持；`supportsSearchTool` 缺省为未知，显式 `false` 会保留。`experimentalSupportedTools` 为可选的工具名数组，名称须非空、无首尾空白或控制字符且不重复；保存并编译时保留已有其他工具名，缺省编译为原有的空数组。目录显示声明状态，Codex 执行字段则把未知保守投影为空思考数组、纯文本输入和不启用对应工具。已有目录不迁移或自动重写；预览与确认沿用修订检查、私有备份及事务失败恢复，读取和编译不重新套用模板。旧程序不能读取含新增定义字段的目录，回退前须先恢复新增字段保存前的备份；不能删除 pending 绕过恢复检查。

每个模型声明准确 ID、显示名称、上下文窗口、图片输入能力、支持的思考等级与默认等级。
自定义模型逐项选择能力；新模型默认不声明自由格式 `apply_patch` 或客户端 `tool_search`，已有模型保留当前值供用户确认。
客户端 `tool_search` 在 Responses 上游默认不声明：声明后 Codex 会把 `tool_search_call` / `tool_search_output` 输入项回传上游，上游不接受时触发检索的回合会失败。
CLI 和 WebUI 仅在用户明确选择某项检测时发起请求，检测范围与交互见下文。Chat Completions 不因协议选择而默认声明检索能力。
缺少 `tool_search` 时客户端会把全部工具定义内联进每次请求；最终预览逐模型显示声明，默认模型必须属于目录。
上下文窗口接受 1024–100000000 Token；CLI 与 WebUI 统一提供 128K、256K、384K、512K、1M 五档预设（K = 1024，M = 1048576），并均可自定义输入。预设不代表上游一定支持该窗口，须按平台说明选择。思考等级仅接受锁定 Codex 支持的
`none/minimal/low/medium/high/xhigh/max`；不声明支持思考参数时不保存可选等级，启动请求显式使用 `none`，
避免继承官方主配置的思考等级。不请求第三方 `/models`，不从模型名称推断能力。

#### 对比并更新账户模型模板

从 `setup → 模型与提供商 → 第三方提供商 → 模型管理` 进入，先选择提供商，再选择「对比并更新模型模板」、模型、模板来源和更新范围。DS、CLP、CCG、OCG、已注册的 OLC 受管账户和自定义模型使用同一更新流程；WebUI 模型管理也提供模板更新入口。使用官方共享目录的第三方不提供此操作。

自定义模板更新只保存模型目录，保留目录默认模型、Profile／主配置的独立默认选择，以及固定模式的独立思考等级，不重新保存连接配置。普通模型编辑中的显式默认模型修改仍走原有模型保存流程。模板保存失败或回读不确定时保留目录 pending／backup，核对后使用现有目录恢复入口，不自动重试。

自定义模型沿用 `template.source/model`；受管提供商在共用 manifest 的 `modelTemplates` 中保存逐模型关联，DS 新建时按实际生成来源记录精确 ID。旧目录缺少关联时须明确选择，不能按同名模型自动推断。DS 只接受对应精确 ID 的 DS 模板；CCG／OCG 可明确关联 DS 模板，V4.1 的预置生成来源为 Flash。CLP 关联 Cline 精确 ID 的项目投影模板：Flash 仍复用仓库 DS Flash，其余模型使用 Cline 能力及项目基础提示词，关联不表示所有字段都来自 Cline。

- **提示词**：默认选中。源模板先补齐缺失的基础提示词，再替换目标模型的指令及提示词对象，会覆盖本地自定义提示词。
- **运行设置**：须另行勾选，自定义与受管模型均可选择。更新有效上下文比例、自动压缩阈值和截断策略；源中缺失的设置也作为删除差异展示，确认后恢复项目或上游默认。压缩阈值须适配目标模型当前窗口，冲突拒绝保存。
- **能力参数（除 OLC 外的受管提供商）／本地工具（自定义提供商）**：须另行勾选，接口范围均为 `capabilities`。受管模型更新描述、最大上下文、支持的思考等级及说明、输入类型、原图细节、详细程度与摘要声明及其默认值；两类模型均从来源的工具声明仅合并 `send_user_message_async`、`clock` 两项，纳入差异预览和保存，其他本地工具声明保留。自定义模型仅更新这两项本地工具，不复制来源的其他能力。OLC 不开放此范围。

自定义提供商允许更新提示词、来源关联、运行设置及本地工具；当前／最大上下文、思考等级及默认等级、图片、文件编辑、工具搜索、摘要、采样等参数保留手动值，历史原生网页搜索元数据原样保留但不参与搜索策略。已被旧版本同步过的值不能凭模型名或当前模板推断原值，须在模型编辑中明确更正，不自动回滚。

OLC 可在保存模型后选择 `official` 固定底座或受管 DS 模板；所有来源仅允许提示词及运行设置，不覆盖窗口、思考、图片、freeform、客户端工具搜索或其他能力。提示词关联不能作为 Ollama 模型能力证据。共用 manifest 顶层来源保持 `ollama-cloud`，逐模型模板关联及更新记录接受 `official` 或受管 DS 模板；旧目录和旧关联保留读取，无关联时必须显式选择，不自动推断、迁移或补写。移除裁剪目标模型的关联和更新记录，保留其他来源元数据。

始终保留账户模型 ID、显示名称、当前上下文、默认思考等级、其他工具能力和采样。上述两项本地工具声明仅在勾选能力参数或本地工具后合并；仅选择提示词或运行设置不更新工具声明，未选范围保持原值。有效上下文比例、自动压缩阈值及截断策略仅在勾选运行设置后更新，否则保持原值。新能力不支持当前窗口或默认思考等级时拒绝写入，先通过已有编辑入口调整；不会静默缩小窗口或更换等级。

预览逐字段显示前后值，区分字段缺失与 JSON `null`；首次建立关联也作为差异显示。来源清单无效或账户目录存在重复模型 ID 时，在预览阶段拒绝更新。无差异时不写文件、不更新备份，也不要求重启。确认时锁内复核账户修订，并使用本次已读取的源模板快照；不重新下载另一份内容。目录、关联或更新范围变化都需要重新预览。CP 更新复用自定义目录事务；受管更新复用提供商共用目录／来源清单事务，同时备份目录和 manifest，并在 `templateUpdates` 中按模型记录最近一次应用的源摘要和选定范围，不把该记录视为其他未更新字段的来源版本。均不自动重启服务。

自定义模型模板更新的官方来源仅提供仓库固定底座，DS 来源来自仓库 `runtime/model-catalog-deepseek.json`。新建独立模型和继承模型不自动建立模板关联；旧模型的显式关联继续保留读取，更新时须选择可用来源，不按模型名称猜测来源。

CLP 的固定 DS 添加入口、CCG／OCG 的 DS 导入入口只追加明确选择的新模型，已有条目保持原值；其他模型统一按 ID 独立填写或继承。来源变化不自动移除已保存模型。更新已有模型使用对比模板流程，移除仍走独立预览。

上述新增流程在 CLI 与 WebUI 共用后端候选及计划：锁外读取来源，选择新模型，预览完整字段、来源和影响账户，明确确认后才在锁内复核修订并保存。候选最多 128 项、单份 4 MiB、有效十分钟；进程内最多 16 份及合计 16 MiB，读取来源整体限时 90 秒。执行不重新下载，过期、重复 ID、旧模型 ID 或并发修改均拒绝；保存后最多 64 个模型，无新增不写目录和备份。CCG／OCG 可手填准确模型 ID、窗口、思考等级及图片／补丁／工具搜索声明；手填模型不猜测模板关联。CLP 保留旧逐模型来源及 Cline 元数据，新增 Flash 时遵守 DS 复合目录来源约束。保存复用现有受管目录恢复记录，恢复仍从 CLI 明确选择，不自动重启。

取消 DS 候选读取会中止请求、正文读取和重试等待，不按普通网络错误继续重试。CLI 在选择、预览和最终确认后复核取消信号；进入保存前取消不写目录，开始持久事务后由既有事务完成保存或恢复。

#### 扩展能力与高级设置

上游 Provider 级 `capabilities.external_web_access` 与 `capabilities.remote_compaction` 当前没有
CLI／WebUI 设置入口；它们不同于用户的 `web_search` 偏好，也不同于逐模型的图片、文件编辑或工具检索声明。
固定主 Provider 配置保留上游解析这些字段的路径，但实际效果仍受上游和后端能力约束，尚未在线验收。
受管自定义切换 Profile 不接受上述 Provider 级 `capabilities`，手工加入会因不受支持的 Provider 字段而拒绝加载；这与模板更新的同名范围无关。
省略时遵守上游默认，不能把固定主配置的可解析性推广到切换 Profile。

已有自定义模型的 CLI 模型管理保留“探测单个模型的工具能力”入口：先选择精确模型，再分别决定是否探测 `apply_patch`、`tool_search`，只有明确选择才发起可能计费的请求。采用结果后仍须预览并确认保存，探测期间连接或目录变化会拒绝继续保存；原生网页搜索仍仅作诊断。

内置网页搜索使用 Codex 的 `web_search` 模式，不提供模型级搜索支持声明。模型目录中的 `supports_search_tool` 仍表示客户端工具检索，`web_search_tool_type` 仍只选择 hosted 工具形态。

App Server 的固定、切换入口按对应配置生成顶层 `web_search`、`tool_choice` 和 Responses 历史 `web_search_call`，由具体 Provider 的原生或托管适配路径消费。源目录不变，临时运行投影使用普通 Responses 工具编码（`use_responses_lite=false`），实例关闭 `features.standalone_web_search`，防止切换到独立 `/alpha/search` 执行器。App Server 从对应配置生成受控启动参数并隔离子进程凭据；`codexc remote` 通过原生 Profile 选择连接同一实例。聚合入口当前关闭。

普通原生 HTTP 与 Responses WebSocket 保持工具透传，官方 OpenAI 保留自己的合同。受管 CLP Chat 桥将 live `web_search` 适配至同账户独立搜索接口，映射搜索事件并处理 search 查询历史，详见 [CLP 网页搜索适配](cline-pass.md#网页搜索适配)。OLC 的 Provider Proxy 与独立 Relay 在 Responses HTTP 中执行同账户 Ollama live 搜索并续答，保持一个外部响应，WebSocket 关闭；搜索历史只保留可读查询，不补造上次结果。其他 Chat 对 hosted 声明仍仅透传，不承诺执行或历史转换。

已保存的 CP v5 `supportsWebSearch` 作为历史布尔元数据保留，并按原字段顺序编译为 `supports_web_search`，既有定义与编译快照仍可一致性校验和读取。普通读取不迁移、删字段或改写目录，编辑后保存仍保留该元数据；它不参与搜索门控，也不再从新模板导入。非法类型、未知字段、定义与编译快照不一致及未完成事务仍明确拒绝，不能删除 pending 绕过检查。受管或官方完整目录同样保留原文件内容，搜索策略不解释该扩展字段。

CLI 的思考等级使用多选菜单，提供 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，空格勾选、回车确认；声明支持思考参数时至少选择一项，再从已选等级中选择默认值。编辑已有模型时预选原有等级。
CLI 与 WebUI 可逐模型填写描述、各思考等级说明、最大上下文窗口，并声明图片 `original` 精度、输出详细程度参数及思考摘要参数。
图片原始精度要求同时声明图片输入；详细程度支持开启时必须选择默认 `low/medium/high`。
摘要支持独立于思考等级，开启后可选择默认 `auto/concise/detailed/none`；它不表示上游一定返回思考正文或思考 Token 数。
Responses 和 Chat 上游均由用户逐项选择全部能力，不按上游协议禁止开启或拦截保存，切换协议保留已选值。
当前 Chat 桥仅接受图片 `auto/low/high`，不传递 verbosity，并拒绝非 `none` 的摘要参数；能力声明本身不改变请求转换规则，开启后实际请求仍受这些转换限制约束。

CLI 编辑已有模型时先选择模型，再选择需要修改的设置组；未选模型和设置保留原值。新模型仍填写名称、当前上下文及基本能力，高级设置按组选择，可直接编辑采样而不经过提示词等其他设置。关闭图片输入时仍清除 original 声明，移除的思考等级仍清除对应说明。
高级设置包含图片 `detail=original`、`text.verbosity`、`reasoning.summary`、思考等级说明、完整指令模板、有效上下文比例（1–100%）、自动压缩阈值以及工具输出截断方式（Token 或字节）和上限。
自定义模型新增时带入项目固定采样模板：`temperature=1`、`top_p=0.95`、`top_k=20`、`min_p=0`、`presence_penalty=0`、`repetition_penalty=1`。这组值独立于 OpenAI／DS 提示词模板，不随来源目录更新；它是可编辑起点，不代表上游支持所有参数。CLI 和 WebUI 的高级设置均支持编辑当前值、恢复固定采样模板或全部清空。已有模型不自动补值；未编辑采样时保留原值，每项清空后省略该字段，全部清空时不保存 `sampling` 对象。
采样值须为有限数字：`temperature` 为 0–2，`top_p` 和 `min_p` 为 0–1，`top_k` 为非负安全整数，`presence_penalty` 为 -2–2，`repetition_penalty` 须大于 0。逐模型保存于定义的可选 `sampling` 对象，字段名保持上述下划线形式；不写入供 Codex 使用的生成模型字段。
Provider Proxy 的 Responses HTTP/WebSocket、Chat 转换和独立 Relay 从当前已校验目录按精确模型补齐默认采样值；请求已带的同名字段优先，包括零值和显式 null，未配置字段不发送。已有模型的模板更新保留采样值，采样组单独编辑；新增导入拒绝已有 ID。CLI 和 WebUI 编辑其他字段时保留已保存的采样值。
自动压缩阈值须为正整数且不超过当前上下文的 90%；留空使用 Codex 推导值。缩小当前模型窗口时，若阈值不再有效，须先调整阈值，保存不会静默截小该值。此窗口冲突规则同样适用于 DS、CCG、OCG、CLP 的 CLI／WebUI 预览与底层窗口写入。自定义模型可在高级设置修改阈值；受管模型当前可明确选择模板的运行设置并预览更新，尚无通用的阈值手工编辑器，也可保留原阈值并选择更大的窗口。
CLI 编辑模型时若缩小上下文导致已有阈值失效，会立即要求调整或清空该阈值；跳过其余高级设置不会跳过这项修正，取消则不保存本轮草稿。
CLI 先选择当前上下文窗口（预设或自定义输入），再填写最大窗口。最大窗口不得小于刚选定的当前窗口，留空表示与当前窗口相同。未填写的有效比例保持 95%，工具输出截断保持现有 Token 策略，上限为 `min(10000, floor(contextWindow/4))`。
新增声明均由用户手动确认，不增加自动探测。Shell 继续使用 `unified_exec`；锁定 Codex 将 DS 的旧名称 `shell_command` 读取为同一类型，不提供重复选择。

目录继续使用 v5，新字段（含 `sampling`）均为可选；旧定义缺少新字段时保持原来的生成结果，不自动改写磁盘文件。
普通自定义固定／切换实例仍遵循 Codex 原生配置归并：显式的根级或项目级上下文、自动压缩、工具输出上限及基础指令可能覆盖模型目录。目录保存成功不表示这些覆盖已解除；自定义提供商保存不会自动删除全局偏好。核对实际生效值时须同时检查这些覆盖，聚合实例另有拒绝根级窗口冲突的规则。
保存仍使用现有私有备份、并发版本检查和失败恢复事务。若要回退到不认识新增字段的旧程序，须恢复启用新增字段前的完整提供商配置与模型目录备份；连续保存可能更新 `.backup`，回退所需备份应另行保留。
启用默认采样前，另行保留并核对提供商配置、Profile、私有凭据及原模型目录完整备份。保存前先严格校验数值，既有目录备份为 `models.json.backup`，未完成事务由 `models.json.pending` 保护；失败时沿用下面的目录恢复流程，不丢弃未确认状态。旧程序会拒绝含 `sampling` 的定义，不会忽略它；降级须先停止服务并恢复启用前的完整备份，再用旧程序读取，不能只切换程序版本或删除目录绕过校验。
自定义模型的新建模板提供提示词、来源、两项受控本地工具及已声明的有效上下文比例、自动压缩阈值和截断策略，其他参考能力单独展示，不作为平台声明；上下文及其他能力须手动设置。DS 模板参考沿用项目对 verbosity 与摘要声明的修正。加速档位、官方专用模式、压缩兼容标识及废弃字段不复制；提示词中的配套设置沿用已审核的固定底座。`tool_mode`、`node_repl_auto_review_required`、`web_search_tool_type` 不自动继承，分别涉及工具执行架构、Guardian 审核策略及托管网页搜索格式，均不是这两项本地工具的开放前提。

### 添加时探测并写入

CLI 按模型逐项交互：填写名称和上下文，选择是否支持思考参数及其等级、默认等级，选择是否支持图片。
CLI 先完成模型参数、默认模型、API Key 和 WebSocket 设置，再进行可选的工具与网页搜索探测，最后预览并确认保存；探测后不再询问连接设置。分别选择 `apply_patch`、`tool_search` 的“手动声明支持”“不声明支持”或“探测本项”。自定义提供商的 WebSocket 仅手动选择，不自动检测；Chat 上游不支持 WebSocket。
WebUI 提供相应手动字段，以及独立的文件编辑、工具搜索和原生网页搜索检测按钮，不提供整套能力自动探测。

`apply_patch` 最多两次请求，验证补丁调用及模拟结果回传；`tool_search` 最多三次请求，验证检索、调用发现的工具及模拟结果回传。
每一步非流式成功响应都须返回与请求完全相同的模型 ID；缺失、无效或不同的模型 ID 均为“无法确认”，不能采用到当前模型。大小写、首尾空格及版本后缀不按别名处理；该校验只能确认响应声明的归属，不能证明供应商实际使用的底层模型。
每次操作只检测所选项，使用当前填写的默认思考等级（未声明时为 `none`），不测试该等级是否有效。
Responses 使用对应工具协议，Chat 使用当前网关桥的请求转换语义，不将转换能力宣称为 Chat 原生协议支持。
检索发现的工具仅由 `tool_search_output` 提供，Responses 不在后续请求的顶层 `tools` 额外补入该函数；Chat 由共享转换层从检索结果生成函数声明。
单请求最长 15 秒、每项总预算最长 45 秒，可能计费，不自动重试，不执行返回的工具，不读取仓库或会话内容。
网络、认证、限流、超时和无法识别的响应为“无法确认”，不能据此回填；可重新探测、手动选择或取消。
明确结果也需用户选择采用，只修改对应工具能力，不覆盖图片、思考、上下文或另一工具。没有基础文本或思考检测通过的保存门槛。
CLI 单模型工具能力入口保留目录默认模型、Profile／主配置默认选择及固定模式的独立思考等级；连接配置不重新保存。整份模型编辑中的默认模型选择仍由用户明确确认。

CLI 另提供默认跳过的原生网页搜索诊断，WebUI 通过“检测网页搜索”显式发起。它使用一次最长 45 秒的流式请求，声明 `web_search` 与 `external_web_access: true`；上游可能实际搜索并产生模型及搜索费用。只有完整 Responses 响应中的已完成 `web_search_call` 搜索才算取得执行证据；HTTP 200、文字自称搜索或回答带链接都不算。完成但没有搜索证据时显示“无法确认”；明确拒绝仅针对本次原生工具声明，不推断其他搜索接口。Chat 请求经过现有桥转换，普通 Chat 文本不算原生搜索证据。
原生网页搜索结果仅诊断，不回填工具能力或改写搜索配置。它不经过 CLP 或 OLC 的托管搜索执行链，结果不能作为这些适配路径的验收。它与发现外部工具的 `tool_search` 是不同路径，不生成用于保存回填的关联标识。

已保存模型也可从 WebUI 模型目录行操作中的“检测网页搜索”进入，覆盖官方 OpenAI、DS／CLP／CCG／OCG、Codex 兼容及自定义提供商。CLI 在 `codexc setup → 模型与提供商 → 检测原生网页搜索` 提供统一入口，官方子菜单与第三方模型管理也可进入。同一目录有多个账户时须明确选择一个账户，不广播检测。后端按目录修订读取所选账户的实际协议、凭据及模型映射；CLP 复用专用路由和思考转换。未配置、凭据不可用或目录已变化时明确拒绝，不启动服务或刷新登录。
官方独立诊断支持文件存储的 API Key 和 ChatGPT 登录；系统钥匙串、临时认证、OpenAI Provider 覆写及无法安全执行的登录约束会明确拒绝，不回退使用旧凭据。模型缓存仅提供待检测 ID，不能证明其所属上游或实际可用性，因此官方诊断不继承缓存中的思考默认值。其他已配置模型使用对应目录的默认值；诊断不验证思考控制本身。请求发出后若配置或凭据改变，旧结果被拒绝，但已经发出的请求可能计费。

最终预览确认后通过现有 Provider 事务写入 `models.json` 和连接配置，沿用目录版本 5、私有备份和并发版本检查。
探测结果绑定模型、地址、协议、实际 Key 及默认思考等级；改变这些条件或管理进程重启后，旧结果不能用于保存。
WebUI 保存回填结果时显式使用探测协议；保留 Key 仅用于原 Origin，进程内关联标识不含明文 Key，也不写入目录或连接配置。
这些短请求不构成文本、图片、思考控制、SSE、WebSocket、上下文容量、并发或稳定性验收。

选择 Responses 时，上游必须兼容锁定版 Codex 的 Responses 流式事件、函数调用、工具结果接续及其请求字段；
“提供 Responses 地址”不代表所有模型均兼容。此入口只按所选上游接口使用直连 Responses 或网关 Chat 桥转换，
不为具体平台添加专用协议补丁。
这些实例按 Provider 搜索配置提交原生网页搜索工具，由上游判断执行支持；历史模型搜索元数据不参与门控。模板中的能力元数据不代替上游接口兼容性验证，也不自动启用 WS 或改变审批策略。CLI 与 WebUI 新增手填模型共用通用编程指令，基础辅助提示词从固定底座补齐；抽取的原始快照保持不变，官方底座和 DS 来源的模板投影均将已知格式的来源模型身份声明改为通用编程助手，不绑定具体模型名称，自动审批模式与拒绝后的提示会追加中文回复要求，其他提示词结构保留。官方底座身份声明格式改变时明确拒绝，需先审核投影。用户明确填写的指令保留原文；DS 专用指令除来源身份与上述审批语言要求外保留。已有模型仍须预览并确认模板更新才会改变提示词。手填模型不复制底座的上下文或能力声明；工具和请求参数继续采用项目的保守配置。当前目录合同没有可独立设置的最大输出 Token 字段。

固定模式把 Provider、默认模型、思考等级及目录引用写入主配置；切换模式保持官方主配置，写入独立的
`sf-cp-<标识符>` Profile，并由现有监管服务启动。渠道 `/model` 从各自真实 App Server
获取目录，跨 Provider 选择仍在新 Thread 生效；已有 Thread 不迁移。切回官方后保留候选和自定义目录，
再次启用候选时使用目录记录的默认模型；删除 Provider 成功且凭据备份清理成功后才清理模型目录和私有恢复快照。
清理中断留下孤立目录时，可再次执行 `codexc provider remove <Provider ID>` 按原 ID 清理残留。
切换和删除的确认绑定主配置、注册表、目标 Profile、凭据和自定义目录材料的修订；即使只有 Key 或目录内容变化、展示字段没有变化，也必须重新预览。损坏或不支持的目录仍可通过明确删除入口移除。

自定义提供商完整保存和仅模型保存均在写入后重新读取实际配置、凭据及目录；确认一致才结束目录事务。回读失败保留 pending 和备份，不报告保存成功，也不自动覆盖无法确认的新状态。固定模式目录恢复还要求当前凭据可安全读取且 Provider 与 Origin 匹配，失败保留恢复标记和调用前目录。

### Provider 的 WS 设置与检测

CLI Setup 的 Codex 兼容 Provider，新增与编辑均可在地址、模型及 Key 填写后选择“自动检测”“关闭，使用 HTTP/SSE”或“手动启用”。CP 自定义提供商仅手动选择 WS 开关，Chat 上游强制关闭；WebUI 保持手动开关。以下检测流程仅适用于 Codex 兼容 Provider。
自动检测使用当前 Key、选定模型及共享代理，按锁定 Codex 协议向 `/responses` 建立 WS，并发送 `response.create`、`generate=false` 预热；不读取仓库或现有会话内容，不在检测时保存配置，不保证第三方平台免计费。
握手和预热成功仅表示连接与预热可用。可另行确认发送一次极短文字请求（可能产生费用），只有收到有效模型文字输出及完成事件才显示请求验证成功；不代表工具、多轮或所有模型已兼容。WS 检测不回退 HTTP，因此成功不会来自 HTTP/SSE。
认证失败、限流、超时、路径错误或无法识别的响应均显示无法确认，不把它们当作平台必然不支持 WS；错误仅展示安全分类和 HTTP 状态码。检测最长 15 秒，可按 Ctrl+C 取消整个 Setup；重试需主动选择，不自动重发模型请求。未验证成功默认建议关闭，也可手动启用；最终预览确认后才写入开关。

### 存储、备份与恢复

受管目录的 `settings-pending` 同时参与聚合材料指纹与出站复核；即使目录正文尚未变化，也不能继续认可旧快照。普通受管实例读取设置指纹时也拒绝该未完成事务，避免误报“无需应用”。恢复完成后重新读取材料，不通过忽略 pending 绕过保护。

CCG／OCG 手动新增接口不接受 `sampling`：当前受管目录不保存自定义采样默认值，也没有相应运行时消费链；传入会明确拒绝，不静默丢弃。自定义 CP 的采样设置仍使用 `definition.sampling` 及其既有请求链路。

WebUI 模型管理按提供商展示一组模型，受管同族账户共用目录，点击模型名称查看能力和内置提示词。表格的“上下文比例”是目录的有效上下文比例，不是当前窗口占最大窗口的比例；加速与自动审批仅展示目录声明，不表示已经启用。影响的账户范围在分组标题展示；模型 ID、模板关联和采样配置可在详情中查看。提示词按需读取，目录变化时需重新读取；未声明的能力不会按同名 OpenAI 模型补齐。
上下文通过模型表格行内的“编辑”修改，第三方与 CLI、自定义模型新增／编辑共用 128K（131072）、256K（262144）、384K（393216）、512K（524288）、1M（1048576）预设；OpenAI 另用专用的 272000／372000／500000，两组不混用，均保留最大值及自定义表单。第三方最低 1024 Token，且不超过当前目录的上限；保存绑定精确 Provider ID、模型 ID 和目录修订。自定义 v5 同步维护目标定义与生成结果，保留原有提示词、最大窗口及截断策略；已有自动压缩阈值与新窗口冲突时拒绝保存，需先调整模型详情。第三方官方模型目录保持只读，本地移除的账户默认保护、最后一个模型保护及 CLP Relay 独立范围不变。

受管目录的设置、本地模型移除及 CLP 目录更新先保存私有 `models.json.settings-backup` 和 `models.json.settings-pending`，记录本次涉及的目录、Profile 或来源清单与备份的前后值。保存并回读一致后清除 pending；普通异常尝试恢复原值，无法确认则保留记录，阻止目录读取及新请求。停止对应服务并核对文件后，可用 `codexc provider recover <Provider ID> keep` 保留新值，或 `rollback` 恢复原值；文件已被后续修改时拒绝覆盖。备份可能包含 Profile 凭据，应保持私有，不要上传或粘贴。自定义创建、编辑、删除与窗口修改统一使用 `.backup`／版本 2 `.pending`，保存前后内容摘要；首次创建的旧摘要为 null。恢复前核对备份和当前文件，拒绝覆盖后续修改，尚未写完新值时只能 rollback；历史版本 1 pending 保留原样，须使用生成记录的对应原版本恢复。候选目录与当前模型配置冲突时，在覆盖前拒绝恢复，保留调用前目录供重新选择。保存不会自动重启服务。

自定义模型的新建条目补齐基础提示词；已有条目的普通编辑、删除和窗口修改只编译已保存或明确提交的定义，不重新套用基础模板。删除不会改变保留模型的提示词。模板导入仅新增；已有模型使用明确来源、选定范围及差异确认的模板更新入口，模板快照更新不会自动修改提供商目录。

每个自定义 CP Provider 的 `~/.codex-connect/providers/<cp-ID>/models.json` 使用版本 5 格式，
包含 `schemaVersion`、`defaultModel`、`definitions` 及由定义生成的 `models`；生成的每个模型条目声明 `multi_agent_version: v2`，由 Codex 解析为多代理 v2 运行时，不写入主配置的 `features.multi_agent_v2`。模型定义可携带 `template: { source, model }` 来源关联及已固化的 `modelMessages` 提示词对象。旧 `followContext` 仅作为历史元数据，不产生联动；普通编译不主动清理它。`maxContextWindow` 可选，用于记录用户为该上游模型声明的最大窗口，省略时等于当前窗口；不保存旧完整 `snapshot` 字段，输入时明确拒绝。只接受当前版本，未知字段和不支持的版本原样保留并明确拒绝，不推断模型关联；版本 4 目录在本版本失败关闭，既不自动迁移也不写回，读取该目录的 Gateway 启动与管理界面会一起失败（`codexc provider recover` 只处理未完成写入事务，不处理版本升级），移除与切回官方 OpenAI 只依赖注册表与目标 Provider 自身的材料，其他 Provider 目录不可读不阻塞本次操作，因此目录缺失或不支持时仍可 `codexc provider remove` 后按原 ID 重建。Codex 读取其中的
`models`，Gateway 严格核对版本与生成结果；不接受未知字段、重复 ID、任意外部路径或手写的第三方目录。
模型目录保存为两空格缩进的 JSON；账户注册表、账户初始备份与 `models.manifest.json` 同样使用两空格缩进。文件通过现有私有文件工具原子写入，目录 0700、文件 0600，Windows 使用现有私有 ACL 工具。
上游接口选择单独保存在同目录的 `provider.json`（版本 1，仅含 `upstreamWireApi`，取值 `responses` 或
`chat_completions`），沿用同一私有文件工具原子写入，目录 0700、文件 0600，不含 Key。文件缺失按 `responses`
处理以兼容既有目录，Provider ID 不是 `cp-` 前缀时不读写该文件；版本、字段或取值不受支持时失败关闭并拒绝加载，
不回退为 `responses`。选择 Chat Completions 时写入，改回 Responses 时删除；编辑 Provider 时未显式改动上游接口就沿用文件中的已保存值，
元数据不可安全读取时，固定 Provider 候选的列表投影省略该字段，保存要求显式选择而不是静默改成 `responses`；
切换 Provider 则在加载时失败关闭，列表和编辑会拒绝，须先从有效备份恢复元数据，或备份配置后移除并按原 ID 重建。
删除 Provider 在备份清理成功后
连同模型目录一起清理，清理中断可按原 ID 重跑 `codexc provider remove`。该文件与主配置、Profile、注册表一并记入
`~/.codex-connect/private/responses-providers/<Provider ID>.json` 备份（两空格缩进 JSON）；写入是单文件原子替换，失败时保持原值，
随模型目录保存事务失败时按既有规则保留备份与 pending 并拒绝启动，不自动重试，修改后须执行 `codexc restart all`。
WebUI 的 Provider 预览与保存请求上限为 2 MiB，其他管理接口仍为 64 KiB。模型数量上限仍为 64 个。模型目录（定义和生成结果）不得超过 2 MiB，超限在写入前拒绝。自定义模型的当前上下文不得超过其手动声明的最大窗口；最大窗口省略时等于当前窗口，不受来源模板窗口限制。模型文件不含 Key。Key 写入私有 Profile 或独立私有凭据版本，主配置只含引用；连接配置的恢复快照单独位于
`~/.codex-connect/private/responses-providers/<Provider ID>.json`（0600，可能含凭据，勿分享）。

已有 CP 的连接专用保存不改模型目录，也不生成模型 `.backup`／`.pending`。原值确认仍在管理锁内复核预览修订；确实无变化时返回 unchanged、不提示重启，不重写主配置、Profile、注册表、协议元数据、私有恢复快照或凭据版本。管理锁和 WebUI 审计仍正常执行。模式转换、认证表示变化、移除顶层 URL 或消费备份候选等实际副作用不属于无变化。
存在真实修改时，私有 Provider 快照仍备份配置、Profile、注册表和协议元数据。回读无法确认时返回 `save-unconfirmed`，先核对当前配置与快照，必要时人工恢复。以下目录恢复命令仅处理目录事务，不能代替连接配置恢复。

预览时，先用当前锁定 Codex CLI 的 `debug models` 在隔离临时目录校验最终生成目录；校验失败不写入模型目录、Profile 或主配置，不输出原始错误内容。CLI 编辑绑定打开时的配置、Profile、注册表、上游接口及目录快照，期间变化须重新编辑。CLI 与 WebUI 确认保存均在管理锁内重新生成计划，核对预览修订，包含凭据与连接状态；修订使用进程内 HMAC，不暴露可复用的 Key 摘要。切换模式需要可读取的主 `config.toml`，尚未建立时先通过 `codexc config` 保存 Codex 配置。保存前备份受影响配置；上一目录保存在同目录 `models.json.backup`。
`models.json.pending` 标记未完成的保存；已知写入失败且主配置未改变时恢复目录和原 Profile。
无法确认配置写入结果或发生进程中断时保留备份和 pending，拒绝启动，不自动重发写入。
恢复入口的自定义目录 `.pending` 与受管家族 `.settings-pending` 仅接受版本 2：前者必须包含前后摘要，后者必须包含完整的账户守卫快照。遇到旧版材料时原样保留并拒绝处理，不自动补齐快照、迁移或删除；请先备份配置、目录和恢复材料，再使用生成记录的对应原版本完成恢复。历史目录迁移记录属于独立事务，当前版本只保留拒绝保护，其恢复边界见[当前目录布局与旧版本恢复](#当前目录布局与旧版本恢复)，不能用下方模型设置命令处理。代码回退不会转换恢复记录，须使用与记录格式匹配的版本。普通设置保存仍按既有规则轮换上次成功事务的 `.settings-backup`。
当前修改不再创建 DS/CP 窗口联动事务。历史未完成事务的 `~/.codex-connect/private/responses-context-sync.json` 及 `.backup` 保留显式恢复入口，记录可能含 Profile 凭据，不可分享。恢复命令指定该历史事务内任一 CP ID，会整批恢复记录中的关联文件，拒绝覆盖后来修改的内容。
先停止服务、核对或恢复私有快照中的配置，再明确选择目录恢复方向：

```bash
codexc provider recover cp-example rollback
codexc provider recover cp-example keep
```

`rollback` 使用上一目录；首次创建没有上一目录时删除未完成目录。`keep` 保留新目录。
恢复会校验所选目录与当前配置的模型、路径及思考等级，并核对 Profile 与注册表是否一致、运行时能否加载；缺失注册项或 Profile 时须先恢复对应配置，不能仅保留目录。冲突时保留未完成标记并拒绝完成，不覆盖用户后来修改的配置。首次创建前主配置不存在时，可以回滚到无主配置、无模型目录的原始状态；配置损坏或权限错误不能按文件不存在处理。
可在自定义提供商 交互菜单中执行同一恢复流程。完成后运行 `codexc restart all`。

## 关联文档

- [`docs/opencode-go.md`](opencode-go.md)：GO 形态参考实现；
- [`docs/ccg.md`](ccg.md)：DS 基础目录适配、多账户隔离与 Command Code Credits 查询的参考实现；
- [`docs/cline-pass.md`](cline-pass.md)：CLP 账户、Chat 转换与用量；
- [`docs/deepseek.md`](deepseek.md)：官方账户余额查询参考实现，不计算本地价格或费用；
- [`docs/surface-integration-guide.md`](surface-integration-guide.md)：通讯渠道接入；
- [`docs/index.md`](index.md)：协议支持矩阵与实现映射；
- [`docs/codex-cli-upgrade-decisions.md`](codex-cli-upgrade-decisions.md)：Provider 边界决策。
