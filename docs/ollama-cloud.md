# Ollama Cloud

OLC 是独立的受管多账户提供商，账户 ID 为 `olc-<id>`，固定使用 `https://ollama.com/v1` 的无状态 Responses，关闭 WebSocket。账户、模型管理、余额查询、freeform 适配及托管实时搜索已接入。本地 CLI、WebUI、HTTP 和原生 Codex 路径已有隔离观察；真实云端推理、搜索权限与费用仍未验收，见[开放验收记录](ollama-cloud-probe.md)。

本接入不导入、迁移或修改已有 `cp-ollama`，不支持本地 Ollama、Chat Completions、音频、Embeddings 或 OLC 聚合路由。

## 添加与使用账户

从 `codexc setup → 模型与提供商 → 第三方提供商 → Ollama Cloud`，或 WebUI 的提供商账户管理进入。命令入口为：

```bash
codexc provider ollama-cloud setup
codexc provider ollama-cloud add main
codexc provider ollama-cloud list --json
codexc provider ollama-cloud reconfigure main
codexc provider ollama-cloud default main
codexc provider ollama-cloud remove main
codexc provider ollama-cloud discover --json
codexc provider ollama-cloud discover --refresh --json
```

各入口支持 `-h` / `--help`。账户 ID 接受 1–32 位小写字母、数字、`-` 或 `_`；映射为同一凭据环境变量名的账户组合会拒绝。`default main` 只设置本家默认账户，不等于把主实例切为固定模式。

添加时输入新 Key、选择模式和账户默认模型。共享目录尚不存在时，读取公开远端列表，选择模型后自动生成其上下文、思考等级与默认值、图片能力；确认页展示所选模型，只创建这一项，不要求手填，也不发送推理请求。首次发现令牌绑定账户、Key、目录和公共底座修订，十分钟过期；选择后修改 Key 或目录须重新发现。已有目录新增账户只能选择该目录中的模型，不刷新或覆盖已有定义。编辑账户时保留当前默认模型，无需重新选择；更换默认模型从模型管理进入。

新增或替换 Key 的预览、保存各读取一次固定 `/api/balance` 验证认证，不发送推理请求；旧计划缺少 USD 金额不等于认证失败。编辑时 Key 留空保留当前凭据。取消和无变化操作不写入，无变化不请求认证或要求重启。预览后材料变化须重新确认，结果不确定时不会自动重试。

切换模式保存独立私有 Profile，按需启动账户实例；固定模式经明确确认更新 Codex 主配置。保存与运行生效是两步，按操作结果给出的目标应用设置或重启，Setup 不自动重启服务。原生终端通过托管租约连接：

```bash
codexc remote -p olc-main
```

渠道从 `/model` 选择账户和模型；历史 Thread 保留原 Provider，不自动迁移。Remote 默认仍连接主实例，不能靠设置 OLC 默认账户代替 `-p`。服务安装与更新按[源码安装](source-install.md)和[用户指南](user-guide.md)进行；完成代码提交不代表用户服务已部署。

## 共享模型、远端选择与可选验证

首次目录和后续添加均从 `/api/tags` 与 `/v1/models` 的精确 ID 交集读取候选，逐个用 `/api/show` 获取详情，并复核首尾列表和 tags。保留版本后缀；已保存的 ID 不重复添加，缺失详情、来源冲突或未明确映射的思考开关显示原因，不能靠模板猜测或手填绕过。

| 自动配置 | 来源与规则 |
| --- | --- |
| 上下文 | 读取 `model_info` 中架构对应的 `*.context_length`；最大上下文保留该来源值，默认配置窗口取来源值与 **393216** 的较小值。393216 只限制初始使用窗口，不截小模型能力；预览分别展示上游值与配置值 |
| 思考等级和默认值 | 采用 `thinking.values/default` 中受支持的字符串等级；按官方兼容合同把 `false` 映射为 `none`，纯开关的 `true` 映射为 `high` 并说明仅表示开启、不代表强度。`[false]` 只提供关闭；缺失或无法映射的默认值待确认 |
| 图片 | `capabilities` 包含 `vision` 时启用图片输入，保留每个模型的差异 |
| Responses 工具 | 按 OLC 接入默认策略启用 freeform 与客户端 `tool_search` 适配，无需逐模型收费验证 |
| 其他能力 | 关闭 WebSocket、原图、推理摘要、输出详细程度和原生网页搜索；托管 live 搜索由独立开关管理 |

