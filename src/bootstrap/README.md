# Bootstrap

本目录是模块化单体的组合根，负责创建具体依赖并管理 Gateway 进程生命周期。

## 文件

- `index.ts`：向进程入口公开 `GatewayApplication`、进程生命周期入口和安全的 Gateway 所有权错误。
- `app.ts`：校验 Codex 版本，装配 Transport、Client、Core、Router 和 Storage；处理启动、重连、
  订阅恢复与关闭，并通过 Client 适配器把稳定事件分别转交 Core 与 `session-routing`、把
  Server Request 转交 Approval；未知或畸形 Notification 只记录 method 后忽略，未知或畸形
  高权限请求明确拒绝；受支持版本通过 Client 运行时信息读取，并把显示版本注入 Surface；
  对当前授权 Workspace 执行有时限的只读 Git 分支查询并注入 Application 状态；按 Setup 管理
  标记装配主 Client 与可选 Provider Client，并通过 Provider 路由复用其余业务模块；按已启用
  Provider 装配模型指标组件，不持有模型转发数据通路；把同一指标库的精确 Thread 查询映射为
  Application `/metrics` 窄端口，并为 OpenAI `/limits` 提供当前周窗口的精确 Provider 聚合；
  Core 根据编译期 Provider 能力决定哪些详细计时可以进入完成事件。
- `provider-metrics-composition.ts`：组合 Provider 私有指标 Socket、Observability 独立存储和 Core
  既有计时端口。所有脱敏请求样本都会持久化；具备 Thread、Turn 与 Token 窗口的样本按 Turn 聚合
  到完成卡片；持久化通过 Observability 有界 Writer 延迟分片执行，单项写入失败不会阻断指标确认或
  既有 Core 计时。可选 `ModelPricingResolver` 只在组合边界为新请求附加当次价格快照，可选
  `resolveModelSettings` 按 Thread 关联补齐路由层维护的思考等级；代理、Core 和数据库 View
  都不读取设置或内置模型价格。
- `bounded-fetch-body.ts`：统一组合根远端适配器的 Content-Length 校验、流式累计、超限取消与
  Reader 清理；调用方注入领域错误，并决定是否允许缺少正文，不向 Surface 暴露该基础设施。
- `model-pricing-catalog.ts`：实现组合根注入的远程价格目录。启动时先读取 Gateway 数据目录下的
  `0600` 可丢弃缓存，再异步刷新；固定优先读取 LiteLLM 目录，失败时回退到 Sub2API 使用的
  `Wei-Shaw/model-price-repo` 镜像，每 6 小时条件请求一次。该通用解析器只处理 DeepSeek 以外的
  Provider，并为新请求生成不可变 USD API
  参考价格快照，支持缓存输入、Priority 与已声明的长上下文价格，不把网络刷新放入请求路径；
  有界响应读取复用 Bootstrap 基础设施，私有缓存替换复用共享 Runtime。
- `deepseek-model-pricing.ts`：严格读取随包发布的 DeepSeek 官方人民币价格基线，按请求开始时间和
  `Asia/Shanghai` 半开峰谷区间选价，再用当前 USD/CNY 汇率生成统一 USD 快照；没有汇率、精确模型
  或有效计划时不回退通用目录。Provider 路由器保持该专属解析器优先，不改变历史快照或数据库格式。
- `opencode-go-model-pricing.ts`：严格读取随包发布的 OpenCode Go 官方美元价格基线，按请求 Provider、
  精确模型和输入 Token 选择普通或长上下文档位；不回退 DeepSeek 官方价格或通用远程目录。
- `reference-cost-summary.ts`：在 Turn 完成时把指标库中的 Thread 历史计价与当前实时 Turn 计价
  合并；若当前 Turn 已部分延迟写入，先扣除该部分再加入完整实时值，避免累计总价重复或遗漏。
- `subagent-completion-tracker.ts`：登记 Core 发布的子代理线程，以 App Server 自动订阅后发送的
  子线程 `turn/completed` 作为正常终态，并接受官方中断活动与旧版
  `collabAgentToolCall.agentsStates` 终态；极快子线程先完成后登记时只在有界短期缓存中保留终态。
  已观察到模型指标且终态后出现父线程官方 `wait` Item 时，立即等待 Observability Writer 当前
  水位落库并发布，保持该等待操作先于完成卡片；终态到达时尚无指标或之后未出现父线程等待时
  保留有界收敛窗口，后续新指标使旧结算失效；指标到达或静默本身不推断子代理结束。无指标
  发布零统计终态，指标写入或读取失败发布“统计不可用”终态。
- `workspace-permission-writer.ts`：把渠道 `/workspaceperm` 的工作区权限更新写回
  `config.toml` 并校验 `permissions` 与 `sandbox` 互斥；文件变化由配置监听热加载。
- `surface-plugin.ts`：定义编译期内置 Surface 插件、插件上下文和运行时模块契约，并校验插件 ID、
  实际 Surface ID 与账号实例唯一性。
