# OpenCode Go 多账户实现

Codex Connect 支持在一个 Gateway 内配置多个 OpenCode Go 账户。每个账户使用独立 API Key、
额度、Provider 路由和 App Server，模型目录与统计代理由所有账户共享。用户使用 `/model`
切换账户；`/usage` 和完成卡片只展示当前 Thread 所属账户。

当前配置和常用命令见 [`OpenCode Go 使用说明`](opencode-go.md)，第三方 Provider 的通用约束见
[`第三方模型 Provider 接入指南`](provider-integration-guide.md)。本文只说明多账户的实现边界、
生命周期和兼容行为。

## Provider 与 Thread 语义

首次和后续添加都必须输入账户 ID。所有账户使用 `ocg-<accountId>`；默认账户只由注册表中的
`default: true` 标记决定：

```text
ocg-work             默认账户 work
ocg-b                账户 b
```

Codex Thread 的 `modelProvider` 创建后不可变。因此：

- 同一账户内切换模型不会新建 Thread；
- 跨账户切换会保留并解绑当前 Thread，下一条消息使用目标账户新建 Thread，不复制历史；
- `/resume` 按原 `modelProvider` 恢复仍映射到现有账户的历史 Thread，并在需要时拉起对应账户 App Server；已删除账户或无法映射的旧 Thread 不保证可恢复；
- `/model` 和指标展示使用注册表中的 `ocg-<邮箱或手机号>`，未配置联系方式时回退到 `ocg-<accountId>`；
- `codexc remote --profile sf-ocg-<accountId>` 连接对应账户。

## 账户文件

账户注册表和共享模型目录位于 Gateway 数据目录，不保存 Key；注册表中的联系方式只用于展示和数据中心身份快照：

```text
~/.codex-connect/providers/opencode-go/
  accounts.json                            账户注册表（id、default、email 或 phone）
  models.json / models.manifest.json       共享模型目录
  accounts/<account>/managed.toml          管理标记（version、provider、mode）
  accounts/<account>/backup/               删除前的私有 Profile 与管理标记备份
```

切换模式下，每个账户使用独立的 0600 Profile：

```text
~/.codex/sf-ocg-<account>.config.toml
```

Profile 保存该账户的 Key、Provider 配置、模型目录、默认模型与默认思考等级。Key 不进入
`accounts.json`、Gateway 配置、日志或平台消息。Profile 与管理标记继续执行无符号链接、属主和
权限校验。

账户 id 使用小写字母、数字、`-` 或 `_`，长度为 1–32；Provider 始终使用
`ocg-<accountId>`，默认账户不使用固定 ID。添加账户时邮箱和手机号必须二选一。

## CLI 与原子性

```bash
codexc opencode-go account add <id>
codexc opencode-go account list
codexc opencode-go account list --json
codexc opencode-go account remove <id>
codexc opencode-go account default <id>
codexc opencode-go account stop <id>
```

`list --json` 输出账户 ID、邮箱或手机号（若有）、展示名、默认标记、Provider ID 与运行模式，不包含 API Key 或 Profile 路径。

- `add` 下载或复用共享模型目录，写入账户 Profile、管理标记与注册表；失败时按写入前快照回滚；
- `remove` 先停止账户实例并备份 Profile 与管理标记，再删除注册项和受管文件；任何删除步骤失败
  都按删除前快照回滚；存在 Remote TUI
  租约或运行中的 Supervisor 协议不兼容、响应无效时失败关闭且不修改账户文件；最后一个账户只能
  通过 Setup 的恢复配置流程移除；
- `default` 原子更新注册表；`agents.external` 当前使用 OpenCode Go 时同步切换到新默认账户，
  角色更新失败时回滚默认账户；当前角色使用 DeepSeek 时保持不变；
- `stop` 立即请求释放账户 App Server；如果对应 Remote TUI 正在持有租约，则保留实例并提示用户
  退出 TUI 后重试；
- 删除账户后，该账户历史 Thread 因 Provider 不再存在而不可恢复，CLI 会要求明确确认。