CLI/Setup 和 WebUI 正常添加只需读取列表、选择模型、预览保存，不再提供 OLC 按 ID 手填或复制其他模型能力的新增方式。初始使用公共编程提示词；保存后可从模板管理选择官方底座或 DS Flash／Pro，继承提示词和运行设置。所有 OLC 模板来源均禁止覆盖上下文、思考、视觉及工具能力。窗口、默认等级与账户默认模型仍由既有模型设置入口显式管理。

远端元数据与本地适配策略不是实际推理验收。首次 manifest 保持 `source: "ollama-cloud"` 和空 `modelTemplates`；普通新增不伪造 `modelDiscovery` 验证记录。持久格式、已有模板与验证记录保持可读，不迁移或自动更新已有模型。共享目录写入沿用修订保护、备份与回读；失败时保留恢复材料，回退程序须先核对匹配的备份，不覆盖后续变更。

同族账户共用启用模型、显示名、窗口、思考等级、提示词和来源，Key 与默认模型独立。移除保护所有账户默认模型。高级“发现并验证”仍是可选操作，不是普通添加的前置条件。

`discover [--json] [--refresh]` 读取公开 `/v1/models`、`/api/tags`、`/api/show`，不使用 Key、不写模型目录、不启用模型。首次账户、普通添加和命令共用一小时持久缓存，默认命中后不再查询远端；WebUI 的“强制刷新”或 CLI 的 `--refresh` 才忽略有效期重新获取。缺少思考明细或映射有歧义时保持待确认；布尔开关按上述兼容规则转换。不能从接口返回 200、标签或模型名称推断真实工具往返已经验证。

缓存位于 `~/.codex-connect/providers/ollama-cloud/discovery-cache.json`（自定义数据目录时跟随），保存版本 1 的有界公开元数据投影和来源指纹，不含 Key、原始 show 正文或对话，不进入 StateStore。获取时间与到期时间在 CLI/WebUI 展示；缓存寿命与十分钟确认令牌分开。独立跨进程锁避免并发覆盖；刷新完整成功才原子替换，失败保留原文件并报错，不用过期结果继续添加。文件损坏、不受支持的版本或不安全权限会拒绝读取，不自动删除或迁移；缓存可单独删除后重新获取，不影响已保存模型。程序回退时保留模型目录和原有备份，缓存不作为恢复模型配置的来源。

高级收费诊断加载时强制刷新，提交前后仍直接复核远端来源，不以缓存替代诊断证据。普通聊天只消费已保存目录，不读取此缓存、不查询 tags/show。

缓存保留完整的 `upstreamContextWindow`，生成目录时分别写入上游最大值和默认配置窗口；已有版本 1 缓存可直接复用。此规则作用于首次创建及后续新增，不自动修复已保存目录中历史截小的最大值，读取和模板更新也不会隐式重写已有模型。

当前目录支持的最大上下文不超过 100000000 Token；超出范围的远端模型逐项标记为上下文待确认，不截小能力值，也不阻断其他候选。已有版本 1 缓存读取时应用相同可选范围，保留缓存原文件。

已配置账户可在模型新增中选择“发现并验证模型”：先选择具体验证账户、精确候选和包含来源默认值的等级，再明确确认可能收费。每级两次 SSE 函数调用/模拟结果续答，来源默认等级另加两次 JSON，最多 16 请求，每次 768 输出 Token、128 KiB 响应，总期限 90 秒包含前后公开来源复核，不重试。诊断不执行文件或命令；取消不能撤回已发请求或费用。

通过验证仍需预览、确认保存。来源、目录或账户材料变化会使旧结果失效；未确认、过期令牌、已保存 ID 和容量不足不能进入收费验证。保存有界来源指纹、时间和实际验证范围，不保存 Key、对话或模拟 marker。来源记录与提示词模板分开，旧 manifest 无来源字段仍可读取，不补写或迁移。

