# CLP（Cline Pass）

通过 `codexc setup` → 模型与提供商 → 第三方 Provider → Cline Pass 官方配置。
支持多个 CLP 账户，各账户使用独立 API Key，当前模型为 `cline-pass/deepseek-v4.1-flash`，支持固定与切换模式。
Setup 和 WebUI 设置页均可添加、重新配置、设置默认及移除账户。账户 ID 为 1–32 位小写字母、数字、`-` 或 `_`；映射后凭据变量名相同的 ID 不可同时使用，例如 `a-b` 与 `a_b`。
上下文与图片、思考等级模板复用 DS 的 `deepseek-flash`：优先读取本地 DS 目录，缺失时读取官方安装脚本中的目录并与 Cline 配置一并保存为本地共享 DS 模板，不执行脚本，无需手填上下文。
保留 Cline 已验证的 `none` 思考等级和 Chat 转换边界，不复制原生搜索等服务端能力。
通过“模型上下文窗口”统一修改 `deepseek-flash`，同步 DS、同名受管模型、CLP 和已启用 DS 跟随的第三方自定义模型；不同模型不联动思考等级。
所有 Cline 账户共享同一份模型目录。添加账户或更新密钥保留已有上下文及思考等级；调整上下文仍使用统一的模型窗口设置。

切换模式按账户使用 `sf-clp-<账户>.config.toml` Profile 和独立 App Server；固定模式修改 Codex 主配置并保留该账户的初始备份。
Key 使用现有私有文件机制保存，不写入 Gateway TOML 或命令行。配置文件位于 Codex Home，目录与管理标记
位于 `~/.codex-connect/providers/clp/`。配置变更后按 Setup 提示重启服务；切换模式通过
现有 Provider 选择入口使用 `clp-<账户>`，终端可使用 `codexc remote --profile sf-clp-<账户>`。
账户注册表 `accounts.json` 只保存 ID 和默认标记；各账户的管理标记和备份位于 `accounts/<账户>/`。
默认账户用于默认选择，已有会话不自动更换账户，也不因额度不足轮换密钥。删除账户前须先把默认标记交给其他账户（仅剩一个账户时可直接删除）。
删除会停止对应受管实例，保留初始配置备份和历史统计，该账户的历史会话不再可用；其他账户及共享目录保留。仅在删除最后一个账户时删除 Cline 共享模型目录，DS 模板保留。

仅支持多账户结构，不迁移或兼容早期单账户配置。使用过 `feat/cline-pass` 分支早期单账户版本的用户，需先用旧版 Setup 移除旧 Cline 配置，再用新版重新添加；从 `main` 首次接入无需迁移。新版本遇到旧管理标记或 Profile 会明确拒绝读取，不自动删除数据。
配置写入复用受管事务和失败回滚，不迁移已有 Provider 数据或数据库。

## Chat 转换边界

锁定 Codex 仅支持 Responses。App Server 仍配置 `wire_api = "responses"`，服务拥有的本地回环代理
把完整请求转换后发送至 `https://api.cline.bot/api/v1/chat/completions`，再把 Chat SSE 转换回 Responses。
Gateway 重启不会终止该桥或共享 App Server。转换逻辑独立在 `src/model-api`，可以供其他 Chat Provider 复用。

支持文本、用户图片输入、函数工具（含命名空间）及文本结果、明文推理展示和 Token 用量。自由格式 `custom` 工具以单字段 `input` 的 JSON 函数下发，完整 Lark 语法保留在工具说明中，回程还原为 `custom_tool_call`；执行位置为 `client` 的 `tool_search` 回程还原为 `tool_search_call`，其结果带回的工具在同一请求内补充声明，并移除已发现工具的 `defer_loading` 标记。不支持服务端执行的 `tool_search`、原生网页搜索等托管工具、远程 compaction、加密或带签名的推理、结构化输出、Fast 或 WebSocket；外部函数形式的工具仍按函数调用处理。
Chat 的 `reasoning` 与无签名 `reasoning_details` 明文映射为推理摘要，并随请求历史回传为 `reasoning`。若上游使用 `reasoning_content`，则通过 Responses 的 `reasoning.content` 保留完整正文，后续还原为 `reasoning_content`，不以摘要替代。工具续跑及下一用户轮次均保留请求历史中的推理；同一增量中的重复文本只保留一次，内容冲突时明确失败。
[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)要求携带 `tools` 的 Chat 请求完整回传历史推理，即使某轮没有调用工具。CLP 按 Cline 的实际返回字段转换；DeepSeek 官方账户使用原生 Responses，见 [DeepSeek](deepseek.md)。
用户图片支持 PNG、JPEG、WebP、GIF 的内联 Base64 Data URL，保留多图与文本顺序，沿用渠道的图片校验。
不支持图片文件引用、远程图片 URL、工具结果中的图片或 `detail: original`；`auto`、`low`、`high` 原样传递。
新账户复用共享目录中的图片能力和思考等级。
思考等级支持 `none`、`low`、`high`、`max`，新配置默认 `high`；选择的等级通过 Chat `reasoning.effort` 原样传递，`none` 明确关闭思考。
未传入等级时沿用上游默认值。旧配置的 `none` 原先不发送参数，更新后会关闭思考；需要思考时选择 `low`、`high` 或 `max`。
非 OpenAI Provider 的上下文压缩沿用锁定 Codex 的本地压缩路径，不伪造远程压缩结果。

