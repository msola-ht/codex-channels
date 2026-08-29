# 错误码与日志排查字典

本文档的表格记录 Gateway 主动产生、可安全展示给用户的 `UserFacingError` 错误码。日志里的
`errorCode` 还可能来自渠道 SDK 或协议边界的受控诊断码，不一定出现在下表；`errorMessage` 只在
已有受控用户文案时记录。内部异常不会把原始正文发给用户，但会在本地日志保留稳定分类和可安全
查看的上下文。

## 日志字段约定

渠道输入、输出和生命周期失败统一使用以下字段（能拿到时才出现）：

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| `surface` | 渠道标识 | `feishu`、`weixin`、`telegram` |
| `conversationId` | 外部会话标识 | `oc_...` |
| `messageId` | 触发失败的外部消息标识 | `om_...` |
| `errorType` | 错误构造类型或稳定分类 | `UserFacingError`、`TypeError` |
| `errorCode` | 用户错误码或受控渠道/协议诊断码 | `send-failed`、`429` |
| `errorMessage` | 受控、可向用户展示的文案 | `当前模型不支持图片输入` |
| `err` / `cause` | 本地诊断用的底层错误链 | 仅本地日志，分享前人工检查 |

安全边界：`UserFacingError` 的受控 `code`/`message` 可以同时进入结构化日志。其他错误不记录原始
`message`；只允许安全整数错误码、全大写稳定码，以及代码白名单中由渠道错误类型声明的小写
kebab-case 诊断码进入 `errorCode`，其余字符串会被剥离。这样既保留平台限流、发送失败等可检索
分类，又避免上游响应、凭据或本机路径泄密。

本地模型代理返回的 `provider_proxy_upstream_error` 会在 Codex Client 边界统一映射为“模型
Provider 上游暂时不可用或响应超时，有限重试后仍未恢复”；渠道不会显示回环代理地址、原始 5xx
正文或内部错误 JSON。DeepSeek、OpenCode Go 与自定义 Provider 的 HTTP 首次失败后最多再试
一次，流断开不再叠加重连；OpenAI 官方保持 Codex 原生策略。活动任务仍可随时使用 `/stop`，
三个渠道都会让精确停止命令绕过普通输入排队。

## 用户可见错误码字典

### 消息与会话

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `message.empty` | 消息不能为空 | 空消息提交 |
| `conversation.name.invalid` | 会话名称必须为 1–64 个字符 | 重命名会话时名称长度非法 |
| `conversation.missing` | 当前还没有 Codex Thread | 无绑定会话时执行需要 Thread 的命令 |
| `conversation.busy` | 当前任务运行中，请先使用 /stop 停止当前任务 | 任务运行中提交新消息或切换会话 |
| `conversation.background-limit` | 后台任务数量达到上限 | 后台 Thread 超过允许数量 |
| `conversation.background-queued` | 当前任务仍有下一 Turn 排队消息，暂不能切换会话 | 切换会话时存在排队输入 |

### 图片输入

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `image.url.invalid` | 图片必须使用 PNG、JPEG、WebP 或非动画 GIF Base64 Data URL | Application 收到非法内联图片输入 |
| `image.too-large` | 单张超过 10 MiB / 批量超过 20 MiB | 图片超过暂存大小限制 |
| `image.too-many` | 一次最多处理 4 张图片 | 单次发送图片过多 |
| `image.unsupported` | 仅支持 PNG、JPEG、WebP 和非动画 GIF 图片 | 图片类型不支持 |

### 音频输入

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `audio.path.invalid` | 本地音频路径必须是绝对路径 | 本地音频输入路径非法 |
| `audio.duration-missing` | 无法确认音频时长，请重新发送 | 音频时长字段缺失 |
| `audio.too-large` | 音频超过 20 MiB 限制 | 音频文件过大 |
| `audio.unsupported` | 仅支持 WAV、MP3、M4A、WebM 和 OGG 音频 | 音频类型不支持 |

### 模型与输入模态

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `model.current.missing` | 当前模型不在可用模型列表中 | 会话模型被目录移除 |
| `model.configured-default.missing` | 配置的默认模型不属于当前主 Provider | 配置的默认模型不在当前主 Provider 的模型目录中 |
| `model.unavailable` | 模型暂不可用并附原因 | 模型被上游禁用或不可用 |
| `model.provider.mismatch` | 当前线程运行在 X 账户，不能使用 Y Provider 的模型 | 继续/恢复旧 Thread 时暂存了跨 Provider 模型 |
| `model.selector.required` | /model 用法提示 | 未提供模型选择参数 |
| `model.selector.ambiguous` | 模型选择不唯一 | 选择器匹配多个模型 |
| `model.selector.not-found` | 找不到指定模型 | 选择器无匹配 |
| `model.input.image.unsupported` | 当前模型不支持图片输入 | 模型目录未声明图片模态 |
| `model.input.audio.unsupported` | 当前模型不支持语音输入 | 模型无音频模态 |
| `model.input.unsupported` | 当前模型不支持该输入类型 | 其他输入模态不支持 |
| `effort.unsupported` | 当前模型不支持该思考等级并附可选值 | 思考等级与模型不匹配 |
| `fast.usage` | /fast 用法提示 | 参数格式错误 |
| `fast.unsupported` | 当前模型不支持 Fast 模式 | Fast 与模型不兼容 |

