# Cline Pass

通过 `codexc setup` → 模型与提供商 → 第三方 Provider → Cline Pass 配置。
当前接入单个 Cline Pass Key 和 `cline-pass/deepseek-v4.1-flash` 模型，支持固定与切换模式。
上下文窗口由用户按账户模型能力填写，不借用其他供应商目录中的窗口或价格。

切换模式使用独立 `sf-cline-pass.config.toml` Profile；固定模式修改 Codex 主配置并保留初始备份。
Key 使用现有私有文件机制保存，不写入 Gateway TOML 或命令行。配置文件位于 Codex Home，目录与管理标记
位于 `~/.codex-connect/providers/cline-pass/`。配置变更后按 Setup 提示重启服务；切换模式通过
现有 Provider 选择入口使用 Cline Pass。删除配置会停止对应受管实例，保留初始配置备份和历史统计。
配置写入复用受管事务和失败回滚，不迁移已有 Provider 数据或数据库。

## Chat 转换边界

锁定 Codex 仅支持 Responses。App Server 仍配置 `wire_api = "responses"`，服务拥有的本地回环代理
把完整请求转换后发送至 `https://api.cline.bot/api/v1/chat/completions`，再把 Chat SSE 转换回 Responses。
Gateway 重启不会终止该桥或共享 App Server。转换逻辑独立在 `src/model-api`，可以供其他 Chat Provider 复用。

支持文本、用户图片输入、函数工具（含命名空间）及文本结果、明文推理展示和 Token 用量；不支持自由格式工具、远程 compaction、
加密或带签名的推理、结构化输出、Fast 或 WebSocket。原生网页搜索工具不支持；外部函数形式的工具仍按函数调用处理。
Chat 的 `reasoning` 与无签名 `reasoning_details` 明文映射为推理摘要；同一增量中的重复文本只保留一次，内容冲突时明确失败。
用户图片支持 PNG、JPEG、WebP、GIF 的内联 Base64 Data URL，保留多图与文本顺序，沿用渠道的图片校验。
不支持图片文件引用、远程图片 URL、工具结果中的图片或 `detail: original`；`auto`、`low`、`high` 原样传递。
已有 Cline Pass 配置需通过 Setup 重新配置以更新模型目录中的图片能力和思考等级，再按提示重启服务。
思考等级支持 `none`、`low`、`high`、`max`，新配置默认 `high`；选择的等级通过 Chat `reasoning.effort` 原样传递，`none` 明确关闭思考。
未传入等级时沿用上游默认值。旧配置的 `none` 原先不发送参数，更新后会关闭思考；需要思考时选择 `low`、`high` 或 `max`。
非 OpenAI Provider 的上下文压缩沿用锁定 Codex 的本地压缩路径，不伪造远程压缩结果。

请求正文上限 16 MiB，单个 SSE 缓冲上限 2 MiB，单次响应转换状态有界；客户端取消和服务关闭会中止上游请求。
不支持的语义明确失败，不保存第二份历史。上游 HTTP 错误、流内错误、截断和缺少结束标记均不报告成功。
错误消息不回显上游报文或凭据。调用记录保存转换前后的 Responses 视图，不额外存储 Chat 报文。

输入和输出 Token 来自上游 `usage`；缓存来自 `prompt_tokens_details.cached_tokens`，没有该字段时显示未知。
尚未接入 Cline Pass 套餐额度查询，额度以 Cline 官方页面为准。

## 来源与验证

- [Cline Chat API](https://docs.cline.bot/api/chat-completions)：认证、消息、函数工具、流和用量。
- [Cline Pass](https://docs.cline.bot/getting-started/clinepass)：套餐和模型入口。
- `tests/model-api.test.ts`：消息、并行工具、缓存和失败语义。
- `tests/real-app-server-chat-provider.test.ts`：真实锁定 App Server 通过隔离 Chat 上游完成工具闭环。

本地合同测试使用临时 Codex Home 与假上游，不消耗套餐额度；不等同于 Cline 线上模型验收。

2026-09-25（UTC）线上验收：`cline-pass/deepseek-v4.1-flash` 经本地转换桥和统计代理完成文本、
推理历史回传、两个带命名空间的并行函数调用和结果续写。输入、输出、推理及缓存 Token 字段均正常转换；
短请求返回缓存计数 0，尚未验证实际缓存命中。此验收未修改运行中的服务或用户配置。
同日通过临时 Codex Home 中的真实 App Server、转换桥和 Cline 线上模型验证内联 PNG 识图，模型正确识别图片颜色并正常完成。
隔离合同测试覆盖图片历史在函数调用后的续写请求中保留。
同日线上接口验证 `none`、`low`、`high`、`max` 均正常完成，`none` 返回 0 推理 Token，其余等级返回推理，非法等级返回流内错误。
真实 App Server 经转换桥连接 Cline 的完整链路也验证了默认 `high` 产生推理，以及同一 Thread 切换 `none` 后不再产生推理。

普通 `/api/v1/models` 未列出该 Pass 模型，但直接调用成功；
[官方推荐目录](https://api.cline.bot/api/v1/ai/cline/recommended-models) 的 `clinePass` 列出该模型并描述为 1M 上下文。
该描述不提供精确 Token 上限，也未做满窗口测试，Setup 仍要求用户填写窗口。
