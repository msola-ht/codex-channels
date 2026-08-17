# OpenCode Go

Codex Connect 可把 OpenCode Go 作为独立第三方 Provider 使用。当前受控模型为
`deepseek-v4-flash` 和 `deepseek-v4-pro`；它们与 DeepSeek 官方 Provider 的同名模型仍是两个
独立选项，分别使用各自的 API Key、上游地址、Thread 路由和价格来源。

## 配置与使用

运行 `codexc setup`，依次选择“模型与提供商”和“OpenCode Go”，输入 OpenCode Go API Key。
Setup 提供保留 OpenAI 默认的切换模式，以及让原生 Codex 和 Gateway 默认使用 OpenCode Go 的
固定模式。切换模式创建私有 `sf-opencode-go.config.toml`；固定模式会先备份再修改
`~/.codex/config.toml`。两种模式都从相同的经审查上游内容生成 OpenCode Go 独立模型目录，并把共享
`agents.external` 子代理切换到 OpenCode Go，不修改 DeepSeek Provider 配置。如果
`~/.codex/config.toml` 已存在手工配置的 OpenCode Go Provider 或 Profile，切换模式会明确拒绝，
不会覆盖用户配置。

配置完成后运行：

```bash
codexc service restart all
```

初次配置默认使用 Flash。需要调整时，有两种入口：在 `codexc setup` 中选择“模型与提供商 →
OpenCode Go → 修改模型设置（思考等级、自动压缩）”，或走原有的“模型与提供商 → 第三方模型设置
→ OpenCode Go”，再按模型设置默认思考等级和自动压缩百分比；每个模型按自己的上下文窗口计算
阈值，不影响另一个模型或 DeepSeek 官方 Provider。新默认值只影响之后的新会话，恢复历史 Thread
仍使用原模型。重复运行 Setup 会保留仍受支持的默认模型及逐模型设置；目录更新后的压缩阈值按原
百分比和新上下文窗口重新计算。修改后 Gateway 会自动检测设置文件变化，校验通过并在无活动 Turn
时自动重启 App Server 生效；如需立即生效，可在终端手动运行 `codexc service restart app-server`。

聊天中使用 `/model` 选择带“OpenCode Go”前缀的模型。终端共享会话使用：

```bash
codexc remote --profile opencode-go
```

受管第三方 Provider 按需运行：服务启动时只登记配置，首次选择对应模型、恢复对应 Thread 或使用
对应 Remote TUI 时，App Server 监管进程才启动该 Provider 的统计代理和隔离 App Server。同一
Provider 后续复用该实例。当前被 `agents.external` 选择的 Provider 会预先启动统计代理，确保子代理
随主 App Server 可用；未使用也未选作子代理的 Provider 不增加进程。

## 协议与模型范围

OpenCode Go 的基础地址为 `https://opencode.ai/zen/go/v1`。本项目使用 Codex App Server 的
Responses Provider 配置；当前 Flash/Pro 已通过 `/responses` 流式文本和工具调用实测。官方 Go
页面列出的其他模型使用多种端点协议，不能只因为出现在价格页或 `/models` 中就自动开放；每个新
模型仍需确认 Codex Responses 兼容性、模型目录字段和真实工具合同后加入编译期受控列表。

OpenCode Go 已接入独立账户用量接口：当前 Thread 使用 OpenCode Go 时，`/usage` 会通过官方
`GET /zen/go/v1/usage` 查询 5 小时（$12）、7 天（$30）和月度（$60）三个配额窗口的已用百分比与
重置时间；同时在窗口下方展示模型本地用量估算：按本机指标库汇总当前官方月度窗口（由官方
`resetsAt` 倒推开始时间）内的请求，用当前官方价格基线按每个请求的开始时间重新计价（峰谷价格
自动对齐）；价格更新生效时间（基线 `sourceUpdatedAt`）之前的请求使用当时保存的价格快照，
之后的请求按当前基线重算。合计每个模型的已用金额，对照官方价格基线里的模型包含用量（如
DeepSeek V4 Pro/Flash 每月 $15）计算已用百分比与剩余额度。凭据复用 OpenCode Go
API Key（切换 Profile 或固定基础配置），未配置、网络失败或官方
响应无效时明确显示查询失败，不回退或缓存；模型本地用量只按本机指标库重算，不是官方
账单，指标库不可用或没有本地请求时该段不展示。Thread Token、请求速度和本机请求指标仍正常记录；
WebUI 控制台在 DeepSeek 余额卡旁展示同样的配额窗口与模型本地用量。

### 能力边界

- 当前受控模型只声明文字输入。未启用外部图片识别时，Gateway 在 Turn 前拒绝图片，可配置
  [`图片识别代理`](vision.md) 走外部视觉接口；音频输入同样在 Turn 前拒绝。
- OpenCode Go 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。
- 网页搜索已实测：OpenCode Go 与 DeepSeek 一样通过 `/responses` 提供搜索工具，Codex 侧统一
  以 `web_search` item 回传（`query`、`action` 和结构化 `results`），实测能返回带标题、URL、
  摘要和发布日期的真实网页结果。验证方式：直接让 OpenCode Go 会话执行搜索任务并观察事件日志
  中的 `web_search` item；或运行 `codex exec -p sf-opencode-go -C <工作目录>
  --skip-git-repo-check "请搜索……"` 直连测试。
- 当前按 HTTP/SSE 接入（`supports_websockets = false`），流式文本、工具调用和上下文压缩走
  HTTP/SSE，不建立 Responses WebSocket。
- API Key 没有官方账户接口可用于预检，Setup 只校验格式；首次请求失败时从模型指标和日志中
  查看错误分类。
- 运行统计与 DeepSeek 一致：调试模式展示最后一次请求的可观测首事件延迟，完成卡片展示整轮
  综合思考速度与含推理生成速度；`/usage` 明确显示不支持账户用量。

## 价格维护

运行时价格来自随包发布的 `runtime/opencode-go-pricing-baseline.json`，与 DeepSeek 官方人民币峰谷
价格完全隔离。基线（Schema v2）保存 OpenCode Go 官方页面列出的全部模型美元 Token 单价、
Peak/Off-Peak 时段（UTC）、长上下文档位、套餐包含用量、端点和 SDK 协议；只有当前受控模型会
进入实际请求计价。DeepSeek V4 Pro/Flash 按官方时段（01:00–04:00 与 06:00–10:00 UTC）在请求
开始时选择忙时价或闲时价，其余模型按单档或上下文分档计价。官方端点、协议或时段变化也会进入
候选基线差异，避免只更新价格而遗漏兼容性复核。套餐包含用量用于 `/usage` 模型本地用量展示与
提案复核，不参与单次请求的参考费用计算。

每日工作流只读检查官方页面，变化时创建 Draft PR，不会自动开放模型、合并、发布或部署。页面
结构、模型 ID、端点、SDK 协议或价格档位无法确认时失败关闭并保留检查 Artifact。

官方来源：[`OpenCode Go`](https://opencode.ai/docs/go/)。
