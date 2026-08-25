# OpenCode Go

Codex Connect 可把 OpenCode Go 作为独立第三方 Provider 使用，并支持在同一 Gateway 内配置多个
OpenCode Go 账户（各自 Key、各自套餐额度）。当前受控模型为 `deepseek-v4-flash`、
`deepseek-v4-flash-vision-exp` 和 `deepseek-v4-pro`；它们与 DeepSeek 官方 Provider 的同名模型仍是独立选项，分别使用各自的
API Key、上游地址、Thread 路由和价格来源。

## 配置与使用

运行 `codexc setup`，依次选择“模型与提供商 → 第三方 → OpenCode Go 官方”，或直接使用账户命令：

```bash
codexc opencode-go account add <id>      # 新增账户（交互输入 Key）
codexc opencode-go account list          # 列出账户与默认标记
codexc opencode-go account list --json   # 以 JSON 输出账户状态（不含凭据）
codexc opencode-go account remove <id>   # 备份后删除账户
codexc opencode-go account default <id>  # 设置新会话默认账户
codexc opencode-go account stop <id>     # 立即释放该账户隔离 App Server
```

默认账户保持旧版 Provider id `opencode-go`（Profile
`~/.codex/sf-opencode-go.config.toml`），旧版单账户配置在 CLI/服务启动时只补账户注册表，
不重命名 Provider、不改写 Profile 与角色文件，因此旧会话、历史统计与 `agents.external`
继续可用，无需手工搬移。新增账户才使用 `opencode-go-<账户>` 命名，每个账户拥有独立的
0600 私有 Profile `~/.codex/sf-opencode-go-<账户>.config.toml`（默认账户保持
`sf-opencode-go.config.toml`），Key 只进入该文件与对应 App Server 子进程环境，
不进入注册表、配置或日志；模型目录与管理标记共享
`~/.codex-connect/providers/opencode-go/`。首个账户也可通过 Setup 选择保留 OpenAI 默认的
切换模式，或让原生 Codex 和 Gateway 默认使用 OpenCode Go 的固定模式；固定模式会先备份再修改
`~/.codex/config.toml`。如果 `~/.codex/config.toml` 已存在手工配置的同名 Provider 或 Profile，
会明确拒绝，不会覆盖用户配置。

早期多账户预发布版本曾把默认账户命名为 `opencode-go-main`。升级时，受管切换模式会保留
`main` 账户及其历史 Thread 路由，并从同一私有 Profile 创建新的默认 `opencode-go` 账户；已有的
其他账户不变。固定模式不自动转换，避免在没有可并行账户的配置中覆盖主 Provider。

配置完成后运行：

```bash
codexc service restart all
```

初次配置默认使用 Flash Vision Exp。需要调整时，在 `codexc setup` 中选择“模型与提供商 → 第三方 → OpenCode Go 官方 →
修改模型设置（思考等级、自动压缩）”，或走原有的“模型与提供商 → 第三方 → 第三方模型设置 → OpenCode Go”，
再按模型设置默认思考等级和自动压缩百分比；每个模型按自己的上下文窗口计算
阈值，不影响另一个模型或 DeepSeek 官方 Provider。新默认值只影响之后的新会话，恢复历史 Thread
仍使用原模型。重复运行 Setup 会保留仍受支持的默认模型及逐模型设置；`codexc update` 刷新目录时，
首次升级时仍选择旧默认 Flash 的账户和对应共享子代理会自动切换到 Flash Vision Exp，已主动选择
Pro 的账户保持不变；清单记录迁移完成后，用户再主动选回 Flash 也不会被后续更新覆盖。目录更新后
的压缩阈值按原百分比和新上下文窗口重新计算。修改后 Gateway 会自动检测设置文件变化，校验通过并在无活动 Turn
时自动重启 App Server 生效；如需立即生效，可在终端手动运行 `codexc service restart app-server`。

