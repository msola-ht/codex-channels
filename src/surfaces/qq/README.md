# QQ 基础接入

本目录从 `feat/qq-adaptation`（`7a867db7`）迁入接入基础代码，注册为仅连接的 Gateway Surface。
可以通过 `codexc setup → 通讯渠道 → QQ` 扫码或手工保存凭据与允许名单，选择是否启用 WebSocket 基础连接。
消息层尚未接入：不调用 Application、不建立 Thread 绑定、不提交任务、不回复、不保存或重放来信。

## 文件与边界

- `index.ts`：QQ 模块公开出口。
- `surface.ts`：仅连接 Adapter，接入共享启停与故障重试；每代次拥有独立网络、Token 和 WebSocket。
  通过 `connectionOnly: true` 排除共享绑定恢复、消息执行准入、审批可用性及持久投递账号选择。
  允许用户的首个消息事件只记录一次不含正文的“消息层尚未接入”诊断；其余事件不进入业务处理。
  所有审批安全取消，消息输出显式拒绝，不把未发送当作成功。
  配置通知没有订阅对象，按空收件人集合完成，不调用平台或阻塞其他渠道的持久配置事件确认。
- `protocol.ts`：旧协议客户端仅保留 AppID/AppSecret 校验、Token 合并刷新、Gateway 地址发现、有界 HTTP 响应、
  取消和结构化错误；不包含发送、上传或流式消息接口。
- `transport.ts`：原样迁入 WebSocket 鉴权、心跳、接收序号、Resume、有限重连和关闭流程。
- `network.ts`：从旧 Surface 提取的网络资源接口；Bootstrap 的 `qq-network.ts` 保留每代次代理与连接池的所有权和关闭行为。

允许名单策略位于 `src/policy/qq-access.ts`。名单新增热加载，删除、账号或凭据变更以及启停要求重启 Gateway；
这些处理复用配置变更分类。QQ 没有已绑定的消息通知对象，状态通过本机 Setup、Doctor 与日志核对。
WebUI 沿用渠道状态摘要，QQ 凭据编辑仍使用 Setup，不新增 WebUI 编辑入口。

扫码 Worker 与生命周期入口位于 `scripts/qq-registration-worker.mjs` 和 `scripts/qq-registration.mjs`，
由 `qq-setup.mjs` 调用。锁定依赖 `@tencent-connect/qqbot-connector@1.2.0` 仅负责扫码材料取得；
没有代理注入能力，扫码使用直连；运行时 WebSocket/HTTP 使用共享网络代理。
移除扫码入口时应移除三份 QQ Setup/扫码脚本与该依赖。

## 数据与当前限制

配置复用私有 TOML、源修订核对和原子保存，不迁移旧 QQ 配置或其他用户数据。
本阶段不接入旧 `qq-transport` Ledger，不恢复或改写旧 QQ 绑定，不消费旧 QQ 持久投递记录，
不清理历史消息或发送记录。共享存储仍按既有启动流程读取最小状态，不增加 QQ 数据迁移或清理步骤。
回退前将 QQ 配置禁用；若回退版本不识别 `[qq]`，先私有备份配置并显式移除该配置段，
不要通过删除数据库或凭据目录绕过兼容校验。

本次不迁入旧 `content.ts`、`rendering.ts`、交互、计次 Ledger、附件处理或可靠投递接线。
会话关联仍在旧 Surface 内，与输入及输出链路耦合，留待消息层接入时处理。
连接失败使用受控错误；终止类关闭码锁定当前 Adapter，不借共享重试重新连接，修正配置后重启 Gateway。

协议参考见[上游来源](../../../docs/upstream-sources.md#qq-接入骨架基线)。
静态检查和本地观察不证明真实账号能力；真实扫码、QQ 服务端连接及三平台部署需分别验收。
