# 架构优化路线

本文记录 `codex-channels` 的结构性优化原则、已确认热点、实施顺序和完成状态。目标是在不改变公开行为、协议边界、持久化格式和渠道语义的前提下，降低核心链路的修改成本与并发风险。

## 优化原则

- 不按文件行数机械拆分。只有一个区域同时存在独立职责、独立状态或可单独验证的业务规则时才拆分。
- 优先复用现有端口、类型和组合模式，不引入依赖注入容器、动态注册框架或继承式平台基类。
- 保留必要的边界重复。协议校验、数据库 Row、Application DTO 和平台 SDK 类型不得为了去重而相互泄漏。
- 每批只处理一个完整边界，保持公开接口和外部行为不变；新增行为、失败路径或安全边界才新增测试。
- 高风险 Transport、协议和持久化逻辑最后处理，先抽取纯状态、纯映射和明确的领域组件。

## 当前链路

```text
Surface 输入
  -> ConversationCommandService
  -> ConversationUseCases
  -> ConversationService
  -> SessionRouter
  -> ProviderRoutingClient
  -> Codex App Server

App Server Notification
  -> Codex Client 适配
  -> Bootstrap 事件分发
  -> ConversationCore
  -> SurfaceManager
  -> 渠道 Outbox

Provider Proxy
  -> 指标 Writer / SQLite
  -> ConversationCore 实时统计与完成卡片汇总

计划任务
  -> Application Service / Store / Scheduler
  -> automation 后台 Thread
  -> 复用 App Server、Core 和 Surface 输出链路
```

顶层模块继续保持 `Surface -> Application/Core <- Codex Client`，由 `bootstrap` 组合具体实现。现有模块依赖白名单、无环检查、公开入口检查和协议导入限制继续作为不可放宽的约束。

## 已确认热点

### Application 超级门面

`ConversationService` 同时承担 Turn、会话、Workspace、分区、模型、扩展查询、账户、指标、Goal 和后台释放。
Queue 与 Revert 已作为完整用例边界提取，并与主门面共享同一个 Conversation 并发协调器；后续只有会话或扩展查询
能够形成同样完整的状态与验证边界时才继续提取。Surface 继续依赖稳定的 `ConversationUseCases` 组合门面。

### Bootstrap 组合根

`GatewayApplication` 除启动、停止和重连外，还内联装配 Provider、指标、Surface 与大量端口映射。
Scheduled Task 已形成拥有 Store、Executor、Coordinator、Scheduler 和工具 Handler 生命周期的内部组合对象；
Metrics 继续复用既有 `ProviderMetricsComposition`，Store 到 Application DTO 的查询映射已收敛到
`RequestMetricsQueryAdapter`。Provider Client 直接参与按需拉起、断线恢复和主实例状态，审查后继续留在组合根，
直到能够形成不隐藏这些生命周期关系的完整边界；不为形式统一增加空壳组合对象。

### Surface 重复状态机

三个渠道已经复用命令文案、生命周期呈现、交互注册表和输出队列。查询操作缓冲现在统一按事件决定
Commentary 保留以及最终文本、Turn 完成前 Flush；Telegram 与微信的计划进度按 Turn 隔离、完成释放和
新增完成步骤判定也由共享状态负责。命令结果继续复用既有平台无关格式器，按钮、卡片、HTML、消息编辑和
回复上下文审查后保留在各渠道，不再增加掩盖平台交互差异的分发门面。

### 持久化大文件

指标 Store 与计划任务 Store 同时包含运行时事务、Schema、升级、查询和 Row 映射。计划任务的 Row Codec
以及 Schema SQL 与结构校验已完成机械提取；Migration 与 Query 审查后保留其事务和文件生命周期接线。
Metrics Store 的 Row Projection Codec 也已提取，明细、Turn、Thread、聚合与压缩摘要映射不再与 SQL 执行混放；
当前 Schema SQL、存储列定义与严格结构校验也已提取，初始化事务仍由 Store 维护。显式 Migration 审查后
继续留在脚本侧维护停机、备份和逐版本事务，Query 继续留在 Store 维护共享聚合 SQL 与分页/排序语义。