请求正文上限 16 MiB，单个 SSE 缓冲上限 2 MiB，单次响应转换状态有界；客户端取消和服务关闭会中止上游请求。
不支持的语义明确失败，不保存第二份历史。上游 HTTP 错误、流内错误、截断和缺少结束标记均不报告成功。
错误消息不回显上游报文或凭据。调用记录保存转换前后的 Responses 视图，不额外存储 Chat 报文。

输入和输出 Token 来自上游 `usage`；缓存来自 `prompt_tokens_details.cached_tokens`，没有该字段时显示未知。
账户用量通过 Cline 官方 `GET /api/v1/users/me/plan/usage-limits` 查询，使用已配置的 Key，支持固定和切换模式。
WebUI 账户卡片和渠道 `/usage` 显示 5 小时、7 天、月度窗口的已用比例及重置时间，并复用现有账户刷新入口。
只展示官方返回的比例与重置时间，不推算 Token 总额度、Credits 余额或套餐续费日期。
额度、重置时间、刷新状态和请求统计按账户分别记录；查询失败保留该账户上次有效快照，其他账户不受影响。删除账户后隐藏对应卡片，保留历史统计。
已有配置升级后需重启 Gateway 以加载账户适配器，无需为额度查询重新执行 Setup。

## 调用诊断与错误

上下文同步复用现有事务与私有恢复记录。若同步失败且自动回滚未完成，停止相关服务后可执行 `codexc primary-provider recover clp-<账户> rollback`（恢复原值）或 `keep`（保留新值）；恢复整个关联事务后再重启服务。

工具名称与命名空间拼接超过 Chat 的 64 字符限制时，转换层使用稳定短名，返回时还原原始工具身份；历史调用和指定工具选择使用相同映射。

开启调用详情记录后，Chat 桥会额外保留有界、白名单筛选的上游诊断信息：原始模型名、请求/响应标识、实际提供商、路由尝试与备用提供商、缓存与多模态 Token 明细、各口径费用。字段按上游原名保存，未返回的值不推算；备用提供商不表示本次实际调用，费用也不等同于套餐扣费。不会保存完整 Chat 报文、凭据、会话标识或任意上游元数据。
这些信息经桥接与代理之间的请求级进程内回调写入现有 V2 trace 的 `chat_diagnostics` 事件；本地 HTTP 仅携带随机关联编号，诊断信息在终态交付前提交，不透传给 App Server，不进入 Token 指标或数据库。原记录无需改写；旧版本可忽略新事件，回滚不需要迁移。历史请求无法补录，重新部署并重启 App Server 后的新请求才会产生诊断信息。
WebUI 调用详情的“Chat 上游信息”展示上述字段；受长度或条目上限影响时明确提示。长度限制或内容过滤导致的不完整响应会保留已生成的回答和思考文本，但不会发布不完整的工具调用。

错误处理依据 [Cline 官方错误文档](https://docs.cline.bot/api/errors)：HTTP 400/401/402/403/404/429/500/502/503 返回固定的安全说明，读取错误正文最多 64 KiB，未知或不可解析正文按 HTTP 状态归类。HTTP 200 中的顶层 `error` 或 `choices[].error` / `finish_reason: error` 转为失败终态，保留已知 `context_length_exceeded`、`content_filter`、`rate_limit`、`server_error` 分类。请求 ID、HTTP 状态、错误阶段和是否适合稍后重试进入诊断记录，不保留任意错误原文或 metadata。生成桥不自动重试；认证、权限和额度错误需先处理配置或账户，临时限流和服务异常仅提供重试建议。Codex 仍使用既有有限重试策略。

## 来源与验证

- [Cline Chat API](https://docs.cline.bot/api/chat-completions)：认证、消息、函数工具、流和用量。
- [CLP](https://docs.cline.bot/getting-started/clinepass)：套餐和模型入口。
- `tests/model-api.test.ts`：消息、并行工具、缓存和失败语义。
- `tests/real-app-server-chat-provider.test.ts`：真实锁定 App Server 通过隔离 Chat 上游完成工具闭环。

本地合同测试使用临时 Codex Home 与假上游，不消耗套餐额度；不等同于 Cline 线上模型验收。

2026-09-25（UTC）线上验收：`cline-pass/deepseek-v4.1-flash` 经本地转换桥和统计代理完成文本、
推理历史回传、两个带命名空间的并行函数调用和结果续写。输入、输出、推理及缓存 Token 字段均正常转换；
首次短请求返回缓存计数 0；随后部署后的 8 次线上请求均成功，实际缓存命中及工具调用续写已确认。首次隔离验收未修改运行中的服务或用户配置。
同日通过临时 Codex Home 中的真实 App Server、转换桥和 Cline 线上模型验证内联 PNG 识图，模型正确识别图片颜色并正常完成。
隔离合同测试覆盖图片历史在函数调用后的续写请求中保留。
同日线上接口验证 `none`、`low`、`high`、`max` 均正常完成，`none` 返回 0 推理 Token，其余等级返回推理，非法等级返回流内错误。
真实 App Server 经转换桥连接 Cline 的完整链路也验证了默认 `high` 产生推理，以及同一 Thread 切换 `none` 后不再产生推理。

普通 `/api/v1/models` 未列出该 Pass 模型，但直接调用成功；
[官方推荐目录](https://api.cline.bot/api/v1/ai/cline/recommended-models) 的 `clinePass` 列出该模型并描述为 1M 上下文。
未做满窗口测试；本地配置使用 DS Flash 模板的精确窗口参数。

2026-09-25 已使用现有 API Key 确认官方额度接口返回三个窗口的 `percentUsed` 与 `resetsAt`；接口来源为 [Cline 账户控制台](https://app.cline.bot/)。
