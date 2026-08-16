# 错误码与日志排查字典

本文档用于定位渠道上报的错误：日志里的 `errorCode` 直接对应下表，`errorMessage` 是受控的
用户可见文案。内部异常不会把原始正文发给用户，但会在本地日志保留稳定分类和可安全查看的
上下文。

## 日志字段约定

渠道输入、输出和生命周期失败统一使用以下字段（能拿到时才出现）：

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| `surface` | 渠道标识 | `feishu`、`weixin`、`telegram` |
| `conversationId` | 外部会话标识 | `oc_...` |
| `messageId` | 触发失败的外部消息标识 | `om_...` |
| `errorType` | 错误构造类型或稳定分类 | `UserFacingError`、`vision_timeout` |
| `errorCode` | 稳定错误码 | `vision.failed`、`image.too-large` |
| `errorMessage` | 受控、可向用户展示的文案 | `图片识别失败` |
| `err` / `cause` | 本地诊断用的底层错误链 | 仅本地日志，分享前人工检查 |

安全边界：只有 `UserFacingError` 的受控 `code`/`message` 会进入结构化日志；普通内部错误只记录
`errorType`，原始 `message` 不落日志，防止上游响应、凭据或本机路径泄密。视觉识别等自产错误
（HTTP 状态、超时、网络错误）会单独记录稳定分类和受控说明。

## 错误码字典

### 消息与会话

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `message.empty` | 消息不能为空 | 空消息提交 |
| `conversation.name.invalid` | 会话名称必须为 1–64 个字符 | 重命名会话时名称长度非法 |
| `conversation.missing` | 当前还没有 Codex Thread | 无绑定会话时执行需要 Thread 的命令 |
| `conversation.busy` | 当前任务运行中，请先使用 /stop 停止当前任务 | 任务运行中提交新消息或切换会话 |
| `conversation.background-limit` | 后台任务数量达到上限 | 后台 Thread 超过允许数量 |
| `conversation.background-queued` | 当前任务仍有下一 Turn 排队消息，暂不能切换会话 | 切换会话时存在排队输入 |

### 图片输入与视觉识别

| 错误码 | 用户提示 | 典型触发 |
| --- | --- | --- |
| `image.path.invalid` | 本地图片路径必须是绝对路径 | 本地图片输入路径非法 |
| `image.too-large` | 单张超过 10 MiB / 批量超过 20 MiB | 图片超过暂存大小限制 |
| `image.too-many` | 一次最多处理 4 张图片 | 单次发送图片过多 |
| `image.unsupported` | 仅支持 PNG 和 JPEG 图片 | 图片类型不支持 |
| `vision.busy` | 视觉识别任务繁忙，请稍后重试 | 同时超过两个外部识图请求 |
| `vision.failed` | 图片识别失败，可在 5 分钟内发送 /vision retry 重试 | 外部视觉 API 失败或超时 |
| `vision.retry.missing` | 当前没有可重试的图片识别任务 | 无可重试记录时执行 /vision retry |
| `vision.command.usage` | /vision 命令用法提示 | 参数格式错误 |
| `vision.prompt.invalid` | 图片识别要求必须为 1 至 4000 个字符 | 识别要求超长或为空 |
| `vision.prompt.capacity` | 待处理的图片识别要求已满 | 待处理队列已满 |
| `vision.collection.active` | 正在收集多张图片，请先 /vision done 或 /vision cancel | 多图收集进行中再次提交 |
| `vision.collection.missing` | 当前没有进行中的多图收集 | 未开始收集时执行 /vision done |
| `vision.collection.empty` | 请先发送至少一张图片，再使用 /vision done | 无图片时完成收集 |
| `vision.collection.count.invalid` | 多图数量必须为 2 至指定数量 | 收集数量参数非法 |
| `vision.collection.count.exceeded` | 本次只需指定数量图片 | 发送图片多于预期 |

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
| `model.selector.required` | /model 用法提示 | 未提供模型选择参数 |
| `model.selector.ambiguous` | 模型选择不唯一 | 选择器匹配多个模型 |
| `model.selector.not-found` | 找不到指定模型 | 选择器无匹配 |
| `model.input.image.unsupported` | 当前模型不支持图片输入 | 模型无图片模态且未启用视觉代理 |
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
| `queue.usage` | /queue 用法提示 | 参数格式错误 |
| `queue.inactive` | 当前没有运行中的任务 | 无活动 Turn 时排队 |
| `queue.full` | 下一 Turn 队列已满，最多 10 条 | 排队消息超过上限 |
| `queue.thread-changed` | 排队消息所属会话已切换，队列已清空 | 排队期间会话切换 |
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

## 排查示例

飞书图片发送失败时，日志应同时出现两行：

```text
errorType=vision_timeout httpStatus=503 errorMessage="视觉 API 请求超时（120000 毫秒）"
errorType=UserFacingError errorCode=vision.failed errorMessage=图片识别失败
```

第一行来自视觉代理，是底层原因；第二行来自渠道消息处理，是用户可见错误。若只有第二行，
说明视觉代理错误日志尚未产生，检查 `[vision]` 配置是否指向可用端点。

未知内部异常只显示 `Gateway 未能完成请求，请稍后重试`，日志里也只有 `errorType`；此时按
`surface` 与时间范围过滤日志，再查看同一时段的 `err`/`cause` 字段。
