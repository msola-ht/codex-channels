# QQ 渲染与流式分片审查记录

日期：2026-10-26

分支：`fix/channel-presentation-alignment`

审查基线：`ad8ab6ad` 加审查开始时的未提交工作树改动

审查范围：QQ 单聊引用图片、正文流式、最终续接、Markdown/普通文字分片及相关文档合同

审查性质：只读审查；未修改实现、未写测试、未提交、未部署、未向真实 QQ 发送消息

## 后续独立复核（主代理补记）

本文保留用户提供的原始静态审查意见，不将原建议直接当作当前合同。主代理及独立代理对相关链路复核后，当前处理如下；修复与实际证据集中记录在 [QQ 消息合同](qq-message-contract.md#本轮完整适配审查)。

- 第 1 项只采纳明确 `not-sent` 的有限收尾：最终重新核对原守卫和窗口，确认关闭旧前缀后才续接。不能笼统放开 `rejected`，也不能未关闭就主动续接。
- 第 2 项已按实际流检查点修正。影响限定为无既有或本次检查点的失败分类；`blocked` 与 `uncertain` 都有人工重试入口，原文“影响人工重试”不能解读为禁止重试。
- 第 3 项已保护 URL、明确绝对路径及链接目标的字素区间，超过单片预算时沿既有完整文件或明确未发处理，不能断开目标。
- 第 4 项保留为呈现限制：半个代码块或未完成语法不能安全解释为新 Markdown。没有为了减少文字回退而放宽安全检查。
- 第 5 项保持“引用只作上下文”的输入合同，纯引用缺少当前需求时补充明确提示，不静默丢弃。
- 第 6 项不采纳逐图降级后继续提交，以免模型在缺图情况下回答；整条拒绝现有明确回执。
- 第 7 项已把可复制确认命令移到最后操作提示，完整详情仍有原七片预算，授权仍以全计划送达为前提。

这些新增代码随后已按用户授权从未提交工作区构建部署并仅重启 Gateway，具体产物与进程证据见消息合同。用户授权的三条真实 QQ 格式样例和截图另外确认了美元字面转义方法；没有进行真实流式故障或收尾验证。本文原始结论和行号仍以文首基线解释。

## 结论摘要

当前实现的主链路在引用图片顺序、四张图片上限、一次附件提交作用域、零值 `remain_msg_len`、字素边界和八片上限方面是一致的。发现的主要问题集中在两个方向：

1. 流式预览出现一次已知失败后，即使旧前缀已经由平台确认，最终收尾也不会再尝试关闭或续接。
2. 分片器保证字素不被拆开，但不保证长 URL 等语义令牌不被拆开；流式续接又不能从段落中间的半个 Markdown 块恢复，长续接会退化成普通文字甚至文件。

另有引用上下文空正文、引用图片解析失败和 Hook 详情预算问题。

文档整理期间观察到工作区被其他任务并行修改。正文中的源码行号来自本次审查读取；使用结论前应重新核对当前 diff。并行修改已经消除了引用图片文档冲突，并部分改善了引用附件错误回执，具体见“并行变更记录”。

## 审查开始时的未提交文件

本轮审查对应的未提交文件：

- `docs/qq-message-contract.md`
- `src/bootstrap/qq-attachment-download.ts`
- `src/bootstrap/qq-network.ts`
- `src/surfaces/plan-presentation.ts`
- `src/surfaces/qq/command-menu-controller.ts`
- `src/surfaces/qq/inbound.ts`
- `src/surfaces/qq/media-input.ts`
- `src/surfaces/qq/messages.ts`
- `src/surfaces/qq/network.ts`
- `src/surfaces/qq/surface.ts`

未跟踪文件 `docs/ollama-cloud-probe.md` 与本审查无关，未读取、修改或删除。

`git diff --check` 通过。本审查自身没有产生源码或测试改动。

## 并行变更记录

审查完成后，观察到其他任务继续修改了 `docs/index.md`、`docs/user-guide.md`、`src/surfaces/qq/README.md`、`src/surfaces/qq/inbound.ts`、`src/surfaces/qq/messages.ts` 和 `src/surfaces/qq/message-markdown.ts` 等文件。本记录不接管这些修改。

与本文结论直接相关的并行变化：

- `src/surfaces/qq/inbound.ts:168` 现在会把引用附件字段错误包装成可回复的附件拒绝，因此第 6 项不再会完全静默，但整条当前消息仍会被拒绝。
- `src/surfaces/qq/messages.ts` 新增了权威响应 `steered=true` 后的追加回执；未观察到该改动与正文流序号 2 冲突。
- `src/surfaces/qq/message-markdown.ts` 把 Markdown 分片标题从 `**n/N**` 改为 `[n/N]`；不改变本文关于 URL 跨片和续接退化的结论。
- `src/surfaces/qq/README.md`、`docs/index.md` 和 `docs/user-guide.md` 已同步引用图片合同，原第 8 项“文档冲突”已消除。

## 高优先级

### 1. 已确认首帧后，任何后续预览失败都会阻断最终收尾

**状态：静态确认。未注入真实网络错误。**

**触发条件**

- 流式首帧已经成功，`stream.id` 和 `stream.sent` 有效。
- 后续某次预览更新或定时 `seal` 失败。
- 失败可能是明确 `not-sent`、业务 `rejected`，也可能是 `unknown`。

**影响**

用户只看到最后一次成功确认的前缀。最终正文不会再尝试关闭旧流或发送续接部分，随后完整投递进入失败或不确定路径。即使失败的是明确未发送的中间帧，旧流仍具备收尾条件，但当前实现不会利用。

**证据**

- `src/surfaces/qq/streaming.ts:95` 在 `update()` 的 `catch` 中不区分失败结果，统一设置 `stream.failed = true`。
- `src/surfaces/qq/streaming.ts:142` 在 `finish()` 中只要看到 `stream.failed` 就抛 `invalid-response`，不再检查失败是否明确未发送。
- `src/surfaces/qq/streaming.ts:307` 只有成功响应会更新 `id` 和 `sent`；未知结果只设置 `attempted`。

**建议**

为流增加明确的失败状态，例如 `failure: "not-sent" | "rejected" | "unknown"`。只有 `unknown` 必须失败关闭；已有确认前缀时，`not-sent` 或可重试拒绝应允许重新发送结束帧，或从最后的 `sent` 进入主动续接。日志应保留原始 `QqTextSendError.outcome` 和协议原因。

### 2. “预览已准入”被当成“平台已收到预览”

**状态：静态确认。**

**触发条件**

- 增量文本满足显示条件，因此 `previewAdmitted` 已设置。
- 来源尚未确认、被动窗口不足或队列尚未执行，实际没有任何流帧被发送。
- 最终完整正文在发送前得到明确的 `SurfaceDeliveryNotSentError`。

**影响**

明确未发送的完整投递会被提升为普通不确定错误。持久投递和 Bootstrap 无法据此使用明确的 `blocked` 或未发送语义，影响人工重试、故障分类和诊断。该问题不会造成重复发送。

**证据**

- `src/surfaces/qq/streaming.ts:80` 在观察增量时设置 `previewAdmitted`，此时没有网络请求。
- `src/surfaces/qq/streaming.ts:101` 只暴露这个准入标记。
- `src/surfaces/qq/messages.ts:409` 用 `hasAdmittedPreview` 计算 `hadPreview`。
- `src/surfaces/qq/messages.ts:447` 因 `hadPreview` 把 `SurfaceDeliveryNotSentError` 改成普通错误。

**建议**

区分三个状态：

- `hasAdmittedPreview`：只表示允许展示，用于 commentary 和状态判断。
- `hasAttemptedPreview`：至少发起过一次平台请求。
- `hasConfirmedPreview`：至少收到过一次合法流响应。

投递失败分类应依据实际尝试和确认状态，而不是准入状态。

## 中优先级

### 3. 普通文字回退可能从长 URL 中间分片

**状态：分片机制静态确认；真实客户端链接表现未观察。**

**触发条件**

- 正文因不安全 Markdown、超长 Markdown 块或被动回复预算回退到普通文字。
- 一个长 URL 跨越 2000 字节分片边界。

**影响**

分片器按字素填充字节预算，HTML 或 Markdown 链接中的 ASCII URL 会被视为普通字素。分片包装 `[n/N]\n` 会插入 URL 中间，使链接不可直接点击或复制使用。正文内容本身仍完整。

**证据**

- `src/surfaces/qq/outbox.ts:318` 逐字素累计字节，不识别 URL、链接目标或文件路径。
- `src/surfaces/qq/message-markdown.ts:89` 的 Markdown 字面回退使用同样的字素切分。

**建议**

将完整 HTTP(S) URL、Markdown 链接目标和明确文件路径作为不可拆令牌。单个令牌超过分片预算时，应明确拒绝、提示查看原文或转文件，不要把分片标题插进令牌内部。

### 4. 长无空行正文在流式续接时退化为普通文字，严重时转文件

**状态：代码路径确认；真实长任务跨窗口表现未观察。**

**触发条件**

- 流在段落中间关闭，例如剩余 45 秒窗口触发 `seal`，或正文、帧数预算耗尽。
- 最终剩余正文后面没有至少一个完整 Markdown 块。

**影响**

续接正文会按字面文本发送。若剩余内容超过普通文字八片容量，可能转成 `codex-result.txt`，即使它本来可以放入一个 5000 字符的 Markdown 正文分片。

**证据**

- `src/surfaces/qq/streaming.ts:162` 用 `qqBodyMarkdownRestart(text, stream.sent.length)` 选择续接恢复点。
- 段落中间关闭时，恢复点通常等于正文末尾。
- `src/surfaces/qq/message-markdown.ts:68` 从该恢复点切出正文；前面半个块只能作为字面前缀。
- `src/surfaces/qq/message-markdown.ts:99` 没有 Markdown 分片时返回 `undefined`，由 Outbox 回退普通文字或文件。

这是“不能从半个 Markdown 块恢复”的保守设计造成的可见体验，不是内容完整性问题。取消空行等待后，长无空行正文在窗口边界关闭时容易触发。

**建议**

优先在关闭前缀前选择可恢复的完整块边界；如果无法做到，评估对独立后缀做安全 Markdown 解析。至少在续接内容仍能放入单个正文 Markdown 分片时避免直接转文件。

### 5. 纯引用上下文仍会被空正文检查拒绝

**状态：入站条件静态确认；真实 QQ 纯引用事件形状未观察。**

**触发条件**

- `message_type=103`。
- 当前消息正文为空或只有空白。
- 当前没有图片、文件或音视频。
- 已验证的匹配引用元素只有文本或图片。

**影响**

消息以 `content/empty` 拒绝，用户没有写入新内容但只发送一个引用的场景无法进入任务。这条拒绝路径也不会生成附件拒绝提示。

**证据**

- `src/surfaces/qq/inbound.ts:160` 已解析引用内容。
- `src/surfaces/qq/inbound.ts:176` 只检查当前 `content`、当前 `images`、`file` 和 `media`，没有检查 `reference.text` 或 `reference.images`。

**建议**

空正文条件同时考虑已验证的引用文本和引用图片。若要显式禁止纯引用任务，应给出可归属的受控提示，不要让消息静默变成 malformed。

### 6. 引用图片解析失败仍会连当前正文一起拒绝

**状态：拒绝行为静态确认；并行修改已补充回执，但“缺失 URL 或过期引用”的官方实际事件未观察。**

**触发条件**

- 匹配引用元素中的图片缺少可用 URL。
- MIME 不属于 JPEG、PNG、GIF。
- 图片元数据超限或格式异常。

**影响**

严格图片解析返回 Rejection，整条当前消息被拒绝，当前正文也不会提交。并行修改已经为 `field=attachments` 的引用错误建立可回复的附件拒绝，因此不再是完全静默；但当前正文仍无法单独提交，也不会降级为引用图片未读取注记。

**证据**

- `src/surfaces/qq/inbound.ts:287` 对引用图片调用严格 `parseImages`。
- `src/surfaces/qq/inbound.ts:295` 至 `src/surfaces/qq/inbound.ts:314` 对每张图片执行类型、URL、大小和元数据校验。
- `src/surfaces/qq/inbound.ts:168` 将引用附件错误包装为 `attachmentFailure`；其他引用错误仍在附件准入前返回。

锁定官方快照列出了附件 `url` 字段，但过期引用或远端状态是否省略 URL 尚未取得实机样例。

**建议**

对引用图片采用逐图降级：无法安全读取时保留固定的“[引用消息包含图片，未读取]”，不阻断安全读取的当前正文。若产品要求严格拒绝，也应生成明确的受控回执并避免输出附件 URL。

## 低优先级

### 7. Hook 确认提示可能把原本可展示的详情推过预算

**状态：静态确认。**

**触发条件**

- Hook 详情在追加 `/hooks confirm ...` 前恰好需要 7 个普通文字分片。
- 追加确认提示后变成 8 片。

**影响**

`hookResult` 会抛出“Hook 详情超出完整展示预算”，用户无法查看原本仍能完整展示的 Hook 审查信息。

**证据**

- `src/surfaces/qq/command-menu-controller.ts:633` 先查找确认命令。
- `src/surfaces/qq/command-menu-controller.ts:634` 把提示拼入详情。
- `src/surfaces/qq/command-menu-controller.ts:639` 才执行最多 7 片的检查。

**建议**

只在剩余预算允许时追加确认命令提示；也可以把该提示放入独立控制消息。不能因为新增操作提示丢失必要的审查详情。

## 已核实正确或与当前合同一致

- 斜杠命令和 `/respond` 在引用图片合并、下载之前处理，不会因引用图片触发下载。相关入口在 `src/surfaces/qq/messages.ts:698`，引用图片合并从 `src/surfaces/qq/messages.ts:888` 开始。
- 当前图片和引用图片按“当前在前、引用在后”合并，共用一次准备和提交作用域，最多四张，并继续受单图 10 MiB、整批 20 MiB 约束。
- 引用图片与当前文件或音视频混用会明确拒绝。
- 流式 `remain_msg_len=0` 被视为未知而不是耗尽；正数会保守收紧容量。
- 流式预览保留最后一个字素，并把安全扫描结果再次对齐到原文字素边界。
- Markdown 正文按码点预算分片，普通文字按 UTF-8 字节预算分片，均限制在八片以内；单聊被动回复序号限制在 1 至 4。
- `planQqBodyMarkdown` 不会把安全块和字面块错误合并；不同表示各自使用对应预算。

## 未观察边界

- 未向真实 QQ 发送消息，也未观察移动端、桌面端 Markdown、长 URL、续接气泡或文件降级后的实际外观。
- 未注入首帧成功后的后续流失败，因此第 1 项的真实持久投递状态和用户提示未验证。
- 未构造来源未确认但已经 `previewAdmitted` 的完整失败路径，第 2 项仅由代码控制流确认。
- 未取得纯引用消息、过期引用图片或缺少 URL 引用图片的真实平台事件，第 5、6 项的实际事件形状仍需平台样例。
- 未验证长任务跨 300 秒窗口、平台限流、撤权、断线、检查点失败和人工重试导致的重复显示。

## 下一步优先顺序

1. 修复流状态，保留中间帧失败分类，并允许已有确认前缀在明确未发送后收尾。
2. 把“已准入”和“已尝试发送”拆开，恢复可靠的未发送分类。
3. 处理长 URL 和续接退化，优先避免跨片拆链接及可放入单个 Markdown 分片的内容转文件。
4. 补齐纯引用和引用图片解析失败的降级路径。
5. 修正 Hook 详情预算。
