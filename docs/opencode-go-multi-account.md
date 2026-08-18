# OpenCode Go 多账户方案

本方案解决“一个 Gateway 内配置多个 OpenCode Go 账户（各自 Key、各自套餐额度），
会话可切换使用，`/usage` 只展示当前账户”的需求。当前接入方式见
[`OpenCode Go 使用说明`](opencode-go.md) 与
[`第三方模型 Provider 接入指南`](provider-integration-guide.md)。

## 1. 背景与目标

- 当前 OpenCode Go 是单账户假设：一把 Key、一个 Profile、一个统计代理、一个隔离
  App Server，所有使用该渠道的 Thread 共享同一个官方 5h/7d/月配额池。
- 目标：通过 CLI / `codexc setup` 新增多个 GO 账户；`/model` 可切换到不同账户；
  每个账户独立查询官方额度并展示；`/usage` 只看当前 Thread 所属账户。
- 约束：Codex Thread 的 `modelProvider` 创建后不可变（锁定版
  `rust-v0.147.0` 协议只有 `thread/start`、`thread/resume`、`thread/fork` 携带
  `modelProvider`，`thread/settings/update` 不提供模型 Provider 更新）。因此
  “切换账户”只能沿用现有跨 Provider 语义：解绑当前 Thread，下一条消息新建目标
  账户的 Thread，不复制历史。

## 2. 目标架构

把每个 GO 账户建模为一个“受管 Provider 实例”，Provider id 采用
`opencode-go-<accountId>`：

```text
opencode-go-main     现有账户（兼容迁移后的默认账户）
opencode-go-b        新增账户
```

每个实例拥有：

- 独立 Profile（`~/.codex/sf-opencode-go-<account>.config.toml`，0600，只含该账户
  Key）；
- 独立管理标记与账户目录（`~/.codex-connect/providers/opencode-go/accounts/<account>/`）；
- 独立隔离 App Server 子进程（Key 是进程级环境变量，无法在会话内选择）；
- 独立账户适配器（`/usage` 按当前 `modelProvider` 查该账户官方窗口）；
- 共享一份模型目录（`providers/opencode-go/models.json`，模型本身与账户无关）；
- 共享一个统计代理（见第 5 节）。

## 3. 账户存储与注册

账户注册表位于 Gateway 数据目录，不含 Key：

```text
~/.codex-connect/providers/opencode-go/
  models.json / models.manifest.json       共享模型目录
  accounts.json                            账户注册表（id、显示名、默认标记）
  accounts/<account>/managed.toml          账户管理标记（模式、默认模型、思考等级）
  accounts/<account>/backup/               首次写入前的备份
```

Key 只写入 `~/.codex/sf-opencode-go-<account>.config.toml`（沿用现有私有 Profile
机制，`0600`、`O_NOFOLLOW`、属主校验），不进入注册表、配置、日志或平台消息。

账户 id 规则：小写字母/数字/`-`/`_`，1–32 位；不允许与现有 Provider id 冲突。

## 4. CLI / Setup

在 `codexc setup` 的“模型与提供商 → OpenCode Go”下增加账户管理入口，同时提供
独立命令（方便脚本化）：

```bash
codexc opencode-go account add <id>          # 输入 Key，下载/复用模型目录，写 Profile 与注册表
codexc opencode-go account list              # 列出账户与默认标记
codexc opencode-go account remove <id>       # 备份后删除 Profile 与注册表项
codexc opencode-go account default <id>      # 设置新会话默认账户
```

行为约束：

- 新增账户不修改现有账户的 Profile、模型目录与统计；
- 首个账户沿用当前 `opencode-go` 配置原地迁移为 `opencode-go-main`，保持兼容；
- 删除账户前备份 Profile 与账户目录；删除后该账户历史 Thread 不可恢复，需明确确认；
- 每次增删账户后校验全部账户 Profile 与共享模型目录，失败关闭并回滚注册表。

## 5. 共享统计代理

### 5.1 为什么可以共享

统计代理（`ProviderProxy`）不持有 Key，只把隔离 App Server 发来的请求原样转发到
官方 `https://opencode.ai/zen/go/v1` 并采集指标；Authorization 由各 App Server
子进程按自己的 `env_key` 注入。因此多个 GO 账户可以共用同一个转发入口。

### 5.2 当前实现的差异点

现在 `startProviderProxy` 按 Provider 创建独立实例，指标经
`providerMetricsSocketPath(primarySocketPath, provider)` 分别上报。共享后需要：

1. 只为 GO 渠道创建**一个** `ProviderProxy`（OpenAI、DeepSeek 各自保持独立）；
2. 每个 GO 账户隔离 App Server 的 `base_url` 指向同一代理地址，但带账户路径前缀，
   例如 `http://127.0.0.1:<port>/go/<accountId>`；
