# DeepSeek 多账户

DeepSeek 账户使用独立 API Key、Profile 和按需启动的 App Server，所有 DS 账户共用一份模型目录。
OCG、CCG 的目录及增量模型保持独立。官方 `deepseek-flash` 已指向 V4.1 Flash，
DS 不另造 `deepseek-v4.1-flash` 模型 ID。

## 配置与移除

在 `codexc setup → 模型与提供商 → 第三方提供商 → DeepSeek 官方` 管理账户，
也可在 WebUI 账户设置中操作，或使用以下命令：

```bash
codexc provider deepseek add work           # 新增账户，交互输入模式和 Key
codexc provider deepseek reconfigure work   # 编辑已有账户，Key 留空保留
codexc provider deepseek list --json        # 列出账户与默认标记，不包含 Key
codexc provider deepseek default work       # 选择默认账户
codexc provider deepseek remove personal    # 确认后删除账户配置
codexc restart all                 # 应用配置变化
```

账户 ID 必须由用户填写，使用 1–32 位小写字母、数字、`-` 或 `_`，不自动创建 `main`。
首个账户标记为默认，后续可手动修改。不同 ID 不能生成相同的凭据环境变量名。
仅支持当前多账户格式。删除固定模式账户时只恢复该 Provider 管理的主配置字段，保留安装前备份与历史统计；Remote TUI 正在使用该实例时须先退出。写入失败会回滚本次文件变更。
新增及重新配置账户均在写入前用当前 Codex CLI 校验完整模型目录，包括复用已有共享目录的情况；无效目录或超过 2 MiB 的目录会拒绝接入，不能只凭默认模型可解析就报告成功。

账户菜单为添加账户、编辑账户、模型管理、设置默认账户、移除本地账户配置和返回。编辑预选当前模式，Key 留空保留；Setup 与 WebUI 保存前预览目标账户、前后模式及凭据操作。无变化不写文件、备份或要求重启；当前默认模型不在目录时先到模型管理修复，不自动选择替代模型。

请求与指标按精确的 `ds-<账户>` 身份归属，只恢复能映射到当前账户的 Thread。

## 文件与运行模式

| 文件 | 用途 |
| --- | --- |
| `~/.codex-connect/providers/deepseek/accounts.json` | 账户 ID 与默认标记，不含凭据 |
| `~/.codex/sf-ds-<账户>.config.toml` | 切换账户的模型、Provider 与私有 Key |
| `~/.codex-connect/providers/deepseek/ds-<账户>/managed.toml` | 账户运行模式 |
| `~/.codex-connect/providers/deepseek/ds-<账户>/backup/config.json` | 本次安装前的基础配置 |
| `~/.codex-connect/providers/deepseek/models.json` | 所有 DS 账户共用的模型目录 |
| `~/.codex-connect/providers/deepseek/models.manifest.json` | 共用目录来源和更新时间 |

