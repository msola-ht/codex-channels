# DeepSeek 使用说明

本页说明 `codexc setup` 管理的 DeepSeek 配置、终端使用方式和 Provider 切换边界。一般用户只需
完成 Setup，并在配置变化后运行 `codexc service restart all`。

DeepSeek Profile 写入 `~/.codex`，模型目录与管理标记写入 `~/.codex-connect/providers/deepseek/`，
均不写入 Gateway 的 `~/.codex-connect/config.toml`；后者只保存通讯渠道、Workspace、显示和
Gateway 运行配置。

## 配置模式

运行 `codexc setup`，选择“模型与提供商 → 第三方 → DeepSeek 官方”并填写 DeepSeek API Key。Setup 提供两种安装模式：

### OpenAI + DeepSeek 切换模式

- OpenAI 继续作为原生 Codex 默认提供商，`~/.codex/config.toml` 的配置内容保持不变。
- DeepSeek 的模型、Provider 和 API Key 保存在权限为 `0600` 的
  `~/.codex/sf-deepseek.config.toml`。
- 聊天渠道使用 `/model` 为当前会话选择模型。
- `codexc remote` 连接 OpenAI App Server；`codexc remote --profile deepseek` 连接共享的
  DeepSeek App Server。
- 直接运行 `codex` 或 `codex --profile sf-deepseek` 会启动独立 TUI，不共享 Gateway Thread；
  Profile 镜像所选模型的默认思考等级，与 Remote/App Server 一致。

### 仅 DeepSeek 固定模式

- Setup 在 `~/.codex/config.toml` 中注册并选中 `deepseek-v4-flash`。
- 原生 Codex CLI、TUI、IDE 和 Gateway 都默认使用 DeepSeek。
- 固定模式只有一个 DeepSeek 主 App Server，使用 `codexc remote` 连接。

Setup 不强制改变 Codex 登录方式。切换模式不会覆盖 OpenAI 登录信息；固定模式直接使用配置中的
DeepSeek Provider。

### 自动压缩阈值

安装流程在填写 API Key 后会为初始 Flash 模型询问自动压缩阈值。后续有两种入口：`codexc setup`
中选择“模型与提供商 → 第三方 → DeepSeek 官方 → 修改模型设置（思考等级、自动压缩）”，或走原有的
“模型与提供商 → 第三方 → 第三方模型设置 → DeepSeek”，按 Provider 和模型分别选择默认思考等级与自动压缩百分比
（10–90%）；该百分比按模型自己的 `context_window` 换算为模型目录中的
`auto_compact_token_limit`，不会再用 Profile 顶层配置覆盖其他模型；切换模式 Profile 顶层只镜像
所选模型的默认思考等级（校验必须与模型目录一致），上下文与自动压缩仍只由模型目录声明。
选择模型默认值时使用 Codex 的 90% 上下文窗口阈值。修改后 Gateway 会自动检测设置文件变化，
校验通过并在无活动 Turn 时自动重启 App Server 生效；如需立即生效，可在终端手动运行
`codexc service restart app-server`。

## 管理的文件

| 文件 | 用途 |
| --- | --- |
| `~/.codex/sf-deepseek.config.toml` | 切换模式的 DeepSeek 模型、默认思考等级镜像、Provider 和 API Key |
| `~/.codex-connect/providers/deepseek/models.json` | 从 DeepSeek 官方安装脚本提取并校验的模型目录 |
| `~/.codex-connect/providers/deepseek/models.manifest.json` | 模型目录下载校验清单 |
| `~/.codex-connect/providers/deepseek/managed.toml` | 不含凭据的 Gateway 管理标记 |
| `~/.codex-connect/providers/deepseek/backup/` | 首次修改前的基础配置、同名 Profile、管理标记和角色文件备份 |
| `~/.codex/sf-agent.config.toml` | 不含凭据的共享第三方子代理配置 |

