# OpenCode Go

Codex Connect 可把 OpenCode Go 作为独立第三方 Provider 使用，并支持在同一 Gateway 内配置多个
OpenCode Go 账户（各自 Key、各自套餐额度）。当前官方目录中的模型为 `deepseek-flash` 和
`deepseek-v4-pro`；它们与 DeepSeek 官方 Provider 的同名模型仍是独立选项，分别使用各自的
API Key、上游地址与 Thread 路由。目录保留 DS 原有模型，并复制 Flash 的完整内容增加
`DeepSeek V4.1 Flash`（`deepseek-v4.1-flash`），仅修改模型 ID 与显示名。
映射参数位于 [`provider-model-catalog.json`](../provider-model-catalog.json)，DS 自身的目录不增加该条目。
ID 已由 [OCG 公开模型目录](https://opencode.ai/zen/go/v1/models) 确认；能力字段按 Flash 复用，
尚未完成 4.1 的真实 API 联调。DeepSeek 下线的旧模型名不会出现在 `/model` 与 Setup 选项中。

## 配置与使用

运行 `codexc setup`，依次选择“模型与提供商 → 第三方 Provider → OpenCode Go 官方”，或直接使用账户命令：

```bash
codexc provider opencode-go add <id>      # 新增账户（交互输入邮箱或手机号、Key）
codexc provider opencode-go list          # 列出账户与默认标记
codexc provider opencode-go list --json   # 以 JSON 输出账户状态（不含凭据）
codexc provider opencode-go remove <id>   # 备份后删除账户
codexc provider opencode-go default <id>  # 设置新会话默认账户
codexc provider opencode-go release <id>     # 立即释放该账户隔离 App Server
```

首次和后续添加都必须输入账户 ID。Provider 使用 `ocg-<accountId>` 命名，切换账户（包括首个和
默认账户）拥有独立的私有 Profile（Unix `0600`，Windows 私有 ACL）
`~/.codex/sf-ocg-<accountId>.config.toml`。默认账户只由注册表的 `default: true` 标记决定，不使用
固定的 `main` ID；切换 Key 只进入该 Profile 与对应 App Server 子进程环境，固定 Key 使用[独立私有版本与主配置 `env_key` 引用](provider-integration-guide.md#4-安全边界)，不进入注册表、共享主配置或日志。添加账户时必须输入邮箱或手机号码（二选一）；联系方式只用于本机展示，不参与 CLI Provider 路由。共用模型目录 `models.json` 和来源文件 `models.manifest.json` 位于 `~/.codex-connect/providers/opencode-go/`，各账户管理标记位于
`~/.codex-connect/providers/opencode-go/ocg-<accountId>/`。首个账户也可通过 Setup 选择保留 OpenAI 默认的
切换模式，或让原生 Codex 和 Gateway 默认使用 OpenCode Go 的固定模式；固定模式会先备份再修改
`~/.codex/config.toml`。同一时刻只允许一个固定主 Provider；一个 OCG 账户处于固定模式时，其他
OCG 账户仍可保留切换模式。切换账户每次进入固定模式都会以当时主配置更新该账户的恢复基线，旧基线
按 UUID 归档；固定模式内重新配置继续使用本次进入时的基线。账户基线缺失时明确报错，不读取共享旧备份代替。
如果 `~/.codex/config.toml` 已存在手工配置的同名 Provider 或 Profile，
会明确拒绝，不会覆盖用户配置。

仅支持当前多账户格式，删除账户使用 `codexc provider opencode-go remove <accountId>`。
命令先预览并要求确认，再停止对应实例并清理配置；保留其他账户、备份和历史统计。
固定模式只恢复受管主配置字段，不恢复或删除无关子代理；删除时清理该账户配置与管理标记，保留共用模型目录和来源文件。

配置完成后运行：

```bash
codexc restart all
```

初次配置默认使用官方目录的默认模型 `deepseek-flash`。需要调整时，在 `codexc setup` 中选择“模型与提供商 → 第三方 Provider → OpenCode Go 官方 →
修改模型设置（思考等级）”，或选择“模型与提供商 → 第三方 Provider → 默认模型与思考等级 → OpenCode Go”，
选择准确账户后按模型设置默认思考等级，所有选择该模型的账户 Profile 同步该等级，原生子代理保留独立设置；目录刷新保留共用模型的有效等级。上下文窗口走“模型与提供商 → 第三方 Provider → 模型上下文窗口”，按提供商和模型通过 Token 预设或自定义输入设置。
账户独立选择默认模型；思考等级、上下文和启用名单保存在共用的 `providers/opencode-go/models.json`，影响所有 OCG 账户，不影响其他提供商。新默认值只影响之后的新会话，恢复历史 Thread
仍使用原模型。新增 OCG 模型目录使用其官方模板窗口，显式模板更新保留共用目录中已有模型的窗口 Token 数。
若新模板的最大窗口小于现有 Token 数，则拒绝刷新并保留原目录，需先调整窗口。重复运行 Setup 和更新 Key 会保留现有目录，不再隐式下载覆盖；更新器不刷新模型目录。
配置账户后，通过“发现／添加共享模型”手填该上游实际提供的 Responses 模型，或显式发现／导入 DS 新模型。模板仍从 DS 官方脚本下载并保留 OCG ID 映射，不取其他账户目录。手填须确认准确 ID 和能力，新模型复用通用编程提示词；共用目录最多启用 64 个模型，所有账户的默认模型均受保护。发现只添加新项，保留已有条目；移除及更新已有模型分别使用统一模型管理的本地移除与模板对比入口。保存前备份目录及来源文件为同目录 `.backup` 并进行并发检查和事务写入，来源标记为用户配置；失败保留原目录。显式创建或更新时补全缺失的基础提示词并固化，读取不注入新模板。手工回退须先停止使用目录的客户端和相关服务，成对恢复最近一次备份后重启。此入口不意味着上游支持任意第三方模型，也不会改成 Chat 协议。

当前版本只接受提供商共用模型目录和家族下完整账户 ID 的身份材料路径；旧账户布局及未完成的历史目录迁移会被拒绝。保留文件、备份及标记，按[当前目录布局与旧版本恢复](provider-integration-guide.md#当前目录布局与旧版本恢复)使用对应旧版本处理；升级不迁移真实用户目录。

修改后 Gateway 会自动检测并校验设置文件，只更新受影响且已启用的 Provider 实例；原生客户端
租约或活动 Thread 会推迟应用，其他 Provider 继续运行。连接、绑定与模型目录恢复后才提示生效，
失败保留待应用状态。手动运行 `codexc restart appserver` 会重启整个共享服务。

聊天中使用 `/model` 选择带 `ocg-<邮箱或手机号>`（无联系方式时回退为 `ocg-<accountId>`）前缀的模型；同账户内切换模型不新建 Thread，
跨账户切换会保留并解绑当前 Thread，下一条消息以目标账户默认模型新建 Thread（不复制历史），
仍存在的旧 Thread 可通过 `/resume` 恢复；已删除账户或无法映射到现有 Provider 的旧 Thread 不保证可恢复。终端共享会话使用：

```bash
codexc remote -p ocg-<账户>              # 任一已配置的切换账户
```

Desktop 使用 `codexc app -p ocg-<账户>`。两个入口也接受已登记的 `sf-ocg-<账户>` Profile 名，
Remote 保留 `--profile sf-ocg-<账户>`；两个入口默认连接主实例，不采用渠道的默认账户选择。

每个 OpenCode Go 账户使用独立统计代理；账户的隔离 App Server 按需启动。服务启动时只登记配置，首次选择对应账户模型、恢复对应 Thread 或使用对应 Remote TUI 时，
App Server 监管进程才启动该账户的隔离实例。账户 App Server 的 `base_url` 带
`/go/<账户>` 前缀；该代理只允许自身绑定的唯一账户，转发时剥离前缀并向该账户上报指标，其他账户前缀明确拒绝。

Gateway 的全局空闲策略统一关闭已连接的 Provider Client：当没有任何前台或后台 Conversation 绑定、
进行中的 Provider 操作或启动任务时，先等待 60 秒；期间新消息或恢复 Thread 会取消本轮释放。宽限期
结束仍满足条件时，只有渠道会话自动解除触发的全局释放轮次会先向所有已知授权渠道发送一次释放通知，
再关闭全部已连接 Provider Client，并停止未被租约占用的 App Server 进程（含主实例）；其他无绑定
关闭不发送该通知。该操作不按账户类型区分；再次选择账户、恢复 Thread 或使用对应 Remote TUI 时，
Supervisor 会按需重新启动实例。
`codexc remote` 仍通过 Supervisor 租约保持其 App Server 进程可用；
`codexc provider opencode-go release <id>` 继续用于手动停止账户隔离 App Server。

## 协议与模型范围

OpenCode Go 的基础地址为 `https://opencode.ai/zen/go/v1`。本项目使用 Codex App Server 的
Responses Provider 配置；`deepseek-flash` 声明文字和图片输入，新增的
`deepseek-v4.1-flash` 复制其完整能力字段，本次未验证该独立模型 ID 的真实流式请求和工具调用。官方 Go
页面列出的其他模型使用多种端点协议，不能只因为出现在官方页面或 `/models` 中就自动开放；可选模型
以 DS 基础内容和显式 V4.1 扩展生成的目录为准；官方页面新增但未写入该目录的模型不开放。

OpenCode Go 已接入独立账户用量接口：当前 Thread 使用 OpenCode Go 时，`/usage` 会实时通过官方
`GET /zen/go/v1/usage` 查询 5 小时（$12）、7 天（$30）和月度（$60）三个配额窗口的已用百分比与
重置时间，并在每个窗口旁展示本机指标库按请求归属窗口归集的本地 Token 用量（非官方账单）。

官方用量接口明确返回缺少订阅权益时，查询会提示“无有效订阅”；该状态可能是订阅到期或尚未开通，
不能仅由额度重置时间推断。渠道 `/usage`、启动预热与 WebUI 查询会将明确结果保存到共享快照；
网络失败保留最后确认状态，续订后成功查询额度才更新为正常结果。已确认无有效订阅的账户不进入
渠道 `/model` 提供商和模型可选列表，也不能手动指定选择；续订后在 WebUI 或对应会话的 `/usage`
成功刷新额度即可恢复，无需重启 Gateway。未查询或普通网络失败不直接判定过期。
该筛选不取消已有 Turn、不自动切换当前模型，也不在统计代理层拦截请求。
Telegram 菜单因订阅状态变化而改变时，旧按钮会提示重新发送 `/model`，不会选到新的同序号账户或模型。
WebUI 区分此状态与普通刷新失败，并提供经过预览确认的本地账户删除入口，
详见[WebUI 账户展示](webui.md)。
本地 Token 与官方窗口使用同一周期口径：统计代理在每个模型请求发生时把官方三个窗口的
`resetsAt` 快照写入指标记录的 `quota_windows`。5 小时滚动窗口的 `resetsAt` 会随实时查询漂移，读取时只按当前
`resetsAt` 反推的五小时范围和请求开始时间归集，不把重置秒数当作固定周期 ID。7 天和月度窗口
优先按记录的固定周期快照归属 Token；快照缺失，或快照的重置时间不晚于请求开始时间（请求开始时
缓存已过期）时，按请求开始时间归集。请求开始时仍有效但属于其他固定周期的快照继续排除，避免
跨重置点完成的旧请求混入新周期。7 天窗口按官方 `resetsAt` 反推窗口起点、终点取
`min(now, resetsAt)`，月度窗口由官方 `resetsAt` 倒推开始时间；官方未返回 `resetsAt` 时才回退到
最近 5 小时 / 7 天的固定滚动区间。窗口快照按最早 `resetsAt` 失效前复用，不重复请求官方接口；
快照获取失败时短时退避缓存后重试，账户展示的百分比与重置时间始终实时查询、不回退或缓存。
凭据按当前 Thread 的 `modelProvider` 读取对应账户的私有 Profile
（固定基础配置或切换 Profile），未配置、网络失败或官方
响应无效时明确显示查询失败，不回退或缓存；本地 Token 只按本机指标库重算，不是官方
账单，指标库不可用或没有本地请求时该段不展示。Thread Token、请求速度和本机请求指标仍正常记录；
WebUI 控制台在 DeepSeek 余额卡旁按账户分别展示官方配额窗口（每个已配置账户一张卡），不展示
本地 Token 明细。官方用量接口或本地指标不可用时，对应信息自动省略。

### 能力边界

- `deepseek-flash` 声明文字和图片输入，图片按官方规则折算为输入 Token；`deepseek-v4-pro` 只声明
  文字输入。文字模型收到图片或音频时，Gateway 会在 Turn 前拒绝；官方目录中的模型目前都不声明音频输入。
- OpenCode Go 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。
- 原生网页搜索按 OCG 共用目录中的精确模型声明放行，不从 DS 来源模板推断支持。
  固定、切换和聚合复用该策略；普通函数及 MCP 工具不受影响，见 [网页搜索边界](deepseek.md#网页搜索)。
- 当前按 HTTP/SSE 接入（`supports_websockets = false`），流式文本、工具调用和上下文压缩走
  HTTP/SSE，不建立 Responses WebSocket。
- Setup 对 API Key 只校验格式；官方账户额度由接入后的 `/usage` 查询；首次请求失败时从模型指标和日志中
  查看错误分类。
- 所有账户 id 都由添加时明确输入，使用小写字母/数字/`-`/`_`（1–32 位），不允许与现有
  Provider id 冲突；CLI 和 Thread 一律使用 `ocg-<accountId>`，默认账户只使用注册表标记；删除账户前
  会备份 Profile 与账户目录；存在其他账户时必须先把默认标记切换到其他账户，不能由删除操作自动提升；
  删除后该账户历史 Thread 不可恢复；账户命令仅
  清理该账户配置与管理标记，保留共用模型目录和来源记录；固定模式还会恢复安装前的 Codex 主配置。删除后重启 Gateway 会自动解绑已删除账户的
  外部会话；该会话下一条消息会新建 Thread。
- 运行统计与 DeepSeek 一致：完成卡片展示请求结果、Token、缓存与压缩摘要，并在官方
  `Turn.durationMs` 可用时显示本轮总耗时；首 Token 和速度按[完成汇报](display.md#完成汇报)的汇总口径展示；
  `/usage` 展示官方配额窗口与本机 Token 用量，见上文。

官方来源：[`OpenCode Go`](https://opencode.ai/docs/go/)。