聊天中使用 `/model` 选择带“OpenCode Go（账户）”前缀的模型；同账户内切换模型不新建 Thread，
跨账户切换会保留并解绑当前 Thread，下一条消息以目标账户默认模型新建 Thread（不复制历史），
旧 Thread 仍可通过 `/resume` 恢复。终端共享会话使用：

```bash
codexc remote --profile opencode-go            # 默认账户
codexc remote --profile opencode-go-<账户>      # 新增账户
```

所有 OpenCode Go 账户共享同一个统计代理（不随账户数量增长）；每个账户的隔离 App Server 按需
启动。服务启动时只登记配置，首次选择对应账户模型、恢复对应 Thread 或使用对应 Remote TUI 时，
App Server 监管进程才启动该账户的隔离实例；账户 App Server 的 `base_url` 指向共享代理并带
`/go/<账户>` 前缀，代理按前缀区分账户、转发时剥离前缀并按账户分开上报指标。当前被
`agents.external` 选择的默认账户会预先启动共享统计代理，确保子代理随主 App Server 可用；未使用
也未选作子代理的账户不增加进程。

账户的隔离 App Server 在无 Conversation 绑定、不是 `agents.external` 默认账户、Gateway 最近没有
观察到 Turn 活动且没有受管 Remote TUI 租约的状态下空闲超过 5 分钟，会自动释放并移除启动记录；
释放后向最近使用过该账户的渠道会话通知一次，再次选择账户、恢复 Thread 或使用对应 Remote TUI
时会自动拉起。`codexc remote` 在 TUI 运行期间持有 Supervisor 租约，避免实例被自动释放；也可用
`codexc opencode-go account stop <id>` 手动释放，存在 Remote TUI 租约时会拒绝并提示退出 TUI。
统计代理始终共享一个，不参与账户释放。

## 协议与模型范围

OpenCode Go 的基础地址为 `https://opencode.ai/zen/go/v1`。本项目使用 Codex App Server 的
Responses Provider 配置；当前 Flash/Pro 已通过 `/responses` 流式文本和工具调用实测，Vision Exp
复用同一 Chat Completions 兼容端点并声明文字和图片输入。官方 Go
页面列出的其他模型使用多种端点协议，不能只因为出现在价格页或 `/models` 中就自动开放；每个新
模型仍需确认 Codex Responses 兼容性、模型目录字段和真实工具合同后加入编译期受控列表。

OpenCode Go 已接入独立账户用量接口：当前 Thread 使用 OpenCode Go 时，`/usage` 会实时通过官方
`GET /zen/go/v1/usage` 查询 5 小时（$12）、7 天（$30）和月度（$60）三个配额窗口的已用百分比与
重置时间，并在每个窗口旁展示本机指标库按请求归属窗口归集的本地 Token 用量（非官方账单）。
本地 Token 与官方窗口使用同一周期口径：统计代理在每个模型请求发生时把官方三个窗口的
`resetsAt` 快照写入指标记录（Schema v9 新增 `quota_windows` 列；当前指标库 Schema v10 另保存子代理
父 Turn 关联），读取时优先按记录的
窗口快照归属 Token；记录缺失或快照与当前官方窗口不一致时才按时间回退——5 小时和 7 天窗口按
官方 `resetsAt` 反推窗口起点（`resetsAt - 窗口时长`）、终点取 `min(now, resetsAt)`，月度窗口
继续由官方 `resetsAt` 倒推开始时间，官方未返回 `resetsAt` 时才回退到最近 5 小时 / 7 天的固定
滚动区间。窗口快照按最早 `resetsAt` 失效前复用，不重复请求官方接口；快照获取失败时短时退避
缓存后重试，账户展示的百分比与金额始终实时查询、不回退或缓存。
同时在窗口下方展示模型本地用量估算：按本机指标库汇总当前官方月度窗口内的请求（窗口按请求
记录的官方快照归属，缺失时由官方 `resetsAt` 倒推开始时间），用当前官方价格基线按每个请求的
开始时间重新计价（峰谷价格自动对齐）；价格更新生效时间（基线 `sourceUpdatedAt`）之前的请求
使用当时保存的价格快照，之后的请求按当前基线重算；请求档位优先沿用当时保存的价格快照
（`pricing_bucket`），快照缺失时才按当前基线判定，官方调整峰谷时段不会让历史请求漂移。
合计每个模型的已用金额，对照官方价格基线里的模型包含用量（如 DeepSeek V4 Flash 每月 $30、
V4 Pro 每月 $15）计算已用百分比与剩余额度；官方表格
把 DeepSeek 按 Off-Peak / Peak 拆成两行、各自包含对应额度（Flash $30、Pro $15），本地估算也按请求开始时间分档分别展示
两行，其余模型仍按单档展示。凭据按当前 Thread 的 `modelProvider` 读取对应账户的私有 Profile
（固定基础配置或切换 Profile），未配置、网络失败或官方
响应无效时明确显示查询失败，不回退或缓存；模型本地用量只按本机指标库重算，不是官方
账单，指标库不可用或没有本地请求时该段不展示。Thread Token、请求速度和本机请求指标仍正常记录；
WebUI 控制台在 DeepSeek 余额卡旁按账户分别展示同样的配额窗口与模型本地用量（每个已配置账户
一张卡）。OpenCode Go Thread 的
Turn 完成通知也会在“账户状态”区附带当前模型剩余用量（同一口径，DeepSeek 按该 Turn 最后一次
模型请求开始时间的峰谷档位），官方用量接口或本地指标不可用时自动省略。