Profile 位于 Codex 用户目录（原生 `--profile` 只识别这里），模型目录与管理标记位于 Gateway 数据
目录 `~/.codex-connect/providers/`，均不写入项目或 npm 包。重复运行 Setup 可以更新 API Key 或
切换模式，并保留仍受支持的默认模型及逐模型思考、自动压缩设置；上下文窗口采用新目录值，压缩阈值
按原百分比重新计算。
恢复操作把文件还原到首次备份状态，会覆盖安装后对 `~/.codex/config.toml` 的修改。安装前已存在
的同路径角色文件会原样恢复，原来不存在时则删除 Setup 生成的角色文件。
OpenCode Go 从相同上游内容生成自己的模型目录，因此恢复或修改任一 Provider 不影响另一方设置。
从旧版文件布局升级时，运行 `codexc update` 会在核心服务停止期间把受管模型目录、清单、管理标记
和备份迁移到 `~/.codex-connect/providers/deepseek/`；新旧文件同时存在时不会猜测覆盖关系，而是
明确报错。旧版 Profile 顶层的思考等级和自动压缩阈值会迁移进对应模型目录，切换模式 Profile 再
镜像所选模型的默认思考等级；迁移不保留旧的 `body_after_prefix` 压缩作用域，升级后统一按
`total` 作用域应用。

当前 DeepSeek 官方目录声明 `deepseek-v4-flash` 和 `deepseek-v4-pro` 均支持 Codex；两者都可通过
`/model` 选择。初次配置默认使用 Flash；之后可在 `codexc setup` 的“模型与提供商 → 第三方 → 第三方模型设置”
中按模型设置 DeepSeek 新会话的默认模型、思考等级和自动压缩阈值。历史 Thread 仍保留自身模型。Setup 每次安装时下载最新官方目录，项目的每小时目录提案工作流
还会比较模型完整指纹与关键审查字段；发现变化时只创建 Draft PR，不会自动开放未知模型、发布或部署。

当前 Responses API 只支持文字输入。DeepSeek 会把收到的图片替换成占位文本而不是报错，因此
Gateway 会在创建或追加 Turn 前检查模型能力：未启用外部图片识别时明确拒绝图片并提示切换到
支持图片的模型；启用后则先走独立视觉代理，避免产生“DeepSeek 已经原生看图”的误解。

## 网页搜索

DeepSeek（当前 `deepseek-v4-flash`、`deepseek-v4-pro` + Codex 0.147.0）支持网页搜索，且不依赖 OpenAI：

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
  `codex exec -p sf-deepseek -C <工作目录> --skip-git-repo-check "请搜索……"` 直连测试。
- 失效边界：若 DeepSeek API 对该模型关闭搜索、上游工具名称或响应结构变化，或网关代理
  不再透传搜索工具，则搜索不可用；当前不支持把 DeepSeek 搜索路由到 OpenAI 官方搜索。

## App Server 与 Thread

切换模式由同一个后台服务监管 OpenAI 主 App Server 和隔离的 DeepSeek App Server。服务启动时只
启动主实例；当前共享子代理选择 DeepSeek 时还会预先启动其统计代理。首次选择 DeepSeek 模型、
恢复其 Thread 或使用 DeepSeek Remote TUI 时，监管入口才读取并校验私有 Profile，按需启动隔离
App Server。DeepSeek API Key 只进入需要它的 App Server 子进程环境，不进入命令行、服务定义或
日志；其他 Provider 的 Key 不会随之注入。

Gateway 根据 Thread 的 `modelProvider` 路由新建、恢复、Turn、Review、Goal、MCP 和审批请求。
跨 Provider 不能原地修改正在使用的 Thread，因此 `/model` 的跨 Provider 选择会：

1. 保留并解绑当前 Thread。
2. 在下一条消息中为目标 Provider 新建 Thread。
3. 不复制可能包含 Provider 专属 reasoning、工具结果或加密内容的历史。