### 会话、Thread 与 Workspace

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `session.selector.required` | /resume 用法提示 | 未提供会话选择参数 |
| `session.selector.ambiguous` | 会话选择不唯一 | 选择器匹配多个会话 |
| `session.selector.not-found` | 找不到指定会话 | 选择器无匹配 |
| `sessions.usage` | /sessions 用法提示 | 参数格式错误 |
| `archived-sessions.usage` | /archived 用法提示 | 参数格式错误 |
| `thread.bound` | 该 Codex Thread 已绑定到其他会话 | 跨会话接管已绑定 Thread |
| `thread.takeover.busy` | 原渠道或当前渠道仍有任务，暂不能接管 | 接管运行中的 Thread |
| `thread.takeover.workspace` | 只能接管当前 Workspace 中的 Thread | 跨 Workspace 接管 |
| `thread.takeover.changed` | 会话绑定刚刚发生变化，请重新打开会话列表后再试 | 接管期间绑定变更 |
| `thread-section.usage` | /section 用法提示 | 参数格式错误 |
| `thread-section.name.invalid` | Thread 分区名称必须为 1–64 个字符，且不能包含控制字符 | 创建或重命名分区时名称非法 |
| `thread-section.selector.ambiguous` | Thread 分区选择不唯一，请使用完整 ID | 分区选择器匹配多个 |
| `thread-section.selector.not-found` | 找不到指定 Thread 分区 | 分区选择器无匹配 |
| `thread-section.pinned.immutable` | 内置固定区不能重命名或删除；请使用 /pin 或 /unpin 管理固定状态 | 尝试重命名或删除内置固定区 |
| `thread-section.before.invalid` | before 指定的会话必须已经位于目标分区 | move 的 before 目标不在目标分区 |
| `thread-section.delete-confirmation.invalid` | 删除确认必须使用预览返回的完整 Thread 分区 ID | 删除确认文本不匹配 |
| `thread-section.admin-required` | 当前用户没有 Thread 分区写权限；请在 thread_sections.administrators 中配置对应渠道用户 ID，并重启 Gateway | 未配置分区管理员时执行分区写操作 |
| `workspace.missing` | Workspace 不存在或未获授权 | 配置的 Workspace 缺失 |
| `workspace.selector.required` | /workspace 用法提示 | 未提供 Workspace 选择参数 |
| `workspace.selector.ambiguous` | Workspace 选择不唯一 | 选择器匹配多个 Workspace |
| `workspace.selector.not-found` | 找不到指定 Workspace | 选择器无匹配 |
| `workspace.permission.usage` | /workspaceperm 用法提示 | 参数格式错误 |
| `workspace.permission.conflict` | permissions 与 sandbox 互斥，不能同时配置；请先清除其中一项 | 同时配置 permissions 与 sandbox |
| `workspace.permission.unavailable` | 当前 Gateway 不支持修改工作区权限 | Gateway 未装配权限修改能力 |

### 目标、队列与指标

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `goal.empty` | 目标不能为空 | /goal set 未提供目标 |
| `goal.usage` | /goal 用法提示 | 参数格式错误 |
| `queue.usage` | `/queue add|list|update|delete|reorder|start` 用法提示 | 参数格式错误 |
| `queue.unavailable` | 当前 App Server 不提供持久队列 | Queue 未装配或状态库不可用 |
| `queue.empty` | App Server Queue 为空 | 启动时没有可用条目 |
| `queue.busy` | 当前 Thread 有活动或待触发 Turn，请稍后重试 | 启动条目时 App Server 忙 |
| `queue.pending-overrides` | Queue 与待生效的模型、思考、Fast 或 Plan 选择不能同时存在；请先让其中一方处理完成 | Queue 与下一 Turn 设置同时待处理 |
| `queue.full` | App Server Queue 已满，最多 100 条 | 原生 Queue 达到容量 |
| `queue.snapshot.required` | 请先执行 `/queue list` 刷新数字选择快照 | 数字选择器快照过期 |
| `queue.item-not-found` | 找不到指定 Queue 条目，请使用完整 ID 或刷新列表 | 条目不存在或列表已变化 |
| `queue.item-not-editable` | 只有纯文本 Queue 条目可以更新 | 条目含非文本输入 |
| `queue.position.invalid` | Queue 目标位置必须在当前队列范围内 | reorder 位置无效 |
| `queue.reorder-conflict` | Queue 已发生变化，请刷新列表后重试排序 | 并发 reorder 失败 |
| `queue.failed` | Queue 操作失败，请稍后重试 | 未分类的 Queue 错误 |
| `scheduled-task.command.invalid` | `/schedule` 用法或参数提示 | 计划、页码、名称或文本格式无效 |
| `scheduled-task.confirmation.invalid` | 确认令牌无效、过期或已使用 | 创建/删除确认失效或上下文改变 |
| `scheduled-task.forbidden` | 当前用户无权管理该会话的计划任务 | Actor 未授权或身份缺失 |
| `scheduled-task.not-found` | 找不到指定计划任务或 Run | ID 不存在、已删除或不属于当前 Actor/Conversation |
| `scheduled-task.snapshot.required` | 请先刷新计划任务或 Run 列表 | 数字选择器快照缺失或过期 |
| `scheduled-task.state.invalid` | 当前状态不允许该计划任务操作 | 功能未启用、任务阻塞或 Run 不可重试 |
| `metrics.usage` | /metrics 用法提示 | 参数格式错误 |

