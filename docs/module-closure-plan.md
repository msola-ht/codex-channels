# 模块结构收口计划

本文承接 [`模块链路审查记录`](module-chain-audit.md)，处理链路功能已经闭环后仍存在的结构问题。
本计划只减少无调用能力、过宽接口、重复分派和混合职责，不新增业务能力，不改变 Codex 协议基线，
也不为未来需求预留新的配置、接口或抽象层。

## 目标与完成标准

本轮完成时应满足：

- 继续保留现有 15 个一级模块，不新增通用 `types`、`utils`、`services` 或 Surface 基类模块。
- 删除没有运行时调用方的直接 API Provider 纵向能力，不以实现新调用方替代收口。
- Surface 不再依赖包含全部会话能力的单一宽接口；测试不再依靠双重断言伪造完整
  `ConversationUseCases`。
- 飞书与微信不重复维护相同的命令结果到纯文本映射。
- Bootstrap、CLI、Provider Runtime、WebUI 管理路由、Provider Proxy 和指标存储各自只保留无法继续
  独立验证的生命周期接线。
- 公开命令、配置、文档、模块索引和 npm 打包清单与实际运行能力一致，不保留孤儿入口。
- 每批通过相关定向测试、类型检查、Lint 和文档检查；提交时由既有 pre-commit hook 统一运行
  `npm run verify:commit`。

不以文件行数作为完成标准。只有职责边界、调用方向、状态所有权和验证入口都清楚时，拆分才算完成。

## 固定边界

- 一级依赖方向继续保持 `Surface -> Application/Core <- Codex Client`，由 `bootstrap` 完成组合。
- App Server 继续是 Thread、Turn、Item、Goal 和历史状态的唯一事实来源。
- `storage` 与 `observability` 不合并；两者虽然都使用 SQLite，但保存的事实、生命周期和保留策略不同。
- Telegram、飞书、微信保留各自的发送、卡片、按钮、回复上下文和重试语义，只共享完全相同的纯映射。
- `codex-client` 当前按 Thread、Turn、Queue、History、Model、Account、MCP、Plugin 等适配器划分，
  本轮不重组协议边界。
- `event-bus`、`policy`、`config`、`session-routing` 和 `scheduled-tasks` 当前职责集中，不因文件数量
  进行形式性拆分。
- 高风险 Transport、Provider 流式转发和 SQLite Schema 最后处理，不与低风险清理混入同一提交。

## 批次与依赖

### 批次一：孤儿代码与确定重复

状态：已完成（2026-09-14）。

范围：

1. 删除 `ProviderQuotaWindow.totalUsd`、OpenCode Go 固定金额表、WebUI 同名类型字段及直接测试数据。
   当前渠道与 WebUI 已不展示金额，旧快照 JSON 中的未知字段由现有读取逻辑忽略，不执行数据库迁移。
2. 删除没有生产调用者的 `OfficialAccountSnapshotService`、`OfficialAccountSnapshotQueryPort`、公开导出
   和专属测试。
3. 提取共享的命令结果纯文本分派器，替换飞书 `renderFeishuCommandResult()` 与微信
   `renderWeixinCommandResult()` 的相同 switch；Telegram 的交互式结果保持原实现。
4. 删除已经度过迁移提示版本的 `/section` 命令注册、帮助、专属错误码和测试；保留协议官方
   `section` 字段以及 `/pin`、`/unpin`。

主要文件：

- `src/application/account-port.ts`
- `src/application/account-snapshot-service.ts`
- `src/application/conversation-command-service.ts`
- `src/application/conversation-command-parser.ts`
- `src/bootstrap/opencode-go-account-adapter.ts`
- `src/surfaces/conversation-command-format.ts`
- `src/surfaces/feishu/renderer.ts`
- `src/surfaces/weixin/command-renderer.ts`
- `scripts/webui-api.ts`
- 相关公开导出、文档和既有测试

验收：

- 生产代码中不存在 `totalUsd`、`OfficialAccountSnapshotService`、`thread-section.removed` 和公开
  `/section` 命令入口。
- 飞书与微信通过同一个纯文本结果分派器覆盖全部 `ConversationCommandResult.kind`。
- OpenCode Go 三个额度窗口继续只显示已用百分比、本地 Token 和重置时间。

验证记录：账户适配、命令目录、共享渲染、Surface 文案与模块边界共 8 个定向测试文件、163 项通过；
`npm run check`、`npm run lint` 和 `npm run docs:check` 通过。