旧 Thread 仍可通过 `/resume` 恢复。同一 Provider 内切换模型时不新建 Thread，选择在下一次 Turn
生效。切换 Workspace、新会话或同 Provider 历史 Thread 时，渠道会在内存中保留当前模型、思考
等级和服务层级并用于下一 Turn；显式恢复不同 Provider 的历史 Thread 时尊重该 Thread 的 Provider。
跨 Provider 新建 Thread 使用目标模型目录的默认思考等级；当前 DeepSeek 默认是 `high`。

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
  价格快照估算 API 参考费用。价格来自随版本审查的 DeepSeek 官方人民币基线；2026 年 8 月 17 日
  00:00（北京时间）起，按请求开始时间在 09:00–12:00、14:00–18:00 使用高峰价，其余时间使用
  空闲价，区间采用含开始、不含结束的项目规则。运行时按当前 USD/CNY 汇率固化为统一 USD 快照；
  汇率、精确模型或有效计划缺失时不使用通用目录猜价。总价按 `display.price_currency` 全局统一展示（默认 `cny`
  人民币），先出总计、再列出输入、缓存、输出三项价格明细，不显示目录静态单价，但会按本机
  实际用量折算并展示均价（元/100M，人民币）；历史价格快照不按新价格回算，人民币展示仍按当前
  汇率统一换算。每小时上游检查会
  解析官方价格页并在变化时创建 Draft PR，不会让运行中的 Gateway 直接抓取 HTML 或自动发布。
- `/limits` 当前只支持 OpenAI；DeepSeek 不会回退显示 OpenAI 限额。
- DeepSeek 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。

## 图片识别

DeepSeek 模型目录当前只声明文字输入。未启用外部图片识别时，Gateway 继续在 Turn 前拒绝图片；
如需识图，可按
[`图片识别代理`](vision.md) 从独立第三方 API 注册表选择 Responses 接口。识别结果作为标明来源的不可信
文字资料进入当前 DeepSeek Thread。

固定模式下，DeepSeek 代理服务于主 App Server；切换模式按需启动，若共享 `agents.external`
当前选择 DeepSeek，则随服务预先启动统计代理。代理支持项目当前使用的
HTTP/SSE、Responses WebSocket、压缩和模型目录请求，复用统一网络代理，并保留用户已有的
`openai_base_url` 上游。认证 Header、请求正文和响应正文只做内存转发，不写入指标或日志。
Gateway 停止或重启时计时指标可能丢失，但模型请求不会因此中断。

## 共享第三方子代理

DeepSeek 与 OpenCode Go 共用 `agents.external`，不按 Provider 注册重复角色。任一模式配置成功后，
Setup 会把该角色切换到刚配置的 Provider 与默认模型；也可以手动选择已配置 Provider 和模型：

```bash
codexc agents configure deepseek deepseek-v4-pro
codexc agents configure opencode-go deepseek-v4-flash
codexc agents status
codexc agents disable
```

角色文件 `~/.codex/sf-agent.config.toml` 只保存 Provider、模型和 `env_key`
引用，不保存 API Key。App Server 服务启动时只为当前角色选择的 Provider 启动统计代理并刷新本机
地址；未选作子代理且尚未用于会话的第三方 Provider 不增加进程。认证密钥只进入 App Server
子进程环境。

该角色是 V2 单次子代理：主模型必须使用 `agent_type="external"` 和 `fork_turns="1"`，任务必须在
当前用户消息中完整给出。它不等待后续消息，也不调用子代理通信工具；需要多轮协作时使用 OpenAI
官方子代理。

子代理统计会在指标库中标注：Gateway 捕获父线程里的 `subAgentActivity` 通知后，把子代理
线程 ID 和代理路径写入 `subagent_threads` 表，`codexc metrics threads` 与 WebUI Threads
页面显示“子代理 · <代理路径>”。该标注需要指标库 Schema v7 及以上（当前 v9）；从本机终端
运行 `codexc update` 会统一预检、自动备份升级并恢复 App Server 与 Gateway，也可单独运行
`codexc metrics upgrade`。

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