已注册的旧账户升级时会改为 `sf-ocg-<accountId>.config.toml`，并把配置和角色中的 Provider
引用迁移到 `ocg-<accountId>`。没有账户 ID 的旧单账户配置不会被擅自命名为 `main`，需使用明确 ID
重新添加。迁移无法获得联系方式，因此身份快照会在补充联系方式前省略该账户；旧会话若仍引用已不存在的旧 Provider，则不保证可恢复。

## 共享统计代理

所有 OpenCode Go 账户共享一个 `ProviderProxy`。代理不持有账户 Key；Authorization 由各账户
App Server 从自己的进程环境注入。

账户 App Server 的 `base_url` 指向共享代理并带 `/go/<accountId>` 前缀。代理转发时剥离前缀，
按账户选择指标 Socket，使指标库中的 `provider` 保持为对应账户 Provider id。因此现有 Provider
过滤、指标中心同步和 `codexc metrics prune ocg-<accountId>` 无需新增请求指标表；身份快照单独存放在中心 `provider_identities` 表。

## App Server 生命周期

每个账户拥有一个按需启动的隔离 App Server。共享统计代理不随账户数量重复创建。

Gateway 默认每 60 秒扫描一次已运行的 OpenCode Go 账户；同时满足以下条件并持续 5 分钟后，
才请求 Supervisor 自动释放：

1. 没有 Conversation 绑定该账户的 Thread；
2. Gateway 最近没有观察到该账户的 Turn 活动；
3. 没有通过 `codexc remote` 启动的受管 Remote TUI 持有该账户租约。

`agents.external` 通过主 App Server 直接复用该账户 Key 与共享统计代理，不依赖账户隔离 App
Server，因此角色仍可连续或并发启动子 Thread，同时不阻止同账户的隔离实例按上述条件释放。

渠道 Turn 在运行期间保留 Conversation 绑定；`codexc remote` 在 TUI 整个生命周期内通过私有
Supervisor Socket 持有租约，进程正常退出或异常断开时租约自动撤销。Supervisor 在存在租约时
拒绝自动或手动释放；同一 Provider 的启动、释放与租约获取串行执行，释放期间到达的新租约会在
实例恢复后才成功，从而避免终止 Remote TUI 正在使用的 App Server。

释放只终止账户 App Server 子进程并更新监管状态；Profile、注册表、模型目录、指标与 Codex Thread
数据保持不变。成功自动释放后，Gateway 向最近使用过该账户的渠道会话通知一次。再次选择账户、
恢复 Thread 或启动 Remote TUI 时，Supervisor 会重新按需启动实例。释放失败只记录日志，不阻塞
正常请求。

空闲阈值当前固定为 5 分钟，扫描间隔固定为 60 秒，不是用户配置项。自动回收当前只适用于
OpenCode Go 账户实例，不适用于所有受管 Provider。

## 账户能力与展示

- `ProviderAccountService` 按 Provider id 注册账户适配器；
- `/usage` 只查询当前 Thread 账户的 5 小时、7 天和月度窗口；失败时不回退到其他账户；
- 完成卡片只展示当前 Thread 账户，不跨账户汇总；
- WebUI 为所有已配置账户分别展示用量卡；
- 额度耗尽时展示当前账户状态，但 Gateway 不主动切换账户或拦截请求；
- `agents.external` 使用 OpenCode Go 时只指向注册表中的默认账户，修改默认账户时同步更新角色配置；
  当前明确选择 DeepSeek 时不被 OpenCode Go 默认账户命令覆盖。

## 主要验证边界

测试覆盖账户注册表与旧配置迁移、CLI 原子写入和回滚、共享代理路径与分账户指标、Provider 路由、
账户用量适配、按需启动、空闲释放、Remote TUI 租约、主动释放通知，以及 Supervisor 的运行中、
主动释放和租约状态。

## 关联文档

- [`docs/opencode-go.md`](opencode-go.md)：用户配置、模型和额度说明；
- [`docs/provider-integration-guide.md`](provider-integration-guide.md)：受管 Provider 接入标准；
- [`docs/index.md`](index.md)：Codex 协议支持矩阵与实现映射。
