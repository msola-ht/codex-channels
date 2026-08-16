# OpenCode Go

Codex Connect 可把 OpenCode Go 作为独立第三方 Provider 使用。当前受控模型为
`deepseek-v4-flash` 和 `deepseek-v4-pro`；它们与 DeepSeek 官方 Provider 的同名模型仍是两个
独立选项，分别使用各自的 API Key、上游地址、Thread 路由和价格来源。

## 配置与使用

运行 `codexc setup`，依次选择“模型与提供商”和“OpenCode Go”，输入 OpenCode Go API Key。
Setup 提供保留 OpenAI 默认的切换模式，以及让原生 Codex 和 Gateway 默认使用 OpenCode Go 的
固定模式。切换模式创建私有 `sf-opencode-go.config.toml`；固定模式会先备份再修改
`~/.codex/config.toml`。两种模式都从相同的经审查上游内容生成 OpenCode Go 独立模型目录，并把共享
`agents.external` 子代理切换到 OpenCode Go，不修改 DeepSeek Provider 配置。

配置完成后运行：

```bash
codexc service restart all
```

初次配置默认使用 Flash。需要调整时，在 `codexc setup` 中选择“模型与提供商 → 第三方模型设置
→ OpenCode Go”，再按模型设置默认思考等级和自动压缩百分比；每个模型按自己的上下文窗口计算
阈值，不影响另一个模型或 DeepSeek 官方 Provider。新默认值只影响之后的新会话，恢复历史 Thread
仍使用原模型。重复运行 Setup 会保留仍受支持的默认模型及逐模型设置；目录更新后的压缩阈值按原
百分比和新上下文窗口重新计算。修改后需重启 App Server。

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

OpenCode Go 当前没有接入独立账户用量接口，`/usage` 会明确显示不支持；Thread Token、请求速度和
本机请求指标仍正常记录。

### 能力边界

- 当前受控模型只声明文字输入。未启用外部图片识别时，Gateway 在 Turn 前拒绝图片，可配置
  [`图片识别代理`](vision.md) 走外部视觉接口；音频输入同样在 Turn 前拒绝。
- OpenCode Go 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。
- 网页搜索未实测：OpenCode Go 是否像 DeepSeek 一样通过 `/responses` 提供 `search` 工具尚未
  验证，会话中出现 `web_search` item 前不视为已支持。
- 当前按 HTTP/SSE 接入（`supports_websockets = false`），流式文本、工具调用和上下文压缩走
  HTTP/SSE，不建立 Responses WebSocket。
- API Key 没有官方账户接口可用于预检，Setup 只校验格式；首次请求失败时从模型指标和日志中
  查看错误分类。
- 运行统计与 DeepSeek 一致：调试模式展示最后一次请求的可观测首事件延迟，完成卡片展示整轮
  综合思考速度与含推理生成速度；`/usage` 明确显示不支持账户用量。

## 价格维护

运行时价格来自随包发布的 `runtime/opencode-go-pricing-baseline.json`，与 DeepSeek 官方人民币峰谷
价格完全隔离。基线保存 OpenCode Go 官方页面列出的全部模型美元 Token 单价、长上下文档位、套餐
包含用量、端点和 SDK 协议；只有当前受控模型会进入实际请求计价。官方端点或协议变化也会进入
候选基线差异，避免只更新价格而遗漏兼容性复核。套餐包含用量只存档用于提案复核，不参与单次
请求的参考费用计算。

每日工作流只读检查官方页面，变化时创建 Draft PR，不会自动开放模型、合并、发布或部署。页面
结构、模型 ID、端点、SDK 协议或价格档位无法确认时失败关闭并保留检查 Artifact。

官方来源：[`OpenCode Go`](https://opencode.ai/docs/go/)。
