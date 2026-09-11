# OpenCode Go

Codex Connect 可把 OpenCode Go 作为独立第三方 Provider 使用，并支持在同一 Gateway 内配置多个
OpenCode Go 账户（各自 Key、各自套餐额度）。当前官方目录中的模型为 `deepseek-flash` 和
`deepseek-v4-pro`；它们与 DeepSeek 官方 Provider 的同名模型仍是独立选项，分别使用各自的
API Key、上游地址与 Thread 路由。可选模型同样以下载的官方目录为准，DeepSeek 下线的
旧模型名不会出现在 `/model` 与 Setup 选项中。

## 配置与使用

运行 `codexc setup`，依次选择“模型与提供商 → 第三方 Provider → OpenCode Go 官方”，或直接使用账户命令：

```bash
codexc opencode-go account add <id>      # 新增账户（交互输入邮箱或手机号、Key）
codexc opencode-go account list          # 列出账户与默认标记
codexc opencode-go account list --json   # 以 JSON 输出账户状态（不含凭据）
codexc opencode-go account remove <id>   # 备份后删除账户
codexc opencode-go account default <id>  # 设置新会话默认账户
codexc opencode-go account stop <id>     # 立即释放该账户隔离 App Server
```

首次和后续添加都必须输入账户 ID。Provider 使用 `ocg-<accountId>` 命名，所有账户（包括首个和
默认账户）都拥有独立的 0600 私有 Profile
`~/.codex/sf-ocg-<accountId>.config.toml`。默认账户只由注册表的 `default: true` 标记决定，不使用
固定的 `main` ID；Key 只进入该 Profile 与对应 App Server 子进程环境，
不进入注册表、配置或日志。添加账户时必须输入邮箱或手机号码（二选一）；联系方式只用于本机展示，不参与 CLI Provider 路由。模型目录与管理标记共享
`~/.codex-connect/providers/opencode-go/`。首个账户也可通过 Setup 选择保留 OpenAI 默认的
切换模式，或让原生 Codex 和 Gateway 默认使用 OpenCode Go 的固定模式；固定模式会先备份再修改
`~/.codex/config.toml`。如果 `~/.codex/config.toml` 已存在手工配置的同名 Provider 或 Profile，
会明确拒绝，不会覆盖用户配置。

已注册的旧账户会迁移到相同账户 ID 的 `ocg-<accountId>` 与
`sf-ocg-<accountId>.config.toml`，并重写其中的 Provider 引用。没有账户 ID 的旧单账户配置不会被
擅自命名为 `main`，需使用明确 ID 重新添加；迁移不会猜测联系方式，后续重新配置账户时可补充邮箱或手机号；旧会话若仍引用已不存在的旧 Provider，则不能保证继续恢复。

配置完成后运行：

```bash
codexc service restart all
```

初次配置默认使用官方目录的默认模型 `deepseek-flash`。需要调整时，在 `codexc setup` 中选择“模型与提供商 → 第三方 Provider → OpenCode Go 官方 →
修改模型设置（思考等级）”，或选择“模型与提供商 → 第三方 Provider → 受管 Provider 模型设置 → OpenCode Go”，
再按模型设置默认思考等级；自动压缩百分比走“模型与提供商 → 第三方 Provider → 模型自动压缩”，按模型名统一设置，
每个模型按自己的上下文窗口计算阈值，不影响另一个模型或 DeepSeek 官方 Provider。新默认值只影响之后的新会话，恢复历史 Thread
仍使用原模型。新增或刷新 OCG 模型目录时会继承 DeepSeek 等已配置 Provider 的同名模型全局压缩值，
不会重新回落到 OCG 默认 60%。重复运行 Setup 会保留仍受支持的默认模型及逐模型设置；`codexc update` 刷新目录时，
所选模型已不在新目录中的账户，以及引用该模型的共享子代理，会切到目录默认模型 `deepseek-flash`，
已选择仍在目录中的 Pro 的账户保持不变；仍存在于目录中的选择不会被后续更新覆盖。目录更新后
的压缩阈值按原百分比和新上下文窗口重新计算。修改后 Gateway 会自动检测设置文件变化，校验通过并在无活动 Turn
时自动重启 App Server 生效；如需立即生效，可在终端手动运行 `codexc service restart app-server`。

设置默认账户不会自动修改 `agents.external`，共享子代理仍使用配置时明确选择的账户；如需切换账户，
请运行 `codexc agents configure ocg-<accountId> <模型>`。

聊天中使用 `/model` 选择带 `ocg-<邮箱或手机号>`（无联系方式时回退为 `ocg-<accountId>`）前缀的模型；同账户内切换模型不新建 Thread，
跨账户切换会保留并解绑当前 Thread，下一条消息以目标账户默认模型新建 Thread（不复制历史），
仍存在的旧 Thread 可通过 `/resume` 恢复；已删除账户或无法映射到现有 Provider 的旧 Thread 不保证可恢复。终端共享会话使用：

```bash
codexc remote --profile sf-ocg-<账户>              # 任一已配置账户
```

所有 OpenCode Go 账户共享同一个统计代理（不随账户数量增长）；每个账户的隔离 App Server 按需
启动。服务启动时只登记配置，首次选择对应账户模型、恢复对应 Thread 或使用对应 Remote TUI 时，
App Server 监管进程才启动该账户的隔离实例；账户 App Server 的 `base_url` 指向共享代理并带
`/go/<账户>` 前缀，代理按前缀区分账户、转发时剥离前缀并按账户分开上报指标。当前被
`agents.external` 选择的账户会预先启动共享统计代理，确保子代理随主 App Server 可用；未使用
也未选作子代理的账户不增加进程。