高级发现验证与普通添加共用模型生成器，保留远端声明的全部思考等级、图片能力和默认 Responses 工具适配；选择的验证等级必须包含来源默认值，只限定收费请求与验证记录，不裁剪模型能力。诊断仅证明其记录的普通函数和文本续答范围，不证明长输入、图片、freeform 或客户端工具搜索可用。模板更新仍只允许提示词及主动选择的运行设置，不改变这些能力。详细操作见[统一模型管理](provider-integration-guide.md#日常模型管理)。

## freeform 工具适配

已有目录更新前由现有事务保存目录、manifest 及相关设置备份；失败或回读不确定时保留恢复材料，按[目录恢复](provider-integration-guide.md#存储备份与恢复)处理，不重试未知写入。新增的 DS 绑定与 `supports_search_tool: true` 不被旧版 OLC 读取器接受，回退程序前须保留当前完整私有材料并核对更新前备份，恢复匹配的目录和 manifest；不得用旧备份覆盖更新后其他配置。没有自动迁移、自动回滚或删除旧目录。

App Server Provider Proxy 的固定/切换实例与独立 Model Relay 均按可信 OLC 材料启用请求级适配。custom 声明与选择保留 Responses 形态；上游返回的普通 function 包装按本次声明身份解包为 custom 输入，显式历史重新包装一次。JSON 与 SSE 都验证工具身份、完整性和关联，未完成或冲突的可执行工具不交付。

支持的能力声明是 `apply_patch_tool_type: "freeform"` 或 `null`，客户端工具搜索由布尔 `supports_search_tool` 控制。`execution: "client"` 的 `tool_search` 映射为普通函数，返回还原为客户端搜索调用；Codex 返回的搜索结果中所声明的工具会加入后续请求，已加载工具移除 `defer_loading` 标记。支持 JSON/SSE、命名空间、强制工具选择及完整历史往返；拒绝服务端工具搜索、未加载的延迟工具、孤立或冲突的历史及加密 custom 历史。适配不执行搜索到的工具，权限仍由原生 Codex 控制。旧目录必须显式更新才启用。本地原生 `apply_patch` 与客户端工具搜索的合成上游观察不能保证真实云端每个模型的行为。

## 托管实时网页搜索

首次使用前，在 `codexc config → 提供商联网搜索` 或 Setup 同名入口明确选择 **live** 或 **disabled**。切换账户也可在 WebUI 提供商行保存独立覆盖；固定提供商使用“全局设置 → 行为与偏好”的全局值，会影响共用该值的主实例。跟随全局不会自动改为 live；若请求实际声明 cached/indexed，即使提示词没有要求搜索，也会在模型出站前拒绝整次请求。

目录的原生搜索能力声明与上述策略不同。请求含支持的 `web_search` 声明时，代理将其映射为内部函数，使用当前准确账户的 Key 调用固定 `POST https://ollama.com/api/web_search`，把查询对应的摘要携带给模型续答，输出一份 Responses 响应。没有搜索声明不会启用执行；历史搜索项只保留可读查询，不自动重搜或恢复旧摘要。

只支持 live 文本摘要，不支持缓存、索引、域名过滤、地区、搜索上下文大小或其他不能兑现的控制，不自动降级。网页读取 `/api/web_fetch` 未接入，不主动抓取结果 URL。原生搜索诊断检查上游原生工具，不验证此托管线路。

固定搜索接口接受 `application/json`，以及实测返回 JSON 正文时使用的 `text/html` 响应类型；两者均必须通过 UTF-8、JSON、结果结构、URL 和大小校验，真实 HTML 错误页仍拒绝。该例外仅属于 `/api/web_search`，不放宽模型 Responses 的 JSON／SSE 校验。

搜索摘要不设单条 32 KiB 上限，也不自动截断；有效结果在单次响应 256 KiB、整请求累计结果 512 KiB 和累计模型输入 4 MiB 的既有预算内完整传递。标题 4 KiB、URL 8 KiB、结果最多十条的本地保护仍保留。资源超限使用 `olc_search_result_limit`，字段格式、Unicode 和 URL 错误使用 `olc_search_invalid_response` 并指出安全的结果序号及字段，不输出原文。这些字节预算属于本地实现，不是 Ollama 模型上下文或官方摘要限制。

搜索与客户端工具混合出现时，先验证整轮；客户端工具不会执行或对外交付，内部配对 `not_executed` 后要求模型重新决策。已完成搜索可显示完成，失败搜索不发布完成项。SSE 已开始后的受控失败沿同一响应发 `response.failed`，避免原生自动重放整次搜索；断连或交付失败不能保证终态送达。

资源限制包括最多八模型轮、四次搜索、顺序执行搜索、单搜索 45 秒、整次请求十分钟，以及累计输出预算、实际包装后正文/累计输入 4 MiB 限额。Relay 的既有准入正文上限仍更严格。每次搜索及续答前复核账户、目录、网络材料和 Relay 租约；取消、撤销或期限到达停止后续请求。搜索执行器不重定向、不自动重试。已发生的请求可能产生费用。

## 余额、指标与 Relay

账户用量按准确账户读取 `/api/balance`，将 `included.balance_usd` 与 `purchased.balance_usd` 精确相加显示 USD 总余额；支持最多九位小数，缺失、负值、格式错误及旧百分比计划返回不可用，不伪造零。认证通过不代表余额字段可显示。不提供 `/limits` 或按 Token 单价推算费用。

托管搜索的模型 Token 按实际轮累计，未知计数保持未知；外部 usage 缺少必需计数时整项省略，多轮不提供生成速率，不把最后一轮金额当作总费用。模型 completed 不能覆盖随后搜索或交付失败，须结合交付状态与错误码，见[错误字典](errors.md)。

Model Relay 独立管理，仍需其调用方 Key、精确 Provider 授权及模型准入；OLC 上游 Key 不替代 Relay 认证。Relay 只暴露模型 API，不提供 App Server 会话能力，详见[Relay 合同](provider-api-relay-development.md)。

Gateway 不维护平行会话缓存或把对话写入 StateStore。启用模型报文转储时，每个实际模型轮独立记录；内部续答中的查询、URL 和摘要可能随请求落盘，不能把它理解为“搜索内容永不存盘”。例行日志和指标不收这些正文。

## 数据、恢复与移除

默认路径（自定义数据目录时以实际配置为准）：

| 资源 | 路径 |
| --- | --- |
| 账户注册表 | `~/.codex-connect/providers/ollama-cloud/accounts.json` |
| 共享模型与来源 | 同目录 `models.json`、`models.manifest.json` |
| 公开模型元数据缓存 | 同目录 `discovery-cache.json`，一小时有效，无账户凭据 |
| 账户标记、备份及固定凭据版本 | `~/.codex-connect/providers/ollama-cloud/olc-<id>/` |
| 切换模式私有 Profile | `~/.codex/sf-olc-<id>.config.toml` |

固定模式主配置只引用私有凭据版本；切换模式沿用私有 Profile 的 Key 合同，不承诺 Key 不在 Profile 中。凭据通过受控子进程环境注入，不写命令参数或日志。

写前预检和备份，确认绑定实际账户及资源修订，保存后回读。未完成事务须走原有恢复入口；写入未知时保留文件、凭据版本和备份，不删除标记、不覆盖更新后的数据。恢复合同见[目录布局与恢复](provider-integration-guide.md#当前目录布局与旧版本恢复)。

仍有其他账户时须先切换默认账户，再移除原默认账户；最后一个账户可确认移除。移除只处理精确账户及其运行实例，保留共享目录、备份与凭据历史，不删除历史 Thread。原账户历史会话不可继续使用，不自动转移到其他账户。没有 `cp-ollama` 导入、兼容别名、数据迁移或 StateStore schema 变化。

官方来源及锁定协议见[上游来源](upstream-sources.md#ollama-cloud-官方来源)与[协议索引](index.md)。实际观察、反例和仍开放的补证集中在[接入验收记录](ollama-cloud-probe.md)。