### 提供商、协作模式与计划

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `provider.account.unavailable` | 提供商账户查询失败 | 账户余额或用量查询失败 |
| `collaboration-mode.unsupported` | 当前 App Server 不支持该协作模式 | 模式未被协议支持 |
| `collaboration-mode.unavailable` | Plan 模式服务不可用 | Plan 模式不可用 |
| `plan.prompt.empty` | Plan 需求不能为空 | Plan 输入为空 |

### Skill、命令与项目规则

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `skill.usage` | /skill 用法提示 | 参数格式错误 |
| `skill.not-found` | Skill 不存在、未启用或不属于当前 Workspace | Skill 选择器无匹配 |
| `command.unsupported` | 不支持该渠道命令，请发送 /help | 未知聊天命令 |
| `review.usage` | /review 用法提示 | 参数格式错误 |
| `rules.usage` | /rules 用法提示 | 参数格式错误 |
| `rules.exists` | 当前 Workspace 已有项目规则 | 重复初始化规则 |
| `rules.missing` | 当前 Workspace 尚未生成项目规则 | 未初始化时检查规则 |
| `rules.unsafe-path` | 项目规则路径包含符号链接，已拒绝写入 | 规则路径使用符号链接 |
| `rules.check-failed` | 项目规则检查失败 | Codex CLI 规则校验失败 |
| `rules.unavailable` | 项目规则服务当前不可用 | 规则服务未装配 |

### MCP、Plugin 与 Agents

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `mcp.usage` | /mcp 用法提示 | 参数格式错误 |
| `mcp.server.usage` | 需要提供 MCP Server 名称或序号 | 未提供 MCP Server 名称 |
| `mcp.server.not-found` | 指定的 MCP Server 不存在 | MCP Server 不存在 |
| `mcp.oauth.unsupported` | 该 MCP Server 不支持 OAuth 登录 | 对不支持 OAuth 的 Server 执行 login |
| `mcp.thread.required` | 请先发送消息创建 Thread，或使用 /resume 恢复 Thread 后再登录 MCP Server | 未绑定 Thread 时执行 MCP login |
| `mcp.resource.usage` | 需要提供有效的 MCP Resource URI | MCP resource 参数无效 |
| `plugin.usage` | /plugin 用法提示 | 参数格式错误 |
| `plugin.not-found` | 指定的 Plugin 不存在 | Plugin 选择器无匹配 |
| `plugin.ambiguous` | Plugin 名称不唯一，请使用序号或完整 ID | Plugin 名称匹配多个 |
| `plugin.unavailable` | 指定的 Plugin 未启用、被管理员禁用或暂不可调用 | Plugin 未启用或被禁用 |
| `plugin.disabled` | 开发中的 Plugin API 已关闭；请在 [experimental] 中启用 plugin_api 后重启 Gateway | plugin_api 开关关闭时调用 Plugin |
| `plugin.provider.unsupported` | 开发中的 Plugin 调用当前只支持 OpenAI Thread | 非 OpenAI Thread 调用开发中 Plugin |
| `agents.usage` | 需要提供子代理角色名称或序号及任务内容 | /agents 缺少角色或任务 |
| `agents.not-found` | 指定的子代理角色不存在；使用 /agents 查看可用角色 | 子代理角色不存在 |
| `agents.config-unreadable` | Codex 子代理角色配置无法安全读取；请检查 ~/.codex/config.toml | 角色配置无法安全读取 |

未知内部异常只显示 `Gateway 未能完成请求，请稍后重试`，日志里也只有 `errorType`；此时按
`surface` 与时间范围过滤日志，再查看同一时段的 `err`/`cause` 字段。