### Conversation Core 计时聚合

模型请求计时、Token、费用、压缩、峰谷档位与速度累加已提取为独立的
`TurnTimingAccumulator`；Core 只把对应输入交给该组件，并保留 Thread/Turn/Item 事件路由和输出发布。

### 高风险边界

Provider Proxy 已先提取回环监听校验、账户前缀解析、受支持路径白名单、上游路径拼接与请求头过滤，
连接生命周期、流式背压、WebSocket 转发和指标状态机继续共同留在 `proxy.ts`。微信协议 Client 的稳定协议类型、
共享响应校验和纯入站消息解码也已提取；网络请求、轮询建议超时状态与媒体上传事务仍共同留在 Client。
飞书 SDK Client 的发送、CardKit、资源下载和错误归一共享同一 SDK Client 与超时策略，审查后保留；CLI 的参数与
子命令选项已经由现有 `scripts/` 模块承接，入口继续作为可执行组合根；Provider Runtime 的私有文件事务、受管 Profile
和模型目录校验继续共同维护，不按函数数量拆分。

## 不统一的边界

- Codex 协议类型、Application DTO、Observability Row 和 Surface View 之间的显式映射。
- 各外部输入边界自己的枚举、长度、URL、凭据和结构校验。
- Telegram、飞书和微信的实际发送、重试和交互决定。
- DeepSeek/OpenCode Go 的受管文件生命周期与自定义 Provider 的 App Server 配置事务。
- SQLite 领域对象、查询 Row 和迁移 Row。

## 实施顺序

1. 提取 Core 的 Turn 模型计时累加组件。
2. 提取 Application 的 Queue 与 Revert 用例，同时建立共享并发协调器。
3. 收敛 Bootstrap 的 Scheduled Task 生命周期与 Metrics 查询映射，并复核 Provider 生命周期接线。
4. 复核平台无关命令结果格式化，统一可共享的 Turn 输出状态与 Flush 决策。
5. 拆分两个 SQLite Store 的 Schema、Migration、Query 与 Row Codec。
6. 最后处理 Provider Proxy、微信协议 Client、CLI 和 Provider Runtime。

顺序可以根据实际修改冲突调整，但不得为了追求文件数量或行数提前拆分高风险边界。

## 进度

- [x] 完成全项目链路、重复、耦合、复用和大文件审查。
- [x] 提取 Core 的 Turn 模型计时累加组件。
- [x] 提取 Queue 与 Revert 应用服务，并共享 Conversation 并发协调器。
- [x] 收敛 Bootstrap 子系统组合。
  - [x] 提取 Scheduled Task 组合与生命周期。
  - [x] 复核并继续复用 Provider Metrics 既有组合。
  - [x] 提取 Metrics 查询适配器；复核 Provider Client 并保留其生命周期接线。
- [x] 收敛 Surface 平台无关输出状态。
  - [x] 统一查询操作摘要的 Turn Flush 决策。
  - [x] 统一 Telegram 与微信的 Turn 计划进度状态。
  - [x] 复核命令分发并保留渠道交互接线。
- [x] 拆分持久化实现的纯基础设施部分。
  - [x] 提取 Scheduled Tasks Row Codec。
  - [x] 提取 Scheduled Tasks Schema SQL 与严格结构校验。
  - [x] 复核 Scheduled Tasks Migration 与 Query，并保留其事务和文件生命周期接线。
  - [x] 提取 Metrics Store Row Projection Codec。
  - [x] 提取 Metrics Store 当前 Schema SQL 与严格结构校验。
  - [x] 复核 Metrics Migration 与 Query，并保留其升级和聚合接线。
- [x] 复核高风险协议与运行时边界。
  - [x] 提取 Provider Proxy 的请求路由与 Header 过滤纯函数边界。
  - [x] 提取微信入站消息解码与共享响应校验；复核并保留飞书 SDK Client 状态接线。
  - [x] 复核并保留 CLI 组合根与 Provider Runtime 配置事务。

每一项只有在实现、定向验证和差异审查全部完成后才标记完成。
