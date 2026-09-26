# DeepSeek 多账户

DeepSeek 账户使用独立 API Key、Profile 和按需启动的 App Server。同一批 DS 账户共用
DS 官方模型目录，OCG、CCG 的目录及增量模型保持独立，DS 不增加 V4.1 条目。

## 配置与移除

在 `codexc setup → 模型与提供商 → 第三方 Provider → DeepSeek 官方` 管理账户，
也可在 WebUI 账户设置中操作，或使用以下命令：

```bash
codexc deepseek legacy remove              # 确认后移除旧单账户，再重新添加
codexc deepseek account add work           # 新增账户，交互输入模式和 Key
codexc deepseek account reconfigure work   # 重新配置已有账户
codexc deepseek account list --json        # 列出账户与默认标记，不包含 Key
codexc deepseek account default work       # 选择默认账户
codexc deepseek account remove personal    # 确认后删除账户配置
codexc service restart all                 # 应用配置变化
```

账户 ID 必须由用户填写，使用 1–32 位小写字母、数字、`-` 或 `_`，不自动创建 `main`。
首个账户标记为默认，后续可手动修改。不同 ID 不能生成相同的凭据环境变量名。
旧单账户不再迁移。已有配置保持原样，需先运行 `codexc deepseek legacy remove`，
确认移除旧 Key、Profile 和管理标记后，再使用明确账户 ID 重新添加。
固定模式只恢复该 Provider 管理的主配置字段；安装前备份和历史统计保留。
Remote TUI 正在使用旧实例时，需先退出。
旧配置与新账户并存时，移除旧账户保留现有注册表、账户文件和共享模型目录。
必要恢复备份缺失时明确报错，写入失败会回滚本次文件变更。

更新器不处理旧 DS 配置，不移动文件或改写账户身份。
旧 Thread 的 `deepseek` 身份不改写，也不保证继续恢复；历史指标仍在 `deepseek` 名下查询，
新请求按 `ds-<账户>` 统计。

## 文件与运行模式

| 文件 | 用途 |
| --- | --- |
| `~/.codex-connect/providers/deepseek/accounts.json` | 账户 ID 与默认标记，不含凭据 |
| `~/.codex/sf-ds-<账户>.config.toml` | 切换账户的模型、Provider 与私有 Key |
| `~/.codex-connect/providers/deepseek/accounts/<账户>/managed.toml` | 账户运行模式 |
| `~/.codex-connect/providers/deepseek/accounts/<账户>/backup/config.json` | 本次安装前的基础配置 |
| `~/.codex-connect/providers/deepseek/models.json` | 全部 DS 账户共用的官方模型目录 |
| `~/.codex-connect/providers/deepseek/models.manifest.json` | 目录来源和更新时间 |

切换模式保留 OpenAI 主配置，每个账户使用独立私有 Profile；固定模式在确认后修改 Codex
主配置，同一时刻只能有一个固定主 Provider。账户 Key 保存在 0600 私有配置中，仅进入目标
App Server 子进程，不进入账户注册表、命令行或日志。

删除账户保留历史统计和备份；仍有账户时保留共享模型目录，删除最后一个账户时清理目录。删除前检查并停止对应 App Server；Remote TUI
正在占用、监管状态异常或停止失败时，不删除账户文件。删除后该账户历史 Thread 将不可恢复。
若 RS 模型仍跟随 DS 上下文，删除最后一个账户前须先在 RS 设置关闭跟随；预览会列出阻止删除的 RS 提供商。
删除默认账户前需先选择其他默认账户；删除最后一个账户无需选择。
原生子代理继承父线程的 Provider，不独立绑定账户。固定账户删除或改为切换模式时
仅恢复受管 Provider 字段，保留其他主配置修改。删除后重新添加会建立新的恢复基线，旧备份归档保留。
切换账户每次进入固定模式时都会以当时主配置更新该账户的恢复基线，并把旧基线归档；固定模式内
重新配置继续使用本次进入时的基线。同一时刻仍只允许一个固定主 Provider，其他 DS 账户可保持切换模式。

## 模型与设置