3. 代理按路径前缀识别账户，转发时剥离前缀后访问官方 `/zen/go/v1/...`；
4. 指标按账户分开上报：`onMetrics` 需要携带账户标识（或按前缀选择对应
   metrics socket），Gateway 侧继续按 `providerMetricsSocketPath(socketPath,
   "opencode-go-<account>")` 接收，指标库按 Provider 过滤天然区分账户。

### 5.3 资源结论

- 统计代理：始终 1 个（内存 HTTP server，非独立进程），不会随账户数量增长；
- 隔离 App Server：每个账户 1 个 `codex app-server` 子进程（主要资源成本）；
- 代理启动时机：GO 主代理随 App Server 服务启动（或首个账户首次使用时按需启动）；
  账户 App Server 仍按需启动、常驻复用。

## 6. 会话切换与 Thread 语义

- `/model` 展示账户级选项，显示名如 `OpenCode Go（main）`、`OpenCode Go（b）`；
- 同账户内切换模型：现有模型覆盖逻辑，不新建 Thread；
- 跨账户切换：保留并解绑当前 Thread，下一条消息用目标账户默认模型新建 Thread，
  不复制历史（与现有跨 Provider 行为一致）；
- `/resume` 按 Provider 过滤 Thread 列表；恢复旧账户 Thread 时若该账户 App Server
  未运行，先按需启动再列出/恢复；
- `codexc remote --profile opencode-go-<account>` 可直连对应账户隔离实例。

## 7. 生命周期策略（避免占用随账户增长）

默认策略：**空闲超时自动释放**，防止“切换越多、占用越大”。

- 每个账户的隔离 App Server 仍按需启动；
- Gateway 定期（默认每 60 秒）扫描已启动的 GO 账户，满足以下全部条件时通过
  supervisor 新增的 `releaseProvider` 释放该账户的隔离 App Server：
  1. 该账户没有活动 Turn（全部 Thread 处于空闲/无运行状态）；
  2. 没有 Conversation 绑定该账户的 Thread（StateStore 无绑定）；
  3. 不是 `agents.external` 当前默认账户；
  4. 空闲超过阈值（默认 5 分钟，可配置）。
- 统计代理始终共享一个，不参与释放；释放只终止账户隔离 App Server 子进程并移除
  对应启动记录，账户 Profile、注册表与 Thread 持久数据保留；
- 释放后再次使用（选模型、恢复 Thread、`remote --profile`）自动走现有
  `ensureProvider` 按需拉起，无需人工操作；
- 提供手动命令 `codexc opencode-go account stop <id>` 立即释放；账户 App Server
  停止期间其 Thread 不可恢复，重新拉起后恢复。

实现要点：

- supervisor 协议新增 `releaseProvider`（与 `ensureProvider` 对称），校验账户 id、
  当前无活动条件后终止对应子进程并返回结果；
- Gateway 侧新增“账户活跃度”跟踪：活动 Turn、绑定与 `agents.external` 默认账户
  三源判定；扫描器与释放请求失败均只记录、不阻塞请求；
- 释放与按需启动并发时以 `ensureProvider` 优先（正在拉起的账户跳过释放）；
- **释放通知**：每次成功释放后，Gateway 向渠道会话通知一次（例如“OpenCode Go
  账户 `<id>` 已空闲停止，再次选择时将自动启动”），说明自动恢复行为，不静默释放；
  同一次释放只通知一次，不重复刷屏。

此策略下活跃占用保持在有界水平：通常同时只有当前使用中的 1–2 个账户 App Server，
使用过的账户不会无限堆积。

## 8. 账户适配器与 `/usage`

- `opencode-go-account-adapter.ts` 参数化为工厂：`createOpencodeGoAccountAdapter({
  provider, credential, usageUrl, metricsDatabasePath, pricingResolver })`；
- `ProviderAccountService` 按 Provider id 注册每个账户的适配器；
- `/usage` 由当前 Thread 的 `modelProvider` 路由到对应账户适配器，只显示当前
  账户的 5h/7d/月窗口、总额度与本地 Token；
- 账户不可用（Key 失效、官方接口失败）时明确显示查询失败，不回退到其他账户。

## 9. `agents.external` 与完成卡片

- 共享子代理角色仍只指向一个账户（注册表中的默认账户）；
- 切换默认账户后，角色文件 `sf-agent.config.toml` 指向新默认账户的代理地址与
  `env_key`；
- 完成卡片“账户状态”区继续展示当前 Thread 账户的剩余额度，不跨账户汇总。

## 10. WebUI 与指标中心

- WebUI 用量卡按账户拆分展示（每个已配置账户一张卡，或按当前筛选账户）；
- 指标库请求记录按 `provider=opencode-go-<account>` 区分，现有 Provider 过滤、
  `/metrics providers`、中心同步不需要新表；