### 能力边界

- Vision Exp 声明文字和图片输入，图片按官方规则折算为输入 Token；Flash/Pro 只声明文字输入。
  文字模型收到图片或音频时，Gateway 会在 Turn 前拒绝；音频目前没有受控模型支持。
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
- 默认账户固定为 `opencode-go`；其他账户 id 使用小写字母/数字/`-`/`_`
  （1–32 位），不允许与现有 Provider id 冲突；删除账户前
  会备份 Profile 与账户目录，删除后该账户历史 Thread 不可恢复；最后一个账户不可通过
  账户命令删除，需在 Setup 中选择恢复配置。删除后重启 Gateway 会自动解绑已删除账户的
  外部会话；该会话下一条消息会新建 Thread。
- 运行统计与 DeepSeek 一致：调试模式展示最后一次请求的可观测首事件延迟，完成卡片展示整轮
  综合思考速度与含推理生成速度；`/usage` 展示官方配额窗口与模型本地用量，见上文。

## 价格维护

运行时价格来自随包发布的 `runtime/opencode-go-pricing-baseline.json`，与 DeepSeek 官方人民币峰谷
价格完全隔离。基线（Schema v3）保存 OpenCode Go 官方页面列出的全部模型美元 Token 单价、
Peak/Off-Peak 时段（UTC）、长上下文档位、套餐包含用量、端点和 SDK 协议；官方限时免费且未给出
Token 单价的模型记录为 `limited-free`，不伪造零价或套餐额度。只有当前受控模型会
进入实际请求计价。DeepSeek V4 Pro/Flash 按官方时段（01:00–04:00 与 06:00–10:00 UTC）在请求
开始时选择忙时价或闲时价，其中 Vision Exp 的套餐包含用量为每月 $15；其余模型按单档或上下文
分档计价。维护基线时必须同时核对官方端点、协议和时段，避免只更新价格而遗漏兼容性复核。
套餐包含用量用于 `/usage` 模型本地用量展示与人工复核，不参与单次请求的参考费用计算。

价格变化由维护者人工对照官方页面更新基线并审查全部模型、时段、长上下文档位、套餐包含用量、
端点和 SDK 协议；新模型仍须加入编译期受控定义并通过测试后才能开放。只有官方整行 Token 单价与
套餐额度均为 `-` 时才记录为限时免费状态。

官方来源：[`OpenCode Go`](https://opencode.ai/docs/go/)。
