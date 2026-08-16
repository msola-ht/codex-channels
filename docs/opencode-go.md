# OpenCode Go

Codex Connect 可把 OpenCode Go 作为独立的切换 Provider 使用。当前受控模型为
`deepseek-v4-flash` 和 `deepseek-v4-pro`；它们与 DeepSeek 官方 Provider 的同名模型仍是两个
独立选项，分别使用各自的 API Key、上游地址、Thread 路由和价格来源。

## 配置与使用

运行 `codexc setup`，依次选择“模型与提供商”和“OpenCode Go”，输入 OpenCode Go API Key。
Setup 会创建私有 `opencode-go.config.toml` 和管理标记，并复用经审查的 DeepSeek 模型目录；不会
修改 OpenAI 默认配置、DeepSeek 配置或 `~/.codex/config.toml`。

配置完成后运行：

```bash
codexc service restart all
```

聊天中使用 `/model` 选择带“OpenCode Go”前缀的模型。终端共享会话使用：

```bash
codexc remote --profile opencode-go
```

受管第三方 Provider 按需运行：服务启动时只登记配置，首次选择对应模型、恢复对应 Thread 或使用
对应 Remote TUI 时，App Server 监管进程才启动该 Provider 的统计代理和隔离 App Server。同一
Provider 后续复用该实例；未使用的 Provider 不增加 App Server 子进程。

## 协议与模型范围

OpenCode Go 的基础地址为 `https://opencode.ai/zen/go/v1`。本项目使用 Codex App Server 的
Responses Provider 配置；当前 Flash/Pro 已通过 `/responses` 流式文本和工具调用实测。官方 Go
页面列出的其他模型使用多种端点协议，不能只因为出现在价格页或 `/models` 中就自动开放；每个新
模型仍需确认 Codex Responses 兼容性、模型目录字段和真实工具合同后加入编译期受控列表。

OpenCode Go 当前没有接入独立账户用量接口，`/usage` 会明确显示不支持；Thread Token、请求速度和
本机请求指标仍正常记录。

## 价格维护

运行时价格来自随包发布的 `runtime/opencode-go-pricing-baseline.json`，与 DeepSeek 官方人民币峰谷
价格完全隔离。基线保存 OpenCode Go 官方页面列出的全部模型美元 Token 单价、长上下文档位、套餐
包含用量、端点和 SDK 协议；只有当前受控模型会进入实际请求计价。官方端点或协议变化也会进入
候选基线差异，避免只更新价格而遗漏兼容性复核。

每日工作流只读检查官方页面，变化时创建 Draft PR，不会自动开放模型、合并、发布或部署。页面
结构、模型 ID、端点、SDK 协议或价格档位无法确认时失败关闭并保留检查 Artifact。

官方来源：[`OpenCode Go`](https://opencode.ai/docs/go/)。