### 批次二：删除无运行时调用方的直接 API Provider

状态：已完成（2026-09-14）。

这是公开配置 Schema 和本机凭据管理行为变化，必须独立提交，不与其他重构合并。

范围：

1. 删除 `api_providers` TOML Schema、Application 配置映射和示例配置。
2. 删除 Setup 菜单、CLI 帮助、Doctor 检查、管理事务、WebUI 管理路由和相关类型。
3. 删除只服务该注册表的凭据读写运行时；不主动删除用户磁盘上已有的凭据文件。
4. 删除文档中“预留、未来明确设计、无运行时调用方”的描述，并在升级说明中明确旧配置需要先移除
   `api_providers` 后才能通过严格 Schema 校验。
5. 检查旧直接 API 指标标签是否仍有独立历史读取价值；没有消费者时随本批删除，有历史展示需求时只在
   Observability 查询边界保留只读标签，不保留配置和凭据管理能力。

验收：

- `api_providers` 不再出现在配置 Schema、Setup、Doctor、WebUI 管理 API、CLI 帮助和公开文档。
- Gateway 不再写入或读取直接 API Provider 凭据。
- 当前 DeepSeek、OpenCode Go、自定义 Responses Provider 和受管 Provider 的运行路径不受影响。
- 未执行自动凭据删除或隐式配置迁移。

指标标签结论：旧 `providerName` 仅由运行时使用当前 `api_providers` 映射生成，并未持久化到指标库，
不存在独立历史读取价值；本批删除该派生字段，继续保留指标记录中的原始 Provider ID。

验证记录：严格配置、配置重载、Bootstrap 装配、Setup/CLI、指标查询与格式化、WebUI 管理共
10 个定向测试文件通过（247 项通过、5 项跳过）；`npm run check`、`npm run lint`、
`npm run docs:check` 和 WebUI 独立构建通过，`git diff --check` 通过。

### 批次三：缩窄 Application 能力合同

状态：已完成（2026-09-14）。

范围：

1. 按调用者需要定义少量能力接口，初始分组为：
   - Turn 与输入生命周期；
   - Session 与 Workspace；
   - Queue 与 Revert；
   - Model、Skill、Agent、MCP 与 Plugin；
   - Account 与 Metrics。
2. Surface、命令服务和 Bootstrap 只依赖实际使用的接口组合，不再要求所有调用者实现完整
   `ConversationUseCases`。
3. 将 `ConversationService` 中会话生命周期编排与扩展/账户查询分离为明确组件；如需兼容组合根，
   可以保留一个只做组合、不复制逻辑的门面。
4. 将 `ConversationCommandService.execute()` 的领域分支委托给明确 handler；不引入动态命令注册、
   反射或通用命令框架。

验收：

- 目标测试和 Surface 装配中不存在 `as unknown as ConversationUseCases`。
- 每个能力接口都有明确生产消费者，不建立只有测试消费者的端口。
- Conversation 并发协调、授权顺序、Provider 路由和错误码保持现有行为。
- 模块依赖白名单不扩大，模块图继续无环。

验证记录：Application 会话与命令、三渠道输入/Surface、Bootstrap 组合及模块边界共 17 个定向测试文件
通过（296 项通过、1 项跳过）；`npm run check`、`npm run lint`、`npm run docs:check` 和
`git diff --check` 通过。

### 批次四：Surface 格式器与 Bootstrap 组合收口

状态：待批次三接口稳定。

范围：

1. 将 `conversation-command-format.ts` 按会话、计划任务、扩展、模型账户、Workspace/状态等稳定领域
   拆分；一级 `surfaces/index.ts` 只导出真实跨模块合同。
2. 从 `GatewayApplication` 提取组件图创建器，集中装配具体实现及其所有权。
3. 从 `GatewayApplication` 提取 Binding 恢复协调器，拥有待恢复 Thread、重试、Provider 重连后恢复
   和可用性发布状态。
4. `GatewayApplication` 只保留 start、stop、配置重载和顶层生命周期协调。

验收：

- 命令格式化文件按领域独立验证，没有平台 SDK 或 Application 状态写入。
- Binding 恢复状态只有一个所有者，停止时取消和等待路径保持有界。
- 组件创建器不成为依赖注入容器，不隐藏高权限配置或生命周期失败。

### 批次五：运行时、CLI 与 WebUI 管理边界

状态：待前四批稳定。

范围：

1. 将 `model-provider-runtime.mjs` 收敛为三个职责单元：受管目录与设置、自定义 Provider 切换、
   启动/凭据/Agent 角色解析。
