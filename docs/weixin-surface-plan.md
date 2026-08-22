# 微信 Surface 设计决策

## 文档定位

本页只记录微信 Surface 当前仍有效的上游基线、接入决策、安全边界和停止条件，不再维护阶段实施
流水。

- 当前实现与文件职责以 [`src/surfaces/weixin/README.md`](../src/surfaces/weixin/README.md) 为准。
- 真实平台验收状态以 [`通讯渠道验收矩阵`](channel-acceptance-matrix.md) 为唯一入口。
- 上游源码固定与更新方式见 [`本地上游源码工作流`](upstream-sources.md)。
- 通用渠道约束见 [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)。

历史二维码实验、协议探针、阶段清单和日期流水保留在 Git 历史中，不再作为当前事实来源。

## 官方参考基线

微信协议研究基线固定为腾讯官方
[`Tencent/openclaw-weixin v2.4.6`](https://github.com/Tencent/openclaw-weixin/tree/v2.4.6)，
对应提交
[`cef0bfc`](https://github.com/Tencent/openclaw-weixin/commit/cef0bfc390393f716903e16d50408118047f87e0)。

本项目只参考固定标签中的扫码、HTTP JSON、长轮询、媒体、输入状态和消息发送合同：

- 不以官方浮动 `main` 替代固定标签；
- 不采用 OpenClaw 的 Channel、会话、授权或路由实现；
- MIT 许可证不自动证明线上后端允许任意第三方客户端；API 使用约束变化时必须停止并重新评审；
- 上游基线变化时先更新 [`upstream-sources.md`](upstream-sources.md)，再修改实现与测试。

## 当前范围

微信只支持单 Bot 账号和已授权用户之间的私聊。当前已接入：

- 文本、平台引用、PNG/JPEG/WebP/非动画 GIF、可信语音转写、UTF-8 文本文件，以及受限 MP3/OGG 的接收校验；
- 共享会话、Workspace、模型、Fast、Goal、用量和其他平台无关命令；
- 精确文本审批、用户输入和 MCP elicitation；
- 原生输入状态、块式最终回复、操作过程、Turn 统计和生成图片回传；
- Setup、Doctor、私有游标、安全凭据、加密回复上下文和重启恢复。

群聊、多账号、原生交互按钮、原生流式编辑、定时主动推送、SILK、视频、Office、压缩包及其他
通用二进制输入均不支持。
当前模型目录未声明 `audio` 时，原始 MP3/OGG 会在创建或追加 Turn 前明确拒绝，不视为端到端
语音支持。

## 不引入第二个 Gateway

不安装 OpenClaw、不启动 OpenClaw Gateway，也不把
`@tencent-weixin/openclaw-weixin` 作为运行时依赖。项目只在
`src/surfaces/weixin/` 内实现固定版本所需的最小协议 Adapter：

```text
微信 ClawBot
  ↓ 扫码 / HTTP JSON / getupdates
Weixin Surface
  ↓
Policy / Application / Core / Approval / Routing
  ↓
共享 Codex App Server
```

- 微信协议、二维码、媒体和错误类型不得离开微信目录。
- Bootstrap 通过编译期内置插件注册表显式组合，不扫描目录、不动态加载 npm 插件。
- 普通输入和共享命令复用 Application；输出复用 `ConversationDeliveryQueue`。
- 微信不得导入 `codex-client`、`codex-protocol` 或其他 Surface 的内部实现。
- Gateway 停止或微信故障不得终止共享 App Server。

## 身份、授权与状态

- Surface ID 固定为 `weixin`；账号和 Actor 使用固定协议返回的完整字符串身份。
- 只接受当前 Bot、已授权 Actor 和私聊消息；未知、畸形、重复、过旧或未授权输入失败关闭。
- 公开本地命令只保留 `/wx doctor`；未知或旧命令明确拒绝，不作为模型输入。
- App Server 是 Thread、Turn、Item、Goal 和历史的唯一事实来源。
- 微信回复上下文和轮询游标只服务平台传输，不形成第二套会话状态。

## 凭据、游标与回复上下文

- Bot Token 使用独立安全凭据 Store；macOS 使用 Keychain，Linux 使用 AES-256-GCM 私有文件。
- `get_updates_buf` 使用账号隔离、严格版本和原子替换的私有检查点。
- 最近 `context_token` 使用独立加密回复上下文后端，只用于已有授权绑定的回复、上线和受限配置
  通知。
- Token、`context_token`、游标、二维码、CDN URL、AES Key、消息正文和原始响应不得进入 TOML、
  SQLite、日志或平台消息。
- 消息批次只有在业务处理全部成功后才推进游标；进程在提交后、保存游标前退出时允许至少一次
  重放，不伪造无法证明的精确一次语义。

## 网络、媒体与交互

- JSON API、CDN 下载和上传统一使用项目代理感知 Fetch、超时、取消和有界响应读取。
- 只接受固定官方 CDN 与受支持媒体合同；图片、音频和文本文件分别执行大小、签名、完整性、
  格式和保留期校验。
- 普通回复采用官方已验证的块式消息，不模拟原生流式编辑。
- 输入状态票据只在内存有界缓存，失败不阻断正常回复。
- 审批和 MCP 交互只接受包含不可预测一次性 ID 的精确命令；裸数字、模糊同意、过期、重复或跨
  Actor/Conversation 动作必须拒绝。
- 平台发送返回回复上下文失效时，只清除对应 Conversation 的上下文，等待后续入站消息自然恢复。

## 未支持边界与停止条件

出现以下任一情况时必须停止当前改造并单独评审：

- 官方协议、API 使用约束或服务条款不允许独立客户端接入；
- 必须运行 OpenClaw Gateway 才能获得受支持连接；
- 登录、Token 撤销、游标确认、消息身份或媒体合同无法形成稳定边界；
- 需要保存消息正文、完整事件或明文凭据才能工作；
- 需要迁移或共用其他 Surface 的凭据记录；
- 需要修改 Codex App Server 协议、SQLite Schema 或复制其他模块状态；
- 平台没有安全交互能力却要求放宽审批规则。

## 验证与变更

新增微信能力时：

1. 先确认本地 `upstream/openclaw-weixin` 与固定基线一致。
2. 查阅固定源码和现有合同探针，不从官方 `main` 猜测协议。
3. 更新模块 README、实现和最接近边界的测试。
4. 真实平台结论只更新 [`channel-acceptance-matrix.md`](channel-acceptance-matrix.md)。
5. 运行定向测试、`npm run docs:check` 和受影响的提交门禁。
6. 未经用户明确要求，不执行真实扫码、发送平台消息、提交、推送、发布或部署。
