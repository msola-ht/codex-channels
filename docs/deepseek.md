# DeepSeek 使用说明

本页说明 `codexc setup` 管理的 DeepSeek 配置、终端使用方式和 Provider 切换边界。一般用户只需
完成 Setup，并在配置变化后运行 `codexc service restart all`。

DeepSeek 配置写入 `~/.codex`，不写入 Gateway 的 `~/.codex-connect/config.toml`；后者只保存
通讯渠道、Workspace、显示和 Gateway 运行配置。

## 配置模式

运行 `codexc setup`，选择“模型渠道”并填写 DeepSeek API Key。Setup 提供两种安装模式：

### OpenAI + DeepSeek 切换模式

- OpenAI 继续作为原生 Codex 默认提供商，`~/.codex/config.toml` 的配置内容保持不变。
- DeepSeek 的模型、Provider 和 API Key 保存在权限为 `0600` 的
  `~/.codex/deepseek.config.toml`。
- 聊天渠道使用 `/model` 为当前会话选择模型。
- `codexc remote` 连接 OpenAI App Server；`codexc remote --profile deepseek` 连接共享的
  DeepSeek App Server。
- 直接运行 `codex` 或 `codex --profile deepseek` 会启动独立 TUI，不共享 Gateway Thread。

### 仅 DeepSeek 固定模式

- Setup 在 `~/.codex/config.toml` 中注册并选中 `deepseek-v4-flash`。
- 原生 Codex CLI、TUI、IDE 和 Gateway 都默认使用 DeepSeek。
- 固定模式只有一个 DeepSeek 主 App Server，使用 `codexc remote` 连接。

Setup 不强制改变 Codex 登录方式。切换模式不会覆盖 OpenAI 登录信息；固定模式直接使用配置中的
DeepSeek Provider。

## 管理的文件

| 文件 | 用途 |
| --- | --- |
| `~/.codex/deepseek.config.toml` | 切换模式的 DeepSeek 模型、Provider 和 API Key |
| `~/.codex/deepseek.models.json` | 从 DeepSeek 官方安装脚本提取并校验的模型目录 |
| `~/.codex/codex-connect-deepseek.config.toml` | 不含凭据的 Gateway 管理标记 |
| `~/.codex/backup-codex-connect-deepseek/` | 首次修改前的配置备份 |

这些文件位于 Codex 用户目录，不写入项目或 npm 包。重复运行 Setup 可以更新 API Key 或切换模式；
恢复操作只撤销 Setup 管理的字段，并保留之后添加的无关配置。

当前 DeepSeek 官方只声明 `deepseek-v4-flash` 支持 Codex。`deepseek-v4-pro` 会显示为暂不可用，
在官方支持前不能选择。

当前 Responses API 只支持文字输入。DeepSeek 会把收到的图片替换成占位文本而不是报错，因此
Gateway 会在创建或追加 Turn 前明确拒绝图片，并提示先切换到支持图片的模型，避免产生“模型已经
看图”的误解。

## App Server 与 Thread

切换模式由同一个后台服务监管 OpenAI 主 App Server 和隔离的 DeepSeek App Server。服务入口读取并
校验私有 Profile，通过进程级配置覆盖加载 DeepSeek 模型目录和 Provider，只把 API Key 放入对应
子进程环境；Key 不进入命令行、服务定义或日志。

Gateway 根据 Thread 的 `modelProvider` 路由新建、恢复、Turn、Review、Goal、MCP 和审批请求。
跨 Provider 不能原地修改正在使用的 Thread，因此 `/model` 的跨 Provider 选择会：

1. 保留并解绑当前 Thread。
2. 在下一条消息中为目标 Provider 新建 Thread。
3. 不复制可能包含 Provider 专属 reasoning、工具结果或加密内容的历史。

旧 Thread 仍可通过 `/resume` 恢复。同一 Provider 内切换模型时不新建 Thread，选择在下一次 Turn
生效。跨 Provider 新建 Thread 使用目标模型目录的默认思考强度；当前 DeepSeek 默认是 `high`。

任一 Provider 连接断开时，Gateway 只重连并恢复该侧绑定。任一受监管 App Server 子进程退出时，
App Server 服务会共同重建受监管实例。

## 用量与运行统计

- `/status` 的 Token、有效上下文窗口、缓存和压缩次数来自当前 Thread，不代表账户余额。
- Turn 完成摘要按同一 Turn 的全部模型请求聚合请求次数、累计模型耗时、缓存命中与不含推理的输出
  速度；DeepSeek 额外展示最后一次请求的可观测首字延时，以及整轮综合思考速度和含推理生成速度。
  文本、函数调用参数和自定义工具参数增量都计入不含推理的输出时间窗。
- OpenAI 的隐藏推理没有可靠计时流，因此不展示首字延时、推理 Token、思考速度或含推理生成
  速度；这些字段也不会通过推理摘要时间进行估算。
- OpenAI Fast 和周限不会显示在 DeepSeek Thread 上。
- `/usage` 在 OpenAI Thread 中显示 Codex Token 汇总，在 DeepSeek Thread 中调用官方余额接口。
- `/metrics` 从独立指标库读取当前 Thread 最近 Turn 的请求累计和最近一次直接 API 请求；输入量是
  多次请求的累计值，不表示当前上下文占用。
- `/limits` 当前只支持 OpenAI；DeepSeek 不会回退显示 OpenAI 限额。
- DeepSeek 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。

## 图片识别

DeepSeek 模型目录当前只声明文字输入。Gateway 默认继续在 Turn 前拒绝图片；如需识图，可按
[`图片识别代理`](vision.md) 从独立第三方 API 注册表选择 Responses 接口。识别结果作为标明来源的不可信
文字资料进入当前 DeepSeek Thread。

App Server 服务会为每个启用的 Provider 启动独立的本机回环统计代理。代理支持项目当前使用的
HTTP/SSE、Responses WebSocket、压缩和模型目录请求，复用统一网络代理，并保留用户已有的
`openai_base_url` 上游。认证 Header、请求正文和响应正文只做内存转发，不写入指标或日志。
Gateway 停止或重启时计时指标可能丢失，但模型请求不会因此中断。

## 应用配置

完成安装、更新 API Key、切换模式或恢复后，从本机终端运行：

```bash
codexc service restart all
codexc doctor
```

渠道内不能重启 App Server。需要检查运行状态时使用：

```bash
codexc service status all
codexc service logs all -n 200
```