Gateway 的全局空闲策略统一关闭已连接的 Provider Client：当没有任何前台或后台 Conversation 绑定、
进行中的 Provider 操作或启动任务时，先等待 60 秒；期间新消息或恢复 Thread 会取消本轮释放。宽限期
结束仍满足条件时，只有渠道会话自动解除触发的全局释放轮次会先向所有已知授权渠道发送一次释放通知，
再关闭全部已连接 Provider Client，并停止未被租约占用的 App Server 进程（含主实例）；其他无绑定
关闭不发送该通知。该操作不按账户类型区分；再次选择账户、恢复 Thread 或使用对应 Remote TUI 时，
Supervisor 会按需重新启动实例。
`codexc remote` 仍通过 Supervisor 租约保持其 App Server 进程可用；
`codexc opencode-go account stop <id>` 继续用于手动停止账户隔离 App Server。统计代理始终共享一个。

## 协议与模型范围

OpenCode Go 的基础地址为 `https://opencode.ai/zen/go/v1`。本项目使用 Codex App Server 的
Responses Provider 配置；当前 V4.1 Flash 与 Pro 已通过 `/responses` 流式文本和工具调用实测，
其中 `deepseek-flash` 声明文字和图片输入。官方 Go
页面列出的其他模型使用多种端点协议，不能只因为出现在官方页面或 `/models` 中就自动开放；可选模型
仍以下载的官方目录为准：目录里声明什么就出现在选项中，官方页面新增但未写入该目录的模型不开放。

OpenCode Go 已接入独立账户用量接口：当前 Thread 使用 OpenCode Go 时，`/usage` 会实时通过官方
`GET /zen/go/v1/usage` 查询 5 小时（$12）、7 天（$30）和月度（$60）三个配额窗口的已用百分比与
重置时间，并在每个窗口旁展示本机指标库按请求归属窗口归集的本地 Token 用量（非官方账单）。
本地 Token 与官方窗口使用同一周期口径：统计代理在每个模型请求发生时把官方三个窗口的
`resetsAt` 快照写入指标记录（Schema v9 新增 `quota_windows` 列；当前指标库 Schema v12 另保存子代理
运行级父子 Turn 关联），读取时优先按记录的
窗口快照归属 Token；记录缺失或快照与当前官方窗口不一致时才按时间回退——5 小时和 7 天窗口按
官方 `resetsAt` 反推窗口起点（`resetsAt - 窗口时长`）、终点取 `min(now, resetsAt)`，月度窗口
继续由官方 `resetsAt` 倒推开始时间，官方未返回 `resetsAt` 时才回退到最近 5 小时 / 7 天的固定
滚动区间。窗口快照按最早 `resetsAt` 失效前复用，不重复请求官方接口；快照获取失败时短时退避
缓存后重试，账户展示的百分比与金额始终实时查询、不回退或缓存。
发起的官方配额窗口；同一窗口的本地 Token 按请求记录的官方窗口快照归属，缺失或快照与当前
官方窗口不一致时才按时间回退。凭据按当前 Thread 的 `modelProvider` 读取对应账户的私有 Profile
（固定基础配置或切换 Profile），未配置、网络失败或官方
响应无效时明确显示查询失败，不回退或缓存；本地 Token 只按本机指标库重算，不是官方
账单，指标库不可用或没有本地请求时该段不展示。Thread Token、请求速度和本机请求指标仍正常记录；
WebUI 控制台在 DeepSeek 余额卡旁按账户分别展示官方配额窗口（每个已配置账户一张卡），不展示
本地 Token 明细。官方用量接口或本地指标不可用时，对应信息自动省略。

### 能力边界

- `deepseek-flash` 声明文字和图片输入，图片按官方规则折算为输入 Token；`deepseek-v4-pro` 只声明
  文字输入。文字模型收到图片或音频时，Gateway 会在 Turn 前拒绝；官方目录中的模型目前都不声明音频输入。
- OpenCode Go 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。
- 网页搜索已实测：OpenCode Go 与 DeepSeek 一样通过 `/responses` 提供搜索工具，Codex 侧统一
  以 `web_search` item 回传（`query`、`action` 和结构化 `results`），实测能返回带标题、URL、
  摘要和发布日期的真实网页结果。验证方式：直接让 OpenCode Go 会话执行搜索任务并观察事件日志
  中的 `web_search` item；或运行 `codex exec -p sf-ocg-<账户> -C <工作目录>
  --skip-git-repo-check "请搜索……"` 直连测试。
- 当前按 HTTP/SSE 接入（`supports_websockets = false`），流式文本、工具调用和上下文压缩走
  HTTP/SSE，不建立 Responses WebSocket。
- API Key 没有官方账户接口可用于预检，Setup 只校验格式；首次请求失败时从模型指标和日志中
  查看错误分类。
- 所有账户 id 都由添加时明确输入，使用小写字母/数字/`-`/`_`（1–32 位），不允许与现有
  Provider id 冲突；CLI 和 Thread 一律使用 `ocg-<accountId>`，默认账户只使用注册表标记；删除账户前
  会备份 Profile 与账户目录，删除后该账户历史 Thread 不可恢复；删除最后一个账户时账户命令会
  直接清理共享模型目录，固定模式还会恢复安装前的 Codex 主配置。删除后重启 Gateway 会自动解绑已删除账户的
  外部会话；该会话下一条消息会新建 Thread。
- 运行统计与 DeepSeek 一致：完成卡片展示请求结果、Token、缓存与压缩摘要，不展示总耗时、首段
  回复延迟或生成速度；`/usage` 展示官方配额窗口与本机 Token 用量，见上文。

官方来源：[`OpenCode Go`](https://opencode.ai/docs/go/)。
