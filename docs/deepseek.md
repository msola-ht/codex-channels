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

### 自动压缩阈值

安装流程在填写 API Key 后会询问自动压缩阈值，也可以在 Setup 菜单中选择“修改自动压缩阈值”
随时调整。支持按上下文窗口百分比（10–95%，默认 60%）设置，或选择关闭；Setup 会按当前模型
上下文窗口换算成 token 数，写入 `model_auto_compact_token_limit` 与
`model_auto_compact_token_limit_scope = "total"`。修改后需要重启 App Server 生效。

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
Gateway 会在创建或追加 Turn 前检查模型能力：未启用外部图片识别时明确拒绝图片并提示切换到
支持图片的模型；启用后则先走独立视觉代理，避免产生“DeepSeek 已经原生看图”的误解。

## 网页搜索

DeepSeek（当前 `deepseek-v4-flash` + Codex 0.146.0）支持网页搜索，且不依赖 OpenAI：

- DeepSeek API 会向模型提供名为 `search` 的搜索工具；Codex 侧统一以 `web_search` item
  回传（`query`、`action` 和结构化 `results`）。实测能返回带标题、URL、摘要和发布日期的
  真实网页结果。
- 该搜索是 DeepSeek API 自身的能力，不调用 OpenAI 的 `/v1/alpha/search`；本机是否存在
  OpenAI 登录不影响 DeepSeek 搜索。Codex 的独立搜索扩展 `web.run` 不适用于 DeepSeek
  （DeepSeek 没有 `/alpha/search` 端点，也未声明 `supports_standalone_web_search`）。
- 网关链路无需额外配置：搜索请求包含在 `/responses` 模型请求内，经本地 Provider 代理
  原样透传；会话事件里出现 `web_search` item 即表示模型真的调用了搜索。
- 计费与统计：搜索是模型请求的一部分，按 DeepSeek API 用量计费，计入请求次数、Token
  与费用统计；不消耗 OpenAI 额度。
- 验证方式：直接让 DeepSeek 会话执行搜索任务，观察事件日志；或运行
  `codex exec -p deepseek -C <工作目录> --skip-git-repo-check "请搜索……"` 直连测试。
- 失效边界：若 DeepSeek API 对该模型关闭搜索、上游工具名称或响应结构变化，或网关代理
  不再透传搜索工具，则搜索不可用；当前不支持把 DeepSeek 搜索路由到 OpenAI 官方搜索。

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
生效。跨 Provider 新建 Thread 使用目标模型目录的默认思考等级；当前 DeepSeek 默认是 `high`。

任一 Provider 连接断开时，Gateway 只重连并恢复该侧绑定。任一受监管 App Server 子进程退出时，
App Server 服务会共同重建受监管实例。

## 用量与运行统计

- `/status` 的 Token、有效上下文窗口、缓存和压缩次数来自当前 Thread，不代表账户余额。
- Turn 完成摘要按同一 Turn 的全部模型请求聚合请求次数、累计模型耗时、缓存命中与不含推理的输出
  速度；DeepSeek 额外展示最后一次请求的可观测首字延时，以及整轮综合思考速度和含推理生成速度。
  文本、函数调用参数和自定义工具参数增量都计入不含推理的输出时间窗。
- OpenAI 的隐藏推理没有可靠计时流，因此不展示首字延时、思考速度或含推理生成速度等需要
  计时流的字段，也不会通过推理摘要时间估算；官方返回的推理 Token 计数仍与所有 Provider
  一样展示。