DS 目录从官方安装脚本提取，不执行下载脚本。当前目录为 `deepseek-flash` 与
`deepseek-v4-pro`；实际选项以下载目录为准。新增账户复用已有 DS 目录，首次配置才下载；
模型目录由 Setup 配置，更新器不刷新目录。
已下线模型会切到目录默认模型，同时更新对应账户配置。
导入 DS 模板到自定义 Responses 或 CLP 时，目录自带的提示词（`model_messages.instructions_template`）随模型定义携带；deprecated 的顶层 `base_instructions` 只是旧客户端镜像，不单独保留。

通过账户菜单选择默认模型和思考等级，通过“模型上下文窗口”按模型名设置窗口比例。
账户分别选择默认模型；思考等级、上下文和能力字段存放在共享目录，同一模型的这些设置会影响
所有 DS 账户。切换 Profile 同步目录默认思考等级；原生角色独立保存自己的思考等级，目录更新不覆盖角色选择。
压缩使用上游默认，不写入独立自动压缩阈值。

切换账户的共享终端入口：

```bash
codexc remote --profile sf-ds-personal
```

聊天使用 `/model` 选择 `DS <账户>` 下的模型。同账户切模型保持 Thread，跨账户选择会保留并
解绑旧 Thread，下一条消息在目标账户新建 Thread，不复制历史。每个账户的 App Server 按需启动，
DS 账户共用一个统计代理，通过内部账户路径区分请求并上报到各账户指标 Socket。

## 网页搜索

DeepSeek（官方目录中的模型 + Codex 0.154.0）支持网页搜索，且不依赖 OpenAI：

- DeepSeek API 会向模型提供名为 `search` 的搜索工具；Codex 侧统一以 `web_search` item
  回传（`query`、`action` 和结构化 `results`）。实测能返回带标题、URL、摘要和发布日期的
  真实网页结果。
- 该搜索是 DeepSeek API 自身的能力，不调用 OpenAI 的 `/v1/alpha/search`；本机是否存在
  OpenAI 登录不影响 DeepSeek 搜索。Codex 的独立搜索扩展 `web.run` 不适用于 DeepSeek
  （DeepSeek 没有 `/alpha/search` 端点，也未声明 `supports_standalone_web_search`）。
- 网关链路无需额外配置：搜索请求包含在 `/responses` 模型请求内，经本地 Provider 代理
  原样透传；会话事件里出现 `web_search` item 即表示模型真的调用了搜索。
- 计费与统计：搜索是模型请求的一部分，按 DeepSeek API 用量计费，计入请求次数与 Token
  统计；不消耗 OpenAI 额度。
- 验证方式：直接让 DeepSeek 会话执行搜索任务，观察事件日志；或运行
  `codex exec -p sf-ds-<账户> -C <工作目录> --skip-git-repo-check "请搜索……"` 直连测试。
- 失效边界：若 DeepSeek API 对该模型关闭搜索、上游工具名称或响应结构变化，或网关代理
  不再透传搜索工具，则搜索不可用；当前不支持把 DeepSeek 搜索路由到 OpenAI 官方搜索。

## App Server 与 Thread

切换模式由同一个后台服务监管 OpenAI 主 App Server 和各账户隔离的 App Server。服务启动时只
启动主实例；原生子代理复用父线程所在 Provider 实例。首次选择 DeepSeek 模型、
恢复其 Thread 或使用 DeepSeek Remote TUI 时，监管入口才读取并校验私有 Profile，按需启动隔离
App Server。该账户 API Key 只进入需要它的 App Server 子进程环境，不进入命令行、服务定义或
日志；其他 Provider 的 Key 不会随之注入。

Gateway 根据 Thread 的 `modelProvider` 路由新建、恢复、Turn、Review、Goal、MCP 和审批请求。
跨 Provider 不能原地修改正在使用的 Thread，因此 `/model` 的跨 Provider 选择会：

1. 保留并解绑当前 Thread。
2. 在下一条消息中为目标 Provider 新建 Thread。
3. 不复制可能包含 Provider 专属 reasoning、工具结果或加密内容的历史。