切换模式保留 OpenAI 主配置，每个账户使用独立私有 Profile；固定模式在确认后修改 Codex
主配置，同一时刻只能有一个固定主 Provider。切换账户 Key 保存在私有 Profile（Unix `0600`，Windows 私有 ACL），固定账户使用独立私有版本与主配置 `env_key` 引用，仅进入目标
App Server 子进程，不进入账户注册表、命令行或日志。
固定凭据重配、旧配置失败恢复与原生终端边界见[Provider 凭据安全说明](provider-integration-guide.md#4-安全边界)。

删除账户移除其 Profile、运行模式标记和注册信息，保留共享模型目录、来源记录、历史统计和备份；删除最后一个账户也不自动清理共享目录。删除前检查并停止对应 App Server；Remote TUI
正在占用、监管状态异常或停止失败时，不删除账户文件。删除后该账户历史 Thread 将不可恢复。
删除默认账户前需先选择其他默认账户；删除最后一个账户无需选择。
原生子代理继承父线程的 Provider，不独立绑定账户。固定账户删除或改为切换模式时
仅恢复受管 Provider 字段，保留其他主配置修改。删除后重新添加会建立新的恢复基线，旧备份归档保留。
切换账户每次进入固定模式时都会以当时主配置更新该账户的恢复基线，并把旧基线归档；固定模式内
重新配置继续使用本次进入时的基线。同一时刻仍只允许一个固定主 Provider，其他 DS 账户可保持切换模式。

## 仓库模板维护

以下命令用于源码仓库内的模板维护，和账户目录刷新是两个独立操作。请在仓库根目录执行：

```sh
node scripts/update-model-templates.mjs                      # 下载 DS，用已保存底座补全并对比
node scripts/update-model-templates.mjs --write              # 校验后保存 DS 更新
node scripts/update-model-templates.mjs --update-base        # 显式获取 CLI 底座并对比，不下载 DS
node scripts/update-model-templates.mjs --update-base --write # 校验后保存底座和 DS 重新补全结果
```

公共底座是已保存的固定快照，不随 CLI 升级、模型创建、账户模板对比或 DS 维护自动刷新。
默认命令仅从 DS 官方安装脚本提取 JSON，不执行脚本；补全时复用已保存底座，保持底座文件及其来源记录不变。
只有显式指定 `--update-base` 才使用 `codex debug models --bundled`，从项目锁定 CLI 获取
内置目录原始顺序中的第一个模型，不按固定名称匹配；来源记录保存实际模型 ID。用已保存的 DS 原始目录重新补全，保留 DS 原始文件及其下载来源。该操作不联网下载 DS，
也不使用用户的 `models_cache.json`。需要同时维护两种来源时，分别运行这两组命令并审查各自差异。
两组命令都先只对比，只有另加 `--write` 才保存；版本不匹配、源模型缺失，或复用的底座／DS 原始目录
与来源哈希不一致时停止，不替换成其他模型或隐式重新获取另一来源。

仓库保留四份文件：`runtime/model-catalog-base.json`（提取的单模型原始快照）、
`runtime/model-catalog-deepseek-source.json`（DS 原始目录）、
`runtime/model-catalog-deepseek.json`（DS 补全目录）和 `runtime/model-catalog-sources.json`（来源与哈希）。
更新会按模型 ID 和字段列出新增、删除、修改，不打印整段提示词；三份目录全部通过当前锁定 CLI 加载校验后才允许写入。
默认 DS 对比也会联网下载目录，但不会调用模型或产生模型推理费用。`--update-base` 只读取本机锁定 CLI 和仓库快照。

补全只继承缺失的非空提示词，保留 DS 已有正文、空字符串、数组、布尔值和显式 `null`。
唯一例外是 `model_messages.approvals: null`：按已确认规则补入基础审批提示词。
缺失的 `token_budget` 整组复制必要开关、阈值和提示词，避免只补正文导致 CLI 解析失败；当前基础模板保持该功能关闭。
不继承底座模型的 Fast 档位、上下文、工具能力或 `xhigh` 子代理思考等级。补入提示词不会开启自动审批或子代理功能。

写入前复核原文件内容并互斥更新，单文件替换使用临时文件；普通写入失败会尝试回滚。
进程被强制中断或掉电不保证四文件整体原子性，可能留下 `.model-catalog-update.lock`；
确认没有维护进程后，先用 `git diff` 检查并恢复本次模板修改，再移除残留锁并重新运行。
更新结果仍需审查后提交，不会自动提交、重启服务或覆盖账户目录。新模型使用保存后的底座；
已有账户模型继续通过模板差异预览和显式确认更新，读取已有目录不注入新模板。
CLP Flash 与自定义提供商导入 DS 模型时使用仓库的 DS 补全目录，不读取某个 DS 账户的设置。
DS、OCG、CCG 仍通过官方脚本下载目录；显式创建或更新目录时使用仓库基础提示词补全缺失项并固化，读取已有目录不注入新模板。

上述是仓库补全快照的维护合同。用于第三方账户的显式模板投影另从固定底座
`experimental_supported_tools` 仅补齐 `send_user_message_async`、`clock` 两项本地工具声明；
异步提问实际工具名仍是 `request_user_input_async`。保留 DS 原有主提示词及显式空值，执行来源身份中性化，
缺失辅助提示词沿用既有补全，保留独立审批中文回复要求，不再追加额外中文时钟指导。
DS 官方能力限制不变；运行副本仍关闭 Responses Lite，来源 Lite 元数据不改。
已有账户须在“更新模板”中选择能力参数才合并这两项声明，其他工具能力保留；
清除旧版主提示词中的中文时钟尾段须另选提示词并确认，读取和能力更新均不改提示词。

## 模型与设置

DS 目录从官方安装脚本提取，不执行下载脚本。当前目录为 `deepseek-flash` 与
`deepseek-v4-pro`；实际选项以下载目录为准。首次接入生成 DS 目录，新增账户复用已有目录；
模型目录由 Setup 配置，更新器不刷新目录。
已下线模型会切到目录默认模型，同时更新对应账户配置。
导入 DS 模板到自定义提供商或 CLP 时，目录自带的提示词（`model_messages.instructions_template`）随模型定义携带；deprecated 的顶层 `base_instructions` 只是旧客户端镜像，不单独保留。

通过“模型管理 → 账户默认模型与共享思考等级”选择默认模型和思考等级，通过同一模型管理菜单的“模型上下文窗口”设置窗口 Token 数。
可选 128K、256K、384K、512K、1M 预设（仅显示不超过模型最大窗口的值），
也可选择最大窗口或自定义输入 1024 至模型最大值之间的整数；K 为 1024，M 为 1048576。
账户独立选择默认模型；思考等级、上下文和能力字段按 DS 模型共用，修改一个模型会影响所有使用该模型的 DS 账户，不影响其他提供商。相关 Profile 的默认思考等级同步保持一致。
选择该模型的切换 Profile 同步目录默认思考等级；原生角色独立保存自己的思考等级，目录更新不覆盖角色选择。
压缩使用上游默认，不写入独立自动压缩阈值。

DS 自动审查不再受本地审批模型白名单限制；模型仍须符合正常目录与路由要求。
开放选项不代表全部远端模型已验证兼容，审查失败不会自动放行。
Codex 0.160.1 的真实 App Server 与 DS 线上模型已观察到 `autoApprovalReview` 完成，
受审命令 `printf REVIEW_OK` 退出码为 0；独立 API 的虚构提示注入与外传案例返回 `deny`。
这些样本不证明完整安全性，也不代表真实渠道 UI 已完成验收。默认设置见
[审批方式](user-guide.md#审批方式手动审批与自动审查auto-review)。

切换账户的共享终端入口：

```bash
codexc remote -p ds-personal
```

Desktop 可用 `codexc app -p ds-personal`。两个入口也接受已登记的 `sf-ds-personal` Profile 名，
Remote 保留 `--profile sf-ds-personal`；两个入口默认连接主实例，不根据官方登录状态自动选择 DS。

聊天使用 `/model` 选择 `DS <账户>` 下的模型。同账户切模型保持 Thread，跨账户选择会保留并
解绑旧 Thread，下一条消息在目标账户新建 Thread，不复制历史。每个账户的 App Server 按需启动，
每个 DS 账户使用自己的统计代理，按准确 Provider ID 上报到对应账户指标 Socket。

## 网页搜索

2026-09-26 核对的官方 [Responses 兼容性说明](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
将内置 `web_search` 列为忽略，[Codex 接入配置](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
也明确设置 `web_search = "disabled"`。早期版本的搜索实测不能代表当前模型支持。

内置网页搜索使用全局 Codex `web_search` 及按精确 `ds-<账户>` ID 保存的独立覆盖，缺项跟随全局；
可在 WebUI `#/models/providers` 预览并确认保存，设置不联动其他 DS 账户，见[独立提供商的搜索模式](provider-integration-guide.md#独立提供商的搜索模式)。Gateway 保留请求中的 `web_search` 工具与选择，
不增加模型目录能力声明。CLI 或 WebUI 可做单账户诊断，结果仅反映所选账户与模型的本次响应，
一次成功不能证明其他账户支持。DS 上游是否执行仍以上游实际响应为准。
固定、切换实例以及渠道、`codexc remote` 共用此出站合同；聚合入口当前关闭。安装新代码后须重启 App Server，
本次代码更新不自动重启服务或把搜索转交 OpenAI。官方 OpenAI 与独立 Relay 保留各自合同。

目录中的 `supports_search_tool` 是客户端工具检索能力，和内置网页搜索不同，继续保留官方值。
普通函数工具及 Codex 本地管理的 MCP 工具不因关闭网页搜索而被禁用。
历史 `web_search_call` 仍可随 `input` 回传，但不代表能发起新的内置搜索。

## Responses 兼容性边界

官方 API 无状态，不支持 `previous_response_id`、`conversation` 和响应存储，由 Codex 带回历史。
支持普通函数工具；自由格式 `custom` 只接受 `apply_patch`，不能把任意自定义工具都视为受支持。
`parallel_tool_calls` 参数被忽略，并行调用始终开启；`text.format` 支持，`text.verbosity` 不生效。
`reasoning.summary` 可传入但不生成摘要，推理历史使用下文的明文正文。
目录声明用于配置客户端，不替代上游 API 合同；Gateway 不把受忽略参数解释为已实现能力。

DS 目录生成时明确设置 `support_verbosity: false`、`default_verbosity: null`、
`supports_reasoning_summary_parameter: false` 和 `default_reasoning_summary: "none"`，
移除锁定 Codex 已不使用的 `supports_reasoning_summaries` 声明。保留完整思考正文、工具能力与提示词。
已有账户的上述能力参数通过“模型管理 → 对比并更新模型模板”显式更新：选择 DS 模型及对应的 DeepSeek 模板，
取消默认勾选的“提示词”，只勾选“能力参数”，查看差异后确认保存。来源读取仓库中的 DS 模板快照，不重新下载；所选模型的修改由所有 DS 账户共用，
保留账户凭据、各自默认模型、模型默认思考等级和当前窗口；来源不支持当前设置时拒绝更新，不自动替换。
模板保存沿用目录与来源备份及事务恢复，完成后按提示重启 App Server。账户编辑只调整 Key 和运行模式，复用已有目录；
启动、Doctor 和源码更新器也不隐式改写目录。模板更新仅修改所选范围，不承诺清除所有历史字段。

当前版本拒绝旧嵌套或平级账户目录及未完成的历史目录迁移，不提供迁移命令。
保留原文件、备份和标记，处理边界见[当前目录布局与旧版本恢复](provider-integration-guide.md#当前目录布局与旧版本恢复)；升级不会迁移真实用户目录。

2026-09-26 隔离线上验证：`deepseek-flash`、`low` 思考等级连续 4 次 Responses 请求均成功，
依次覆盖客户端 `tool_search`、检索结果回传与命名空间函数调用、固定工具结果回传、下一轮用户输入。
工具未在本机执行；后续请求保留全部已返回的 `reasoning.content`，包括最终回答轮次的思考。
另以仅在 `tool_search_output` 中提供工具定义的两轮请求补测：明确要求调用后，
上游返回了对应命名空间的函数调用，确认不必在顶层重复声明已检索工具。
因此保留官方目录的 `supports_search_tool`，不因兼容性表未逐项列出便关闭客户端工具检索。
该验证不代表 OCG、CCG 接口也已验证，亦不覆盖所有模型或参数组合。

原生 Responses 把 `developer` 视同 `user`；CLP 的 Chat 适配将 `developer` 转成 `system`。
两条线路的指令角色语义不同；任意自由格式工具也不能从 CLP 的函数转换能力推导为 DS 原生支持。

## App Server 与 Thread

切换模式由同一个后台服务监管 OpenAI 主 App Server 和各账户隔离的 App Server。服务启动时只
启动主实例；原生子代理复用父线程所在 Provider 实例。首次选择 DeepSeek 模型、
恢复其 Thread、使用 DeepSeek Remote TUI 或通过 `codexc app --provider <Provider-ID>` 启动桌面时，监管入口才读取并校验私有 Profile，按需启动隔离
App Server。该账户 API Key 只进入需要它的 App Server 子进程环境，不进入命令行、服务定义或
日志；其他 Provider 的 Key 不会随之注入。

桌面入口要求主 Provider 仍为 OpenAI，单账户入口使用账户对应的精确 Provider ID；更换实例前必须完全退出桌面。
单账户连接只使用目标实例；跨实例切换仍须退出桌面。聚合提供商当前关闭，
`codexc app --provider agg`、`codexc remote --provider agg` 与聚合渠道选择均拒绝，
不登记聚合实例。原聚合代码、派生目录、历史与旧绑定保留，不自动迁移；已有绑定须显式选择独立
提供商后新建会话。旧服务需正常重启 App Server 与 Gateway 加载关闭策略，不自动停止服务。
第三方桌面及工具路径仍按各自实际证据验收，
具体边界见 [Desktop 共享说明](codex-desktop-app-development.md)。

Gateway 根据 Thread 的 `modelProvider` 路由新建、恢复、Turn、Review、Goal、MCP 和审批请求。
跨 Provider 不能原地修改正在使用的 Thread，因此 `/model` 的跨 Provider 选择会：

1. 保留并解绑当前 Thread。
2. 在下一条消息中为目标 Provider 新建 Thread。
3. 不复制可能包含 Provider 专属 reasoning、工具结果或加密内容的历史。

同一账户的 Thread 可通过 `/resume` 恢复。同一 Provider 内切换模型时不新建 Thread，选择在下一次 Turn
生效。切换 Workspace、新会话或同 Provider 历史 Thread 时，渠道会在内存中保留当前模型、思考
等级和服务层级并用于下一 Turn。切换 Workspace 后下一条消息会新建 Thread，不自动接续目标 Workspace 的历史
Thread；显式恢复不同 Provider 的历史 Thread 时尊重该 Thread 的 Provider。
跨 Provider 新建 Thread 使用目标模型目录的默认思考等级；当前 DeepSeek 默认是 `high`。

任一 Provider 意外断开时，Gateway 只重连并恢复该侧绑定。任一受监管 App Server 子进程异常退出
时，App Server 服务会共同重建受监管实例；Gateway 全局空闲策略关闭 Client 不属于异常退出，
不会触发共同重建。

## 用量与运行统计

- `/status` 的 Token、有效上下文窗口、缓存和压缩次数来自当前 Thread，不代表账户余额。
- Turn 完成摘要按同一 Turn 的全部模型请求聚合请求结果、Token、缓存命中与压缩摘要，并在官方
  `Turn.durationMs` 可用时显示本轮总耗时；另显示已落库请求的平均首 Token 时间和请求平均输出速度，
  样本范围与缺失处理统一见[完成汇报](display.md#完成汇报)，不从转储补算。
- 官方返回的推理 Token 计数仍与所有 Provider 一样展示；指标库不保存推理正文；显式开启的模型调用转储可能保存原始内容，详见[转储说明](user-guide.md#模型请求转储)。
- OpenAI Fast 和周限不会显示在 DeepSeek Thread 上。
- `/usage` 在 OpenAI Thread 中显示 Codex Token 汇总，在 DeepSeek Thread 中调用官方余额接口。
- WebUI 控制台按 `ds-<账户>` 分别展示余额并逐账户刷新；默认标记来自 DS 注册表。
- `/metrics` 从独立指标库读取当前 Thread 最近 Turn 和整个 Thread 的请求累计；输入量是多次请求的
  累计值，不表示当前上下文占用。`/metrics providers|models|errors 24h|7d|30d|90d|all` 按统一口径聚合，
  不为 DeepSeek 建立专属统计表。Gateway 不在本地计算或估算 DeepSeek 价格与费用，`/metrics` 只展示
  请求、Token、异常和官方账户数据。
- `/limits` 当前只支持 OpenAI；DeepSeek 不会回退显示 OpenAI 限额。
- DeepSeek 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。

## 重复思考保护

DS 使用第三方通用的[重复思考保护](provider-integration-guide.md#重复思考保护)：同一段 200–4096 字的片段连续重复三次时，请求停止当前轮次。具体检测条件、内存限制和中断范围见该说明。

## 推理历史回传

DeepSeek 官方账户使用原生 Responses API。Gateway 代理透传请求和响应，由 Codex 保存并在工具续跑及后续用户轮次的 `input` 中带回 `reasoning.content`，无需转换成 Chat 字段。
官方 [Responses 说明](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)以 `reasoning_text` 正文承载推理，不接受以 `summary` 或 `encrypted_content` 替代。
官方 [思考模式说明](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)中的 `reasoning_content` 要求针对 Chat API：携带 `tools` 时必须回传历史各轮推理，没有 `tools` 时该字段会被忽略。
CLP 的 Chat 转换和字段保留方式见 [Cline Pass](cline-pass.md)。本地压缩之后，以 Codex 实际保留的上下文为准，Gateway 不另存历史或补造已丢弃的推理。

## 图片识别

`deepseek-flash` 原生接受当前渠道校验后的 PNG/JPEG/WebP/GIF 图片，并通过现有 App Server
Turn 输入处理；项目仍采用更严格的最多四张、单张 10 MiB、整批 20 MiB 边界，不开放图片 URL，
但受管 DeepSeek 账户会为渠道发图自动调用官方 Files API。Gateway 通过本地模型代理把已校验的原图
上传到 DeepSeek `POST /files`，取得 `file-api-...` 编号后向 App Server 提交
`UserInput.image.fileId`；模型请求使用 `input_image.file_id`，不再重复携带该图片的 Base64。
App Server 的 Thread 历史负责后续引用，Gateway 不建立第二份文件索引或消息正文缓存。

上传授权由当前用户受保护的 Supervisor IPC 提供：Gateway 按 Thread 的精确 `ds-<账户>`
身份读取运行实例的随机 Bearer 能力。IPC 分别返回包含准确 `/go/<账户>` 前缀的模型地址和同源根路径上传地址；前者必须与该 App Server `config/read` 返回的地址精确一致，能力只发送到后者。
DeepSeek 的 HTTP 路由描述和上传入口均要求此能力；配置修订只用于检测变化，不能代替授权。
能力绑定账户、已确认的运行实例和代理代次，实例释放或重启后旧能力失效。
旧服务缺少上传能力时明确拒绝并提示重启 App Server 与 Gateway，不自动重启或回退内联输入。

服务通过独立 Worker 读取私有账户材料，同次读取前后的设置指纹必须一致，并且匹配运行实例
已确认应用的设置快照；磁盘已有待应用配置时拒绝使用新 Key。异步代理发现后、实际上传前和
上传完成后仍复核材料与运行代次。Gateway 在私有 IPC 前后、上传前后及最终 Turn 提交前
保留 Actor 与 Workspace 提交守卫，撤权后不再发起新操作。

上传只接受当前渠道边界内的 PNG/JPEG/WebP/GIF，沿用单张 10 MiB、每批四张和合计
20 MiB 限制；这低于 DeepSeek 官方单文件 64 MiB、单张 `file_id` 引用 64 MiB 和请求体 48 MiB 的上限。
客户端材料及路由准备阶段最多 60 秒；每张图片不自动重试，多张依次上传。本地代理整次上传
最多 30 秒，包含材料复核、接收原图和上游传输；Files POST 自身上限为 60 秒，客户端传输
阶段上限为 5 分钟，实际受最先到达的期限约束。
上传失败不静默回退 Base64，当前 Turn 明确失败；`/stop`、断线、账户配置变化或本地代理关闭会取消
尚未提交的上传。Gateway 不提供文件列表、下载、删除或手工编号入口，文件按 DeepSeek 默认生命周期
保留，可能形成远端孤儿文件。图片 Token 由 DeepSeek 按尺寸换算并随标准 Usage 返回，Gateway
继续使用上游 Usage 统计，不自行按像素估算。

当前修复尚未完成真实 DeepSeek Files API、三渠道公有平台及 Windows/macOS 实机链路观察；
上述合同不代表这些环境已经通过验收。

原生 Responses、Chat 桥和聚合模型入口的请求正文上限统一为 48 MiB；每次准备按声明的
`Content-Length` 预留容量，Chat 桥的 192 MiB 共享预算可容纳四个最大请求，小请求按声明长度准入；
Responses 目录准备最多四项并行。该值是 JSON 编码后的字节数，不是模型上下文 Token。取 48 MiB 是因为 DeepSeek
官方内联图片请求的上限为 48 MiB；Codex 0.163.0 远程 App Server 自身的单消息上限为 128 MiB，
Cline 官方未公布固定正文上限，48 MiB 入口探测只证明请求被接收，不证明生成成功。

Pro 仍为文字模型，收到图片时会在 Turn 前明确拒绝；需要看图时使用 `/model` 切换到
`deepseek-flash`。Gateway 不再把图片转交给另一套外部视觉 API。


固定模式下，DeepSeek 代理服务于主 App Server；切换模式按需启动。原生子代理复用父线程所在实例与统计代理。代理支持项目当前使用的
HTTP/SSE、Responses WebSocket、压缩和模型目录请求，复用统一网络代理，并保留用户已有的
`openai_base_url` 上游。认证 Header、请求正文和响应正文只做内存转发，不写入指标或日志。
Gateway 停止或重启时计时指标可能丢失，但模型请求不会因此中断。

## 应用配置

完成安装、更新 API Key、切换模式或恢复后，从本机终端运行：

```bash
codexc restart all
codexc doctor
```

渠道内不能重启 App Server。需要检查运行状态时使用：

```bash
codexc status all
codexc logs all -n 200
```