- OpenAI Fast 和周限不会显示在 DeepSeek Thread 上。
- `/usage` 在 OpenAI Thread 中显示 Codex Token 汇总，在 DeepSeek Thread 中调用官方余额接口。
- `/metrics` 从独立指标库读取当前 Thread 最近 Turn 的请求累计和最近一次直接 API 请求；输入量是
  多次请求的累计值，不表示当前上下文占用。`/metrics providers|models|errors 24h|7d|30d` 与
  OpenAI 官方及第三方直接 API 使用相同统计口径，不为 DeepSeek 建立专属统计表。新请求按当次
  价格快照估算 API 参考费用，总价按 `display.price_currency` 全局统一展示（默认 `cny`
  人民币），先出总计、再列出输入、缓存、输出三项价格明细，不显示目录静态单价，但会按本机
  实际用量折算并展示均价（元/100M，人民币）；历史记录不按新价格回算。
- `/limits` 当前只支持 OpenAI；DeepSeek 不会回退显示 OpenAI 限额。
- DeepSeek 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。

## 图片识别

DeepSeek 模型目录当前只声明文字输入。未启用外部图片识别时，Gateway 继续在 Turn 前拒绝图片；
如需识图，可按
[`图片识别代理`](vision.md) 从独立第三方 API 注册表选择 Responses 接口。识别结果作为标明来源的不可信
文字资料进入当前 DeepSeek Thread。

App Server 服务会为每个启用的 Provider 启动独立的本机回环统计代理。代理支持项目当前使用的
HTTP/SSE、Responses WebSocket、压缩和模型目录请求，复用统一网络代理，并保留用户已有的
`openai_base_url` 上游。认证 Header、请求正文和响应正文只做内存转发，不写入指标或日志。
Gateway 停止或重启时计时指标可能丢失，但模型请求不会因此中断。

## 子代理角色

切换模式可在 Codex 的 multi_agent_v2 中把 DeepSeek 作为子代理使用，并让子代理请求自动计入
模型指标。启用后运行 `codexc service restart all` 生效：

```bash
codexc agents enable-deepseek
codexc agents status
codexc agents disable-deepseek
```

`enable-deepseek` 在 `~/.codex/config.toml` 中开启 `features.multi_agent_v2`，并注册名为 `ds`
的 `agents.ds` 角色。角色文件 `~/.codex/codex-connect-ds-subagent.config.toml` 由 App Server
服务启动时动态生成，指向本机 DeepSeek 统计代理，因此子代理请求会进入与直接 API 相同的指标、
压缩和费用统计链路；服务退出时角色文件会被删除。角色文件只写模型、Provider 和 `env_key`
引用，不写 API Key，认证密钥仍只进入 App Server 子进程环境。

`disable-deepseek` 移除 `agents.ds` 角色并关闭 `multi_agent_v2`，角色文件由服务在退出或重启时
清理。需要子代理时，主模型调用 `spawn_agent` 并选择角色 `ds`。

子代理统计会在指标库中标注：Gateway 捕获父线程里的 `subAgentActivity` 通知后，把子代理
线程 ID 和代理路径写入 `subagent_threads` 表，`codexc metrics threads` 与 WebUI Threads
页面显示“子代理 · <代理路径>”。该标注需要指标库 Schema v7；升级前先停止 Gateway，再运行
`codexc metrics upgrade`（自动备份，可回滚）。

Gateway 只在父线程收到官方 `collabAgentToolCall.agentsStates` 子代理终态后，向父会话推送
“子代理完成”或“子代理失败”卡片，不再以最后模型请求后的静默时间推断完成。卡片基于指标库
汇总展示任务名、模型、请求次数、Token、费用与全量计价时的每 100M Token 均价（跟随全局价格
显示），不依赖 App Server 订阅子代理线程。官方终态后约 5 秒只用于等待指标收敛；没有模型指标
时仍发送零统计终态卡片，指标写入或读取失败则显示“统计暂不可用”。收敛结束后会等待当前指标 Writer 水位
落库，避免积压时读取部分汇总。缓存、推理、输入/缓存/输出费用分项和模型请求聚合耗时仅在调试
模式展示。紧凑操作模式只保留子代理启动与失败，成功的等待和交互操作不再各自生成完成卡片。

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