- `codexc metrics prune opencode-go-<account>` 支持按账户清理。

## 11. 额度耗尽行为

- 官方窗口 percent 达 100% 或查询到额度耗尽时，`/usage` 与完成卡片明确提示当前
  账户额度已用完；
- Gateway 不主动拦截请求（与现状一致），由用户切换到其他账户；
- 可在 `/model` 选项上标注“额度不足”提示，作为增强项（第一版可选）。

## 12. 改造清单

### 12.1 定义与注册

- `runtime/model-provider-definitions.mjs`：保留基础定义，新增
  `loadOpencodeGoAccountDefinitions(environment)` 生成账户实例；
- `runtime/model-provider-runtime.mjs`：Profile 读取/校验、管理标记、App Server
  启动参数按账户实例参数化；`providerDescriptors` 改为静态基础 + 动态账户；
- `runtime/app-server-supervisor.mjs`：`managedProviderIds` 白名单改为动态
  （含已注册账户 id），并新增 `releaseProvider` 协议动作；
- `runtime/model-provider-profile.mjs`：Profile 创建支持账户实例，去掉对编译期
  数组的强引用校验。

### 12.2 生命周期回收

- `bin/codexc.mjs`：`releaseProvider` 实现（校验账户无活动后终止对应隔离 App
  Server 子进程、移除启动记录；共享统计代理不关闭）；
- Gateway 新增账户活跃度跟踪与定期扫描（活动 Turn、绑定、`agents.external`
  默认账户三源判定），空闲超阈值后发送释放请求，并向渠道通知一次释放结果；
- `codexc opencode-go account stop <id>` 手动释放入口。

### 12.3 统计代理

- `bin/codexc.mjs`：GO 渠道只创建一个 `ProviderProxy`；账户 App Server 的
  `base_url` 带 `/go/<account>` 前缀；代理按前缀解析账户并分 socket 上报；
- `src/provider-proxy/proxy.ts`：转发时支持账户前缀剥离与指标账户标识；
- `src/provider-proxy/metrics-channel.ts`：`sendProviderProxyMetrics` 支持按账户
  socket 发送。

### 12.4 账户与展示

- `scripts/opencode-go-setup.mjs`：改造为账户管理（add/list/remove/default）；
- `scripts/setup.mjs`：菜单接入账户管理入口；
- `bin/codexc.mjs`：新增 `opencode-go account` 子命令；
- `src/codex-client/model-provider-catalog.ts`：账户实例映射模型目录，显示名带账户；
- `src/application/model-selection-service.ts` / `conversation-command-format.ts`：
  `/model` 与 `/usage` 展示账户；
- `scripts/webui-server.mjs` / WebUI：账户用量卡与账户列表。

### 12.5 账户适配器

- `src/bootstrap/opencode-go-account-adapter.ts`：工厂化；
- `src/bootstrap/app.ts`：遍历注册账户实例的适配器与模型 Provider。

### 12.6 命令与兼容

- `scripts/metrics-command-options.mjs`、`scripts/agents.mjs`、
  `scripts/codex-remote-options.mjs`：Provider id 集合改为动态或扩展规则；
- 现有 `opencode-go` 配置迁移为 `opencode-go-main` 的脚本与测试；
- 文档：本方案、`opencode-go.md`、接入指南、README、WebUI 文档同步更新。

## 13. 验证

- 单元测试：账户注册表、Profile 生成与校验、账户实例定义、代理前缀路由与指标
  分账、账户适配器工厂、释放判定、释放后渠道通知一次与按需恢复；
- 集成验证：`codexc opencode-go account add` 后 `/model` 出现新账户；
  切换账户后 Thread 归属正确；`/usage` 显示当前账户额度；
  切回原账户 `/resume` 能恢复历史 Thread；
- 真实 App Server 合同：账户实例能启动隔离 App Server 并完成模型请求；
- 资源验证：N 个账户只启动 1 个 GO 统计代理；账户 App Server 按需启动。

## 14. 已确认决策

1. 默认账户命名：现有单账户配置原地迁移为 `opencode-go-main`，保留旧 Profile
   （`sf-opencode-go.config.toml`）不自动迁移的未受管文件仍按未受管处理；
2. 账户生命周期：空闲 5 分钟自动释放为默认策略，阈值暂不做配置项；
3. `/model` 不标注额度不足（第一版不做增强）；
4. WebUI 展示全部已配置账户的用量卡，便于对比剩余额度。

## 关联文档

- [`docs/opencode-go.md`](opencode-go.md)：单账户接入现状；
- [`docs/provider-integration-guide.md`](provider-integration-guide.md)：受管
  Provider 接入标准；
- [`docs/index.md`](index.md)：协议支持矩阵与实现映射。