同一账户的 Thread 仍可通过 `/resume` 恢复，旧单账户的 `deepseek` Thread 不再接续。同一 Provider 内切换模型时不新建 Thread，选择在下一次 Turn
生效。切换 Workspace、新会话或同 Provider 历史 Thread 时，渠道会在内存中保留当前模型、思考
等级和服务层级并用于下一 Turn。切换 Workspace 后下一条消息会新建 Thread，不自动接续目标 Workspace 的历史
Thread；显式恢复不同 Provider 的历史 Thread 时尊重该 Thread 的 Provider。
跨 Provider 新建 Thread 使用目标模型目录的默认思考等级；当前 DeepSeek 默认是 `high`。

任一 Provider 意外断开时，Gateway 只重连并恢复该侧绑定。任一受监管 App Server 子进程异常退出
时，App Server 服务会共同重建受监管实例；Gateway 全局空闲策略关闭 Client 不属于异常退出，
不会触发共同重建。

## 用量与运行统计

- `/status` 的 Token、有效上下文窗口、缓存和压缩次数来自当前 Thread，不代表账户余额。
- Turn 完成摘要按同一 Turn 的全部模型请求聚合请求结果、Token、缓存命中与压缩摘要，并在官方
  `Turn.durationMs` 可用时显示本轮总耗时；不展示模型请求聚合耗时、首段回复延迟或生成速度，也不再
  为这些输出追踪文本、函数调用参数和自定义工具参数增量时间。
- 官方返回的推理 Token 计数仍与所有 Provider 一样展示；Gateway 不读取或保存推理内容。
- OpenAI Fast 和周限不会显示在 DeepSeek Thread 上。
- `/usage` 在 OpenAI Thread 中显示 Codex Token 汇总，在 DeepSeek Thread 中调用官方余额接口。
- WebUI 控制台按 `ds-<账户>` 分别展示余额并逐账户刷新；默认标记来自 DS 注册表。
- `/metrics` 从独立指标库读取当前 Thread 最近 Turn 和整个 Thread 的请求累计；输入量是多次请求的
  累计值，不表示当前上下文占用。`/metrics providers|models|errors 24h|7d|30d|90d|all` 按统一口径聚合，
  不为 DeepSeek 建立专属统计表。Gateway 不在本地计算或估算 DeepSeek 价格与费用，`/metrics` 只展示
  请求、Token、异常和官方账户数据。
- `/limits` 当前只支持 OpenAI；DeepSeek 不会回退显示 OpenAI 限额。
- DeepSeek 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。

## 推理历史回传

DeepSeek 官方账户使用原生 Responses API。Gateway 代理透传请求和响应，由 Codex 保存并在工具续跑及后续用户轮次的 `input` 中带回 `reasoning.content`，无需转换成 Chat 字段。
官方 [Responses 说明](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)以 `reasoning_text` 正文承载推理，不接受以 `summary` 或 `encrypted_content` 替代。
官方 [思考模式说明](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)中的 `reasoning_content` 要求针对 Chat API：携带 `tools` 时必须回传历史各轮推理，没有 `tools` 时该字段会被忽略。
CLP 的 Chat 转换和字段保留方式见 [Cline Pass](cline-pass.md)。本地压缩之后，以 Codex 实际保留的上下文为准，Gateway 不另存历史或补造已丢弃的推理。

## 图片识别

`deepseek-flash` 原生接受当前渠道校验后的 PNG/JPEG/WebP/非动画 GIF 图片，并通过现有 App Server
Turn 输入处理；项目仍采用更严格的最多四张、单张 10 MiB、整批 20 MiB 边界，不开放图片 URL、
Files API 或其他图片入口。图片 Token 由 DeepSeek 按尺寸换算并随标准 Usage 返回，Gateway
继续使用上游 Usage 统计，不自行按像素估算。

Pro 仍为文字模型，收到图片时会在 Turn 前明确拒绝；需要看图时使用 `/model` 切换到
`deepseek-flash`。Gateway 不再把图片转交给另一套外部视觉 API。

不支持旧版 `[vision]` 配置；更新器不清理旧配置或凭据。

固定模式下，DeepSeek 代理服务于主 App Server；切换模式按需启动。原生子代理复用父线程所在实例与统计代理。代理支持项目当前使用的
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