- `surface-composition.ts`：显式注册 Telegram、飞书和微信内置插件，并保留各平台访问策略、
  热加载钩子和故障上报装配。三个插件都只在严格运行配置启用时创建实例；Telegram 由非空 Token
  决定是否启用，飞书和微信使用显式开关；飞书和微信启动通知从仍有授权 Actor 的已知 Conversation
  解析收件人，不要求当时已有 Thread 绑定。三个渠道按目标复用共享代理选择；微信协议 Client 在首次调用时从独立安全存储
  读取凭据，不把 Token 放入运行配置。
- `proxy-fetch.ts`：把共享 HTTP(S) 代理选择适配到微信使用的 Fetch 接口；命中 `NO_PROXY`
  时使用直连 Fetch，否则通过按代理 URL 复用的 Undici Dispatcher 发出请求。
- `openai-connectivity.ts`：在 OpenAI Provider 启动时复用同一代理做一次有界、无凭据的 HTTP
  传输探测；官方双目标全部不可达时生成脱敏状态供渠道上线通知使用，单目标失败只记录日志，
  均不阻断 Gateway；自定义 `openai_base_url` 只探测该地址。
- `deepseek-account-adapter.ts`：通过共享 Provider 运行时按请求读取切换 Profile 或固定基础配置中的
  DeepSeek Key，
  通过共享代理调用官方余额接口，并在共享有界响应读取和严格 Schema 校验后只返回稳定余额；Key、响应正文
  和解析异常不进入日志或业务事件。
- `responses-vision-adapter.ts`：模型不支持图片时可选的外部 Responses 图片识别实现；组合根按
  `vision.provider` 从第三方 API 注册表解析显示名称、精确 Endpoint 和隔离凭据，适配器复用统一
  代理、限制响应大小，并把用户原始提示和图片交给视觉接口后只返回 Application 的稳定识别结果；
  成功、失败与不完整响应的脱敏请求指标复用 Observability Writer，已有 Thread 时关联 Thread，
  组合根按实际响应模型附加当次价格快照，不保存图片、提示词、响应正文或识别结果。
- `turn-error-metrics.ts`：把同步 RPC 与异步 `turn.error` 通知的 Turn 级失败统一转换为脱敏的
  模型请求失败样本，保存错误原文与分类，不携带任何平台上下文或敏感凭据。
- `config-lifecycle.ts`：在任何 Surface 或指标组件启动前获取配置级 Gateway 所有权，随后管理配置
  监听、防抖重载、持久配置事件投递、信号、所有权释放与进程退出；只有应用启动完成后才把所有权
  协议标记为就绪，供服务管理入口区分进程占位和可用 Gateway。
- `surface-manager.ts`：按 `surface + accountId` 向已启动 Surface 集中路由 Core 输出，并为
  `turn.completed` 注入当前授权 Workspace 的 Git 分支和 Thread 累计总价；并行完成各 Surface 的首次启动，
  单个渠道启动或运行失败时只取消该渠道交互并独立退避恢复，不停止 Gateway 或其他渠道。
  首次启动和故障恢复期间只在有界内存队列中保留关键输出，就绪后按序补投；流式增量不积压。
  渠道未就绪时对应账号的新审批、用户输入与 MCP 交互立即失败关闭。
- `channel-image-spool.ts`：扫描 `data/channel-outbox/pending/` 的图片发送请求，按
  Thread 绑定解析目标会话，调用 `SurfaceManager.sendChannelImage` 由各渠道机器人凭据
  发送，成功归档到 `done/`、失败归档到 `failed/` 并保留原因；目录权限 `0700`，只接受
  pending 目录内的绝对图片路径。

业务状态和平台逻辑应留在对应模块，只有具体实现选择、交互端口注册与生命周期协调放在这里。
Provider 账户能力同样通过编译期显式注册：OpenAI 复用 Codex Client，第三方实现 Application
拥有的窄适配器；新增 Provider 不得动态加载，也不得把未知 Provider 回退到 OpenAI 账户查询。
新增内置 Surface 时实现一个 `BuiltInSurfacePlugin` 并加入显式注册表，不应向
`GatewayApplication` 添加平台专属字段。当前插件层只用于模块化单体内部装配，不扫描目录、
不动态导入包，也不是外部插件 API。
未启用 Surface 的持久绑定应保留但不恢复订阅。Gateway 关闭不得主动终止独立运行的 Codex App Server。
启动、停止和 App Server 重连由同一生命周期协调；单 Provider 断线只重连并恢复该侧订阅，
只取消该侧 Thread 的待处理交互，`thread/resume` 返回的活动 Turn 会重新归约到 Core。停止会中断启动中的 Codex 请求、取消并限时等待重连任务，且不会把主动关闭误判为永久
Thread 恢复失败。单个 Thread 被另一个 Codex 进程持有写锁时，组合根保留绑定并让 Gateway 与
其他 Thread 正常启动，按有界退避间隔只重试未恢复 Thread；占用与解除各投递一次结构化渠道通知。
停止会取消等待计时器并限时等待在途恢复，不删除官方写锁或绕过 App Server 单写约束。
启动失败、启动中停止和正常停止共享同一个组件关闭任务；除中断未完成连接所需
的 Client 关闭外，Surface、事件总线、Client 收尾和存储不会被组合根重复关闭。
