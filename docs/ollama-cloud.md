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
```

各入口支持 `-h` / `--help`。账户 ID 接受 1–32 位小写字母、数字、`-` 或 `_`；映射为同一凭据环境变量名的账户组合会拒绝。`default main` 只设置本家默认账户，不等于把主实例切为固定模式。

添加时输入新 Key、模式和明确的默认模型。首次目录须手动填写准确模型 ID（保留版本和冒号）、显示名、窗口、思考等级及默认等级、图片和 freeform 声明；没有家族兜底模型或思考等级。已有目录新增账户必须选择其中模型，账户表单不能覆盖共享目录。手动声明能力不等于验证通过。

新增或替换 Key 的预览、保存各读取一次固定 `/api/balance` 验证认证，不发送推理请求；旧计划缺少 USD 金额不等于认证失败。编辑时 Key 留空保留当前凭据。取消和无变化操作不写入，无变化不请求认证或要求重启。预览后材料变化须重新确认，结果不确定时不会自动重试。

切换模式保存独立私有 Profile，按需启动账户实例；固定模式经明确确认更新 Codex 主配置。保存与运行生效是两步，按操作结果给出的目标应用设置或重启，Setup 不自动重启服务。原生终端通过托管租约连接：

```bash
codexc remote -p olc-main
```

渠道从 `/model` 选择账户和模型；历史 Thread 保留原 Provider，不自动迁移。Remote 默认仍连接主实例，不能靠设置 OLC 默认账户代替 `-p`。服务安装与更新按[源码安装](source-install.md)和[用户指南](user-guide.md)进行；完成代码提交不代表用户服务已部署。

## 共享模型与逐模型验证

同族账户共用启用模型、显示名、窗口、思考等级、提示词和来源，Key 与默认模型选择独立。CLI/Setup 的“模型管理”和 WebUI 使用同一预览、修订保护与目录事务；可按 ID 独立填写、继承同目录模型、发现并验证新模型，管理账户默认值、共享窗口/等级及本地移除。移除保护所有账户默认模型，不能覆盖已保存 ID。

`discover [--json]` 只读公开 `/v1/models`、`/api/tags`、`/api/show`，不使用 Key、不写目录、不启用模型。缺少思考明细或只有布尔思考开关时保持待确认；不能从接口返回 200、标签或模型名称推断 Responses 工具兼容。

已配置账户可在模型新增中选择“发现并验证模型”：先选择具体验证账户、精确候选和包含来源默认值的等级，再明确确认可能收费。每级两次 SSE 函数调用/模拟结果续答，来源默认等级另加两次 JSON，最多 16 请求，每次 768 输出 Token、128 KiB 响应，总期限 90 秒包含前后公开来源复核，不重试。诊断不执行文件或命令；取消不能撤回已发请求或费用。

通过验证仍需预览、确认保存。来源、目录或账户材料变化会使旧结果失效；未确认、过期令牌、已保存 ID 和容量不足不能进入收费验证。保存有界来源指纹、时间和实际验证范围，不保存 Key、对话或模拟 marker。来源记录与提示词模板分开，旧 manifest 无来源字段仍可读取，不补写或迁移。

自动窗口取来源值与本地策略上限 **393216** 的较小值，不证明长输入可用。自动新增仅声明文本输入，freeform 为 `null`，客户端工具搜索与原生网页搜索能力关闭。图片/freeform 可从手动定义明确声明，自动诊断不验证它们。模板更新仅允许 `official` 底座的提示词及主动选择的运行设置，不从官方模型复制图片、思考或窗口能力。已有模型可调整窗口和思考等级，但暂不提供图片/freeform 等能力的完整编辑入口，也不能通过发现新增覆盖旧 ID；详细可用操作见[统一模型管理](provider-integration-guide.md#日常模型管理)。

## freeform 工具适配

App Server Provider Proxy 的固定/切换实例与独立 Model Relay 均按可信 OLC 材料启用请求级适配。custom 声明映射为普通 function 包装；响应按本次声明身份解包为 custom 输入，显式历史重新包装一次。JSON 与 SSE 都验证工具身份、完整性和关联，未完成或冲突的可执行工具不交付。

支持的能力声明是 `apply_patch_tool_type: "freeform"` 或 `null`；不自动升级旧目录，不支持客户端 `tool_search`、延迟加载工具或加密 custom 历史。适配不执行工具，文件与命令权限仍由原生 Codex 控制。本地原生 `apply_patch` 已真实创建/修改文件并续答，但上游使用合成响应，不能据此保证真实云端每个模型均可编辑文件。

## 托管实时网页搜索

首次使用前，在 `codexc config → 提供商联网搜索` 或 Setup 同名入口明确选择 **live** 或 **disabled**。切换账户也可在 WebUI 提供商行保存独立覆盖；固定提供商使用“全局设置 → 行为与偏好”的全局值，会影响共用该值的主实例。跟随全局不会自动改为 live；若请求实际声明 cached/indexed，即使提示词没有要求搜索，也会在模型出站前拒绝整次请求。

目录的原生搜索能力声明与上述策略不同。请求含支持的 `web_search` 声明时，代理将其映射为内部函数，使用当前准确账户的 Key 调用固定 `POST https://ollama.com/api/web_search`，把查询对应的摘要携带给模型续答，输出一份 Responses 响应。没有搜索声明不会启用执行；历史搜索项只保留可读查询，不自动重搜或恢复旧摘要。

只支持 live 文本摘要，不支持缓存、索引、域名过滤、地区、搜索上下文大小或其他不能兑现的控制，不自动降级。网页读取 `/api/web_fetch` 未接入，不主动抓取结果 URL。原生搜索诊断检查上游原生工具，不验证此托管线路。

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
| 账户标记、备份及固定凭据版本 | `~/.codex-connect/providers/ollama-cloud/olc-<id>/` |
| 切换模式私有 Profile | `~/.codex/sf-olc-<id>.config.toml` |

固定模式主配置只引用私有凭据版本；切换模式沿用私有 Profile 的 Key 合同，不承诺 Key 不在 Profile 中。凭据通过受控子进程环境注入，不写命令参数或日志。

写前预检和备份，确认绑定实际账户及资源修订，保存后回读。未完成事务须走原有恢复入口；写入未知时保留文件、凭据版本和备份，不删除标记、不覆盖更新后的数据。恢复合同见[目录布局与恢复](provider-integration-guide.md#当前目录布局与旧版本恢复)。

仍有其他账户时须先切换默认账户，再移除原默认账户；最后一个账户可确认移除。移除只处理精确账户及其运行实例，保留共享目录、备份与凭据历史，不删除历史 Thread。原账户历史会话不可继续使用，不自动转移到其他账户。没有 `cp-ollama` 导入、兼容别名、数据迁移或 StateStore schema 变化。

官方来源及锁定协议见[上游来源](upstream-sources.md#ollama-cloud-官方来源)与[协议索引](index.md)。实际观察、反例和仍开放的补证集中在[接入验收记录](ollama-cloud-probe.md)。
