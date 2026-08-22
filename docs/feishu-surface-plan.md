# 飞书 Surface 设计决策

## 文档定位

本页只记录飞书 Surface 当前仍有效的设计决策、平台边界和停止条件，不再保存分阶段实施流水或
逐项验收状态。

- 当前实现与文件职责以 [`src/surfaces/feishu/README.md`](../src/surfaces/feishu/README.md) 为准。
- 真实平台验收状态以 [`通讯渠道验收矩阵`](channel-acceptance-matrix.md) 为唯一入口。
- 官方资料、固定 SDK 和本地实现映射见
  [`飞书官方资料与实现索引`](feishu-reference-index.md)。
- 通用渠道约束见 [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)。

历史阶段清单、实验记录和日期流水保留在 Git 历史中，不再作为当前事实来源。

## 当前范围

飞书通过企业自建应用的 WebSocket 长连接接入 Gateway，只支持已授权用户的私聊。当前已接入：

- 普通文本、纯文字富文本、代码块与 Markdown 富文本、PNG/JPEG/WebP/非动画 GIF、一次性音频和受限 UTF-8 文本文件输入；
- 共享会话、Workspace、模型、Fast、Goal、用量、项目规则和其他平台无关命令；
- 命令、文件、权限、用户输入和 MCP elicitation 的 CardKit 交互；
- CardKit Markdown 静态与原生流式回复、操作过程、Thread 状态和 Turn 完成统计；
- 生成图片回传、Setup、Doctor、按需用户 OAuth 和安全凭据恢复。

群聊、Lark、Office/压缩包等通用二进制文件、任意主动推送和未列入
[`docs/index.md`](index.md) 支持矩阵的 Codex 能力均不支持。

## 固定架构

```text
飞书私聊事件
  ↓
Feishu Surface
  ↓
Policy / Application / Session Routing / Conversation Core
  ↓
共享 Codex App Server
  ↓
OutputEvent
  ↓
Feishu 有界输出队列
```

- App Server 是 Thread、Turn、Item、Goal 和历史的唯一事实来源。
- 飞书 SDK 类型只存在于 `src/surfaces/feishu/`，不得进入 Application、Core、Approval、
  Policy、Session Routing 或 Storage。
- Bootstrap 是唯一组合根；飞书通过编译期内置插件显式注册，不扫描目录、不动态加载平台插件。
- Surface 复用共享 `ConversationService`、`ConversationCommandService`、Approval、
  `SurfaceAccessPolicy` 和 `ConversationDeliveryQueue`，不复制平台无关业务状态。
- Gateway 停止或飞书故障不得终止共享 App Server。

## 平台与传输决策

- 官方 Node SDK 固定为项目 lockfile 解析的 `1.73.0`；升级前必须更新
  [`feishu-reference-index.md`](feishu-reference-index.md) 并重新核对真实合同。
- 使用低层 `Client`、`WSClient` 和事件分发能力，不采用会重复管理授权、队列、重试或会话状态的
  高层 Channel。
- 消息事件、菜单事件和卡片动作在 SDK 回调中只做同步裁剪和有界入队，不等待 Application 或平台
  网络请求。
- 同一 Chat 的输入和输出保持顺序，不同 Chat 可以并行；平台超时、限流和失败不得阻塞 App
  Server Reader。
- 非幂等消息或卡片创建失败后不盲目换格式重发，避免重复消息。
- HTTP、OAuth 和 WebSocket 统一使用项目代理解析结果，不增加飞书私有代理配置。

## 身份与授权

- `surface + appId + chatId` 标识 Conversation，`open_id` 标识当前应用作用域内的 Actor。
- 只接受当前 App、已授权 Actor 和私聊消息；缺少 App、Chat、Actor 或消息标识时失败关闭。
- 菜单、选择卡、输入卡和审批卡动作必须绑定 App、Chat、消息、Actor 和一次性令牌。
- 公开本地命令只保留 `/fs <status|doctor|revoke>`；未知或旧命令明确拒绝，不作为模型输入。
- 用户 OAuth 只申请当前能力缺失且应用已经开通的 Scope，不提供全量预授权命令。
- macOS Token 使用 Keychain；Linux 使用独立 AES-256-GCM 私有凭据文件。Token 不进入 TOML、
  StateStore、Application/Core、日志或平台消息。

## 输入、输出与持久化

- Surface 在下载后完成大小、内容签名、格式和保留期校验，Application 只接收受管本机路径或
  已验证的内联文本。
- 不持久化消息正文、平台事件原文、卡片内容、审批详情或完整会话历史。
- SQLite 只保存共享会话恢复所需的最小绑定；飞书 OAuth 使用独立安全凭据后端。
- 操作详情、错误和平台响应在进入消息前必须经过现有脱敏边界；Token、Cookie、
  Authorization Header 和未经约束的上游正文不得显示。
- 生成图片只读取 App Server 明确提供且通过共享文件边界验证的 PNG/JPEG；渠道 spool 图片
  （`codexc channel send-image`）同样只接受通过共享文件边界验证的 PNG/JPEG，且只发送到
  Thread 绑定会话。

## 未支持边界与停止条件

出现以下任一情况时必须单独评审，不能通过宽松解析或额外兼容层绕过：

- 需要修改 Codex App Server 协议或复制 Application/Core 状态；
- 需要新增独立 Gateway、消息代理、动态插件加载或公网无认证回调；
- 需要改变 SQLite Schema 或持久化消息、事件原文、审批内容；
- SDK 高层策略无法关闭并与现有 Policy、队列或审批形成双重事实来源；
- 群聊身份、群允许名单和 `@Bot` 触发边界没有可验证合同；
- 真实事件、权限、重投、限流或代理行为与固定版本依据不一致。

## 验证与变更

新增飞书能力时：

1. 先查阅 [`feishu-reference-index.md`](feishu-reference-index.md) 和锁定 SDK 源码。
2. 更新模块 README、实现和最接近边界的测试。
3. 真实平台结论只更新 [`channel-acceptance-matrix.md`](channel-acceptance-matrix.md)。
4. 运行定向测试、`npm run docs:check` 和受影响的提交门禁。
5. 未经用户明确要求，不发送真实平台消息、提交、推送、发布或部署。