2. 将 `bin/codexc.mjs` 中 App Server 服务生命周期移入 `runtime`，服务子命令实现移入对应脚本；
   `bin` 只保留帮助、参数解析和分派。
3. 将 `webui-server.mjs` 的 `routeManagement()` 按 Codex 设置、Gateway 设置、Provider/账户、计划任务、
   服务与状态拆分，认证、Origin、限速、锁和统一错误响应仍由主 server 管理。
4. 为 `runtime`、`scripts`、`bin` 增加依赖方向检查，避免它们通过相对导入绕过 `src` 一级模块边界。
5. 盘点 npm 运行时真实需要的脚本，把 `package.json.files` 从整个 `scripts/` 目录改为显式清单；
   开发探针和发布工具不进入用户安装包。

验收：

- `bin/codexc.mjs` 不拥有服务进程状态机或 Provider 配置事务。
- WebUI 各资源路由共享同一安全入口，不复制认证、修订锁或错误脱敏。
- npm tarball 安装冒烟覆盖所有公开命令，没有运行时动态导入缺失。
- 新边界检查不通过扩大白名单来迁就现有偶然依赖。

### 批次六：高风险数据与代理边界

状态：最后实施；SQLite Schema 变化需单独确认数据处理和回滚方案。

范围：

1. 从 `provider-proxy/proxy.ts` 提取纯响应指标观察器，负责 HTTP/SSE/JSON/WebSocket 完成信息和额度
   元数据解析；传输状态机与背压仍留在 Proxy。
2. 将 `ModelRequestMetricsStore` 按写入、请求查询、Thread/Subagent 查询、Quota/Account Snapshot 拆为
   窄端口；一个 SQLite 实例可以实现多个端口，不拆数据库。
3. 在独立 Schema 升级中删除已不再生产或展示的价格、成本、旧计时列、派生 View、排序字段和直接 API
   Provider 历史配置分支。
4. Schema 升级沿用停机、私有备份、精确版本事务和明确回滚，不增加隐式迁移。

验收：

- Proxy 指标观察器可用纯输入验证，Authorization、Cookie 和上游敏感正文不进入指标。
- 指标消费者只依赖所需端口，不再通过一个宽 Store 接口访问无关能力。
- 旧 Schema 明确失败并提示受控升级；升级失败保留备份，当前数据不被部分改写。
- 指标 WebUI、渠道 `/metrics`、额度窗口和 Thread/Subagent 查询合同保持一致。

## 每批执行流程

每一批严格按以下顺序执行：

1. 重新读取该批相关模块 README、公开入口、直接实现和既有测试。
2. 检查工作区和目标文件已有改动；存在无法区分的重叠修改时停止。
3. 先删除孤儿入口或提取纯边界，再调整调用者；同一时刻保持可编译范围尽量小。
4. 更新直接受影响的模块 README、专题文档和 `index.md`，不向根 `README.md` 堆放实现细节。
5. 运行该批最小定向测试、`npm run check`、相关 Lint 或 `npm run docs:check`；同一代码状态不重复运行。
6. 审查 `git diff`、模块公开入口、孤儿引用和模块依赖；提交时由 hook 运行完整门禁。
7. 只有实现、验证、文档和差异审查全部完成后，才在本计划中将该批标记完成。

## 停止条件

出现以下任一情况时停止当前批次，不继续扩大范围：

- 需要新增一级模块、外部依赖、配置兼容层或动态注册机制才能继续。
- 公开行为删除、持久化格式变化或现有凭据处理方式尚未得到明确确认。
- 目标文件存在无法安全区分的用户或其他代理改动。
- 定向验证暴露与当前批次无直接关系的失败；只记录证据，不顺手修复。
- 拆分后必须扩大模块依赖白名单、复制状态或引入第二事实来源才能通过。

## 当前状态

- [x] 完成第二轮结构审查并确认不新增一级模块。
- [x] 建立分批计划、依赖、验收标准和停止条件。
- [x] 批次一：孤儿代码与确定重复。
- [x] 批次二：删除直接 API Provider 预留纵切面。
- [x] 批次三：缩窄 Application 能力合同。
- [ ] 批次四：Surface 格式器与 Bootstrap 组合收口。
- [ ] 批次五：运行时、CLI 与 WebUI 管理边界。
- [ ] 批次六：高风险数据与代理边界。

批次三已完成；下一步从批次四的命令格式器领域边界开始。
