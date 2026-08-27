import {
  fastServiceTierId,
  isFastServiceTier,
  supportsMcpOAuthLogin,
  type ConversationCommandName,
  type ConversationCommandOutcome,
  type ConversationCommandResult,
  type ConversationStatus,
  type AccountMetric,
  type AccountThreadUsage,
  type AccountThreadUsageGroup,
  type McpResourceContent,
  type ThreadQueueInputType,
  type ThreadQueueItem,
} from "../application/index.js";
import {
  usesOpenAiAccount,
  type ThreadGoal,
} from "../conversation-core/index.js";

import {
  formatModelUsageBucket,
  formatPercent,
  formatPlanType,
  formatRateLimitState,
  formatRemainingRateLimitWindow,
  formatRateLimitWindow,
  formatResetTime,
} from "./account-format.js";
import {
  formatElapsedSeconds,
} from "./elapsed-duration.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import {
  formatCodexProviderLabel,
  supportsFastMode,
} from "./provider-format.js";
import { formatCurrencyNanos } from "./reference-cost-format.js";
import {
  formatCacheHitRate,
  formatTokenCount,
} from "./token-format.js";

const maximumSessionEntries = 20;
const maximumSessionLabelCharacters = 48;
const maximumMcpDetailEntries = 8;
const maximumMcpHealthFindings = 8;
const maximumMcpDetailSectionCharacters = 5_000;
const maximumMcpDescriptionCharacters = 240;
const maximumMcpOutputCharacters = 20_000;
const maximumProcessCommandCharacters = 160;
const maximumThreadUsageGroups = 8;
const mcpToolAccessNotice =
  "工具读写属性来自 MCP 上游声明，仅供提示；实际调用仍按审批策略处理。";

export const conversationCommandDescriptions = {
  resume: "列出或恢复 Codex 会话",
  sessions: "搜索可恢复会话",
  archived: "搜索已归档会话",
  new: "下一条消息创建新会话",
  archive: "归档当前会话",
  unarchive: "恢复已归档会话",
  pin: "固定当前会话",
  unpin: "取消固定当前会话",
  section: "查看或管理 Codex Thread 分区",
  status: "查看当前状态",
  workspace: "列出或切换 Workspace",
  workspaceperm: "查看或修改当前工作区权限",
  stop: "停止当前任务",
  queue: "管理 App Server 持久队列",
  revert: "回退当前 Thread 的分页历史",
  rename: "命名当前会话",
  compact: "压缩当前上下文",
  fork: "分叉当前会话",
  review: "启动代码审查",
  model: "查看或切换模型",
  effort: "查看或切换思考等级",
  fast: "查看或切换 Fast 模式",
  skill: "查看或调用 Skill",
  mcp: "检查或管理 MCP、登录 OAuth、浏览或读取资源",
  plugin: "列出、查看或调用 Plugin（开发中）",
  usage: "查看账号与当前 Thread 用量",
  metrics: "查看会话、聚合或异常请求指标",
  limits: "查看套餐与额度",
  permissions: "查看权限配置",
  rules: "生成或检查项目规则",
  diff: "查看当前 Turn Diff",
  plan: "切换 Plan 模式或直接开始规划",
  goal: "查看或管理 Goal",
  agents: "查看或调用子代理",
  release: "查看或释放被占用的 Codex 会话",
  schedule: "管理 Gateway 计划任务",
} satisfies Record<ConversationCommandName, string>;

export const conversationCommandHelpSections = [
  {
    title: "会话：",
    lines: [
      "/resume [序号|名称|Thread ID]",
      "/sessions [页码] [filter all|running|pinned|unsectioned] [provider 名称] [section 分区] [search 搜索词]",
      "/archived [页码] [filter all|pinned|unsectioned] [provider 名称] [section 分区] [search 搜索词]",
      "/new · /archive · /unarchive <序号|名称|Thread ID>",
      "/pin · /unpin",
      "/section（查看）· 管理员：/section create <名称> · /section rename <分区序号或 ID> <新名称>",
      "管理员：/section move <分区序号或 ID> [before <会话>] · /section remove · /section delete <分区序号或 ID>",
      "/rename <名称> · /compact · /fork",
    ],
  },
  {
    title: "运行与项目：",
    lines: [
      "/status · /workspace [序号|ID|名称] · /workspaceperm",
      "/stop · /queue add <文本> · /queue list [页码]",
      "/queue update <完整 ID 或列表序号> <文本> · /queue delete <完整 ID 或列表序号>",
      "/queue reorder <完整 ID 或列表序号> <目标位置> · /queue start [完整 ID 或列表序号]",
      "/revert list [页码] · /revert <Turn ID 或列表序号> · /revert confirm <一次性令牌>",
      "/review [branch <分支>|commit <SHA>|custom <说明>]",
      "/rules <init|check> · /diff",
      "/release · /release force",
      "/schedule list · /schedule runs <任务> [页码]",
      "/schedule add <interval|once|monthly|daily|weekdays|weekly> ... · /schedule pause|resume|run|delete <任务>",
      "/plan [规划需求] · /goal [set <目标>|clear]",
    ],
  },
  {
    title: "模型与能力：",
    lines: [
      "/model [序号|模型 ID|名称|clear]",
      "/effort [序号|档位] · /fast [on|off|status]",
      "/skill · /skills [名称或序号 任务]",
      "/agents [角色名称或序号 任务]",
      "/mcp [名称或序号]",
      "/mcp health · /mcp reload",
      "/mcp <名称或序号> <tools|resources|templates> [页码] [search <关键词>]",
      "/mcp login <名称或序号>",
      "/mcp resource <名称或序号> <URI>",
      "/plugin · /plugin health · /plugin list [页码] [search <关键词>]",
      "/plugin <名称、完整 ID 或序号> [任务]",
      "/usage · /limits · /permissions",
      "/metrics session",
      "/metrics <global|providers|models|errors> [24h|7d|30d]",
    ],
  },
  {
    title: "快捷命令：",
    lines: [
      "/h → /help",
      "/work → /workspace",
      "/r → /resume",
    ],
  },
] as const;

export const conversationCommandHelpLines = conversationCommandHelpSections
  .flatMap((section) => [
    section.title,
    ...section.lines.map((line) => `- ${line}`),
    "",
  ]);

export { toStructuredMarkdownList } from "./markdown-list.js";

export function formatConversationSessions(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
): string {
  if (result.sessions.length === 0) {
    const scope = result.archived ? "已归档会话" : "可恢复会话";
    return result.page > result.pageCount
      ? `页码超出范围：第 ${result.page} 页，共 ${result.pageCount} 页。`
      : `当前 Workspace 没有匹配的${scope}。`;
  }
  const visibleSessions = result.sessions.slice(0, maximumSessionEntries);
  const hiddenCount = result.sessions.length - visibleSessions.length;
  const searchCommand = result.archived ? "archived" : "sessions";
  const backgroundThreadIds = new Set(result.backgroundThreadIds ?? []);
  return toStructuredMarkdownList([
    `${result.archived ? "已归档会话" : "历史会话"}（匹配 ${result.matchedSessionCount} · 第 ${result.page}/${result.pageCount} 页）${result.view.searchTerm ? ` · 搜索：${result.view.searchTerm}` : ""}：`,
    ...visibleSessions.map(
      (session, index) =>
        `${session.selector ?? index + 1}. ${formatSessionSection(session)}${formatSessionLabel(session.name ?? session.preview)}${session.model ? ` · 模型：${session.model}` : ""}${session.modelProvider ? ` · Provider：${session.modelProvider}` : ""} · ${session.id.slice(0, 12)} · ${session.status.type}${session.id === result.currentThreadId ? " ← 当前" : backgroundThreadIds.has(session.id) ? " · 后台运行" : ""}`,
    ),
    ...(hiddenCount > 0
      ? [
          "",
          `另有 ${hiddenCount} 条未显示，请使用 /${searchCommand} search <搜索词> 缩小范围。`,
        ]
      : []),
    ...(result.pageCount > 1
      ? [
          "",
          ...(result.page > 1
            ? [`上一页：${formatSessionListCommand(result, result.page - 1)}`]
            : []),
          ...(result.page < result.pageCount
            ? [`下一页：${formatSessionListCommand(result, result.page + 1)}`]
            : []),
        ]
      : []),
    "",
    result.archived
      ? "恢复归档：/unarchive <序号、名称或 Thread ID>"
      : "恢复：/resume <序号、名称或 Thread ID>",
  ].join("\n"));
}

export function formatConversationThreadQueue(
  result: Extract<ConversationCommandResult, { kind: "thread-queue" }>,
): string {
  if (result.result.totalItemCount === 0) {
    return toStructuredMarkdownList([
      "App Server Queue 为空",
      `第 ${result.result.page}/${result.result.pageCount} 页 · 共 ${result.result.totalItemCount} 条`,
      "新增：/queue add <文本>",
    ].join("\n"));
  }
  if (result.result.page > result.result.pageCount) {
    return toStructuredMarkdownList([
      `App Server Queue（共 ${result.result.totalItemCount} 条）`,
      `第 ${result.result.page} 页不存在，共 ${result.result.pageCount} 页`,
      "返回第一页：/queue list 1",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    `App Server Queue（第 ${result.result.page}/${result.result.pageCount} 页 · 共 ${result.result.totalItemCount} 条）：`,
    ...result.result.items.map((item, index) =>
      `${result.result.selectors[index] ?? "?"}. ${formatQueueItem(item)}`),
    "",
    "数字序号仅在最近五分钟的本会话列表快照内有效；也可使用完整 ID。",
  ].join("\n"));
}

export function formatConversationScheduledTasks(
  result: Extract<ConversationCommandResult, { kind: "scheduled-tasks" }>,
): string {
  const { tasks, selectors, page, pageCount, totalTaskCount } = result.result;
  if (tasks.length === 0) {
    return toStructuredMarkdownList([
      "Gateway 计划任务为空",
      `第 ${page}/${pageCount} 页 · 共 ${totalTaskCount} 项`,
      "新增：/schedule add interval <N>m|h <时区> <文本> · /schedule add once <YYYY-MM-DD> <HH:mm> <时区> <文本>",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    `Gateway 计划任务（第 ${page}/${pageCount} 页 · 共 ${totalTaskCount} 项）：`,
    ...tasks.map((task, index) => [
      `【${selectors[index] ?? "?"}】${task.name} · ${formatScheduledTaskStatusLabel(task.status)}`,
      `   ID：${task.taskId}`,
      `   计划：${formatSchedule(task.schedule, task.timezone)}`,
      `   下次运行：${formatScheduledAt(task.nextRunAt)}`,
      `   Workspace：${task.workspaceId} · 模型：${task.modelProvider}/${task.model ?? "默认"} · ${task.sandbox}`,
    ].join("\n")),
    "",
    "此处列出循环任务定义；每次执行结果与终态：/schedule runs <任务>",
    "数字序号只对最近五分钟的本会话列表有效。",
    ...(page > 1 ? [`上一页：/schedule list ${page - 1}`] : []),
    ...(page < pageCount ? [`下一页：/schedule list ${page + 1}`] : []),
  ].join("\n"));
}

export function formatConversationScheduledRuns(
  result: Extract<ConversationCommandResult, { kind: "scheduled-runs" }>,
): string {
  const { task, runs, page, pageCount, totalRunCount } = result.result;
  return toStructuredMarkdownList([
    "计划任务运行记录",
    `任务：${task.name} · ${task.taskId}`,
    `第 ${page}/${pageCount} 页 · 共 ${totalRunCount} 条`,
    "运行记录：",
    ...(runs.length === 0
      ? ["当前没有运行记录。"]
      : runs.map((run) => [
          `- 【${run.selector}】${run.runId} · ${scheduledRunStateLabel(run.state)}`,
          `  - 计划时间：${formatScheduledAt(run.scheduledFor)}`,
          ...(run.dispatchStartedAt === null
            ? []
            : [`  - 触发时间：${formatScheduledAt(run.dispatchStartedAt)}`]),
          ...(run.startedAt === null
            ? []
            : [`  - 开始时间：${formatScheduledAt(run.startedAt)}`]),
          ...(run.completedAt === null
            ? []
            : [`  - 完成时间：${formatScheduledAt(run.completedAt)}`]),
          ...(run.threadId ? [`  - Thread：${run.threadId}`] : []),
          ...(run.errorCategory ? [`  - 分类：${run.errorCategory}`] : []),
        ].join("\n"))),
    "",
    "可用操作：",
    "uncertain Run 可使用 /schedule retry <Run ID 或列表序号>",
    ...(page > 1 ? [`上一页：/schedule runs ${task.taskId} ${page - 1}`] : []),
    ...(page < pageCount ? [`下一页：/schedule runs ${task.taskId} ${page + 1}`] : []),
  ].join("\n"));
}

export function formatConversationScheduledConfirmation(
  result: Extract<ConversationCommandResult, { kind: "scheduled-confirmation" }>,
): string {
  const { preview } = result;
  return toStructuredMarkdownList([
    preview.action === "create"
      ? "计划任务创建预览（尚未保存）"
      : "计划任务删除预览（尚未删除）",
    `名称：${preview.task.name}`,
    ...(preview.action === "delete" ? [`任务：${preview.task.taskId}`] : []),
    `计划：${formatSchedule(preview.task.schedule, preview.task.timezone)}`,
    `Workspace：${preview.task.workspaceId}`,
    `模型：${preview.task.modelProvider}/${preview.task.model ?? "默认"}`,
    `思考等级：${preview.task.reasoningEffort ?? "默认"}`,
    `下次运行：${formatScheduledAt(preview.task.nextRunAt)}`,
    `Sandbox：${preview.task.sandbox}`,
    `权限 Profile：${preview.task.permissions ?? "未配置"}`,
    "网络：沿用 Workspace 当前权限；无人值守审批一律拒绝",
    "Approval Policy：never（无人值守请求将安全拒绝）",
    "该任务将在用户不在线时由 Gateway 无人值守执行。",
    `任务预览：${preview.task.promptPreview}`,
    `确认：/schedule confirm ${preview.token}`,
    "令牌五分钟内有效且只能使用一次。",
  ].join("\n"));
}

export function formatConversationThreadRevert(
  result: Extract<ConversationCommandResult, { kind: "thread-revert" }>,
): string {
  if (result.result.turns.length === 0) {
    return toStructuredMarkdownList([
      `分页历史 Turn（第 ${result.result.page} 页）`,
      result.result.page > 1
        ? `第 ${result.result.page} 页不存在，请返回 /revert list 1。`
        : "当前页面没有可回退的 Turn。",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    `分页历史 Turn（第 ${result.result.page} 页）：`,
    ...result.result.turns.map((turn, index) => {
      const selector = result.result.selectors[index] ?? turn.id;
      const preview = turn.textPreview ? ` · ${turn.textPreview}` : "";
      return `${selector}. ${turn.id} · ${formatThreadTurnStatus(turn.status)}${turn.inputType ? ` · ${turn.inputType}` : ""}${preview}`;
    }),
    "",
    "选择器只对最近五分钟的本会话列表页面有效；预览后必须确认。",
    ...(result.result.page > 1 ? [`上一页：/revert list ${result.result.page - 1}`] : []),
    ...(result.result.hasNextPage ? [`下一页：/revert list ${result.result.page + 1}`] : []),
  ].join("\n"));
}

export function formatConversationThreadRevertPreview(
  result: Extract<ConversationCommandResult, { kind: "thread-revert-preview" }>,
): string {
  const preview = result.preview;
  return toStructuredMarkdownList([
    "Revert 预览（尚未执行）",
    `边界 Turn：${preview.beforeTurnId}${preview.turn.textPreview ? ` · ${preview.turn.textPreview}` : ""}`,
    `将移除该 Turn 及其之后的历史，共 ${preview.affectedTurnCount} 条 Turn`,
    `活动 Turn：${preview.activeTurnId ? `会被中断（${preview.activeTurnId}）` : "无"}`,
    `当前 Queue：${preview.queueItemCount} 条（Revert 后按原顺序保留，不会自动启动）`,
    "不会恢复工作区文件、命令副作用或外部 API/MCP 副作用。",
    "确认完成前请勿从 TUI 或其他客户端向该 Thread 追加 Turn。",
    "确认：/revert confirm " + preview.token,
    "令牌五分钟内有效且只能使用一次。",
  ].join("\n"));
}

function formatThreadTurnStatus(
  status: Extract<ConversationCommandResult, { kind: "thread-revert" }>["result"]["turns"][number]["status"],
): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "interrupted":
      return "已中断";
    case "failed":
      return "失败";
    case "inProgress":
      return "进行中";
  }
}

export function formatConversationThreadSections(
  result: Extract<ConversationCommandResult, { kind: "thread-sections" }>,
): string {
  if (result.page > result.pageCount) {
    return toStructuredMarkdownList([
      `Thread 分区（全局 ${result.totalSectionCount}）：`,
      `第 ${result.page} 页不存在，共 ${result.pageCount} 页`,
      "返回第一页：/section list 1",
    ].join("\n"));
  }
  const entries = result.sections.map((section, index) => {
    const selector = result.selectors[index] ?? section.id;
    const builtIn = section.builtIn === "pinned" ? " · 内置固定区" : "";
    return `${selector}. ${section.name}${builtIn} · 当前 Workspace：活动 ${section.currentWorkspaceActiveCount} / 归档 ${section.currentWorkspaceArchivedCount} · ${section.id}`;
  });
  return toStructuredMarkdownList([
    `Thread 分区（全局 ${result.totalSectionCount} · 第 ${result.page}/${result.pageCount} 页）：`,
    ...(entries.length > 0 ? entries : ["当前没有可显示的分区。"]),
    ...(result.page > 1 ? ["", `上一页：/section list ${result.page - 1}`] : []),
    ...(result.page < result.pageCount ? ["", `下一页：/section list ${result.page + 1}`] : []),
    "",
    "分区由 Codex App Server 全局管理，不局限于当前 Workspace；序号仅用于当前列表。",
    "固定：/pin · 取消固定：/unpin",
    ...(result.canManageCustomSections
      ? [
          "移动到自定义分区：/section move <序号或 ID> [before <会话序号、名称或 Thread ID>]",
          "新建：/section create <名称> · 重命名：/section rename <分区序号或 ID> <新名称>",
          "移出自定义分区：/section remove · 删除：/section delete <分区序号或 ID>",
        ]
      : [
          "自定义分区：当前用户仅可查看和筛选；写操作需要配置 Thread 分区管理员。",
        ]),
  ].join("\n"));
}

export function formatConversationThreadSectionDeletePreview(
  result: Extract<ConversationCommandResult, { kind: "thread-section-delete-preview" }>,
): string {
  const { section } = result.preview;
  return toStructuredMarkdownList([
    "即将删除全局 Thread 分区",
    `名称：${section.name}`,
    `ID：${section.id}`,
    `当前 Workspace：活动 ${section.currentWorkspaceActiveCount} / 归档 ${section.currentWorkspaceArchivedCount}`,
    "删除只会解除 Thread 的分区归属，不会删除 Thread；其他 Workspace 中的归属也会受影响。",
    "",
    `确认：/section delete ${section.id} confirm`,
  ].join("\n"));
}

export function formatSessionListCommand(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
  page: number,
): string {
  const command = result.archived ? "archived" : "sessions";
  const parts = [`/${command}`, String(page)];
  if (result.view.filter !== "all") parts.push("filter", result.view.filter);
  if (result.view.provider) parts.push("provider", result.view.provider);
  if (result.view.sectionSelector) parts.push("section", result.view.sectionSelector);
  if (result.view.searchTerm) parts.push("search", result.view.searchTerm);
  return parts.join(" ");
}

function formatSessionSection(
  session: Extract<ConversationCommandResult, { kind: "sessions" }>["sessions"][number],
): string {
  if (session.isPinned) return "固定 · ";
  return session.section ? `分区：${session.section.name} · ` : "";
}

function formatSessionLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "未命名";
  }
  return normalized.length > maximumSessionLabelCharacters
    ? `${normalized.slice(0, maximumSessionLabelCharacters - 1)}…`
    : normalized;
}

export function formatConversationCommandOutcome(
  outcome: ConversationCommandOutcome,
): string {
  switch (outcome.type) {
    case "thread.resumed":
      return outcome.transferredFrom
        ? toStructuredMarkdownList([
            formatTakeoverSource(outcome.transferredFrom),
            `Thread：${outcome.threadId}`,
            formatConversationModel("会话模型", outcome.model),
            ...(outcome.queuePending
              ? ["Queue 中有待派发条目，已沿用该 Thread 自身设置，未应用当前会话的待生效偏好。"]
              : []),
          ].join("\n"))
        : toStructuredMarkdownList([
            "已恢复 Codex Thread",
            `Thread：${outcome.threadId}`,
            formatConversationModel("会话模型", outcome.model),
            ...(outcome.queuePending
              ? ["Queue 中有待派发条目，已沿用该 Thread 自身设置，未应用当前会话的待生效偏好。"]
              : []),
            ...(outcome.backgroundedThreadId
              ? [`原任务已转入后台：${outcome.backgroundedThreadId}`]
              : []),
          ].join("\n"));
    case "session.new":
      return outcome.backgroundedThreadId
        ? toStructuredMarkdownList([
            "新会话已准备，原任务继续在后台运行。",
            `后台 Thread：${outcome.backgroundedThreadId}`,
            "发送下一条普通消息时才会创建新的 Codex Thread。",
            formatNextMessageModel(outcome.nextModel),
          ].join("\n"))
        : toStructuredMarkdownList([
            "已退出当前会话。",
            "发送下一条普通消息时才会创建新的 Codex Thread。",
            formatNextMessageModel(outcome.nextModel),
          ].join("\n"));
    case "thread.archived":
      return toStructuredMarkdownList([
        "已归档 Codex Thread",
        `Thread：${outcome.threadId}`,
        "下一条普通消息将创建新会话。",
      ].join("\n"));
    case "thread.unarchived":
      return toStructuredMarkdownList([
        "已取消归档并切换会话",
        `Thread：${outcome.threadId}`,
      ].join("\n"));
    case "thread.pin-updated":
      return toStructuredMarkdownList([
        outcome.changed
          ? outcome.pinned
            ? "已固定当前会话。"
            : "已取消固定当前会话。"
          : outcome.pinned
            ? "当前会话已处于固定状态，无需重复操作。"
            : "当前会话未固定，无需取消。若 /resume 列表仍有会话显示“固定”，请先 /resume 该会话，再执行 /unpin。",
      ].join("\n"));
    case "thread-section.created":
      return toStructuredMarkdownList([
        "已创建全局 Thread 分区",
        `名称：${outcome.name}`,
        `ID：${outcome.sectionId}`,
      ].join("\n"));
    case "thread-section.renamed":
      return toStructuredMarkdownList([
        "已重命名全局 Thread 分区",
        `名称：${outcome.name}`,
        `ID：${outcome.sectionId}`,
      ].join("\n"));
    case "thread-section.moved":
      return toStructuredMarkdownList([
        outcome.pinned
          ? "已将当前会话移入内置固定区"
          : "已移动当前会话到 Thread 分区",
        `分区：${outcome.name}`,
        ...(outcome.ordered ? ["位置：已按 before 参数调整"] : []),
        outcome.pinned
          ? "当前会话现已固定；原自定义分区归属已解除。"
          : "自定义分区与固定状态互斥；移动后会取消固定。",
      ].join("\n"));
    case "thread-section.removed":
      return toStructuredMarkdownList([
        "已将当前会话移出 Thread 分区。",
      ].join("\n"));
    case "thread-section.deleted":
      return toStructuredMarkdownList([
        "已删除全局 Thread 分区",
        `名称：${outcome.name}`,
        `ID：${outcome.sectionId}`,
        "分区内 Thread 保留，只解除分区归属。",
      ].join("\n"));
    case "workspace.selected":
      return toStructuredMarkdownList([
        "已切换 Workspace",
        `Workspace：${outcome.workspace.name}`,
        `工作目录：${outcome.workspace.cwd}`,
        formatNextMessageModel(outcome.nextModel),
      ].join("\n"));
    case "workspace.permissions-updated":
      return toStructuredMarkdownList([
        "已更新工作区权限",
        `Workspace：${outcome.workspace.name}`,
        ...workspacePermissionLines(outcome.workspace),
        "",
        "权限已热加载；对新建或恢复的 Thread 生效，不改变已绑定 Thread。",
      ].join("\n"));
    case "turn.stop-requested":
      return outcome.stopped
        ? toStructuredMarkdownList(["已请求停止当前任务。"].join("\n"))
        : toStructuredMarkdownList(["当前没有运行中的任务。"].join("\n"));
    case "thread-queue.added":
      return toStructuredMarkdownList([
        "已写入 App Server Queue",
        formatQueueItem(outcome.item),
        "该条目由 App Server 持久保存；Gateway 重启不会清空。",
      ].join("\n"));
    case "thread-queue.updated":
      return toStructuredMarkdownList([
        "已更新 App Server Queue 条目",
        formatQueueItem(outcome.item),
      ].join("\n"));
    case "thread-queue.deleted":
      return toStructuredMarkdownList([
        outcome.deleted ? "已删除 App Server Queue 条目" : "Queue 条目已不存在",
      ].join("\n"));
    case "thread-queue.reordered":
      return toStructuredMarkdownList([
        "已重新排序 App Server Queue",
        `条目：${outcome.itemId}`,
        `位置：${outcome.position}/${outcome.totalItemCount}`,
      ].join("\n"));
    case "thread-queue.started":
      return toStructuredMarkdownList([
        "已启动 App Server Queue 条目",
        `Turn：${outcome.turnId}`,
      ].join("\n"));
    case "thread.reverted":
      return toStructuredMarkdownList([
        "已回退 Thread 历史",
        `Thread：${outcome.threadId}`,
        `边界 Turn：${outcome.beforeTurnId}`,
        "工作区文件和外部副作用不会随历史回退。",
      ].join("\n"));
    case "thread.renamed":
      return toStructuredMarkdownList([
        "会话已重命名",
        `名称：${outcome.name}`,
      ].join("\n"));
    case "thread.compaction-requested":
      return toStructuredMarkdownList([
        "已请求压缩当前 Codex Thread。进度将通过标准事件返回。",
      ].join("\n"));
    case "thread.forked":
      return toStructuredMarkdownList([
        "已分叉并切换到新会话",
        `Thread：${outcome.threadId}`,
      ].join("\n"));
    case "review.started":
      return toStructuredMarkdownList([
        "已启动 Codex Review",
        `Turn：${outcome.turnId}`,
      ].join("\n"));
    case "plan.started":
      return toStructuredMarkdownList([
        "已进入 Plan 模式并开始规划",
        `Turn：${outcome.turnId}`,
      ].join("\n"));
    case "skill.started":
      return outcome.steered
        ? toStructuredMarkdownList([
            "已把 Skill 追加到当前任务",
            `Skill：${outcome.skillName}`,
          ].join("\n"))
        : toStructuredMarkdownList([
            "已使用 Skill 开始任务",
            `Skill：${outcome.skillName}`,
            `Turn：${outcome.turnId}`,
          ].join("\n"));
    case "plugin.started":
      return outcome.steered
        ? toStructuredMarkdownList([
            "已把 Plugin 任务追加到当前任务",
            `Plugin：${outcome.pluginName}`,
          ].join("\n"))
        : toStructuredMarkdownList([
            "已使用 Plugin 开始任务",
            `Plugin：${outcome.pluginName}`,
            `Turn：${outcome.turnId}`,
          ].join("\n"));
    case "agents.started":
      return outcome.steered
        ? toStructuredMarkdownList([
            "已把子代理任务追加到当前任务",
            `角色：${outcome.roleName}`,
          ].join("\n"))
        : toStructuredMarkdownList([
            "已使用子代理开始任务",
            `角色：${outcome.roleName}`,
            `Turn：${outcome.turnId}`,
          ].join("\n"));
    case "goal.cleared":
      return toStructuredMarkdownList(["已清除当前 Thread Goal。"].join("\n"));
    case "goal.updated":
      return toStructuredMarkdownList([
        "Goal 已设置",
        `目标：${outcome.goal.objective}`,
      ].join("\n"));
    case "scheduled-task.created":
    case "scheduled-task.deleted":
    case "scheduled-task.renamed":
    case "scheduled-task.paused":
    case "scheduled-task.resumed":
      return toStructuredMarkdownList([
        scheduledTaskOutcomeTitle(outcome.type),
        `名称：${outcome.task.name}`,
        `任务：${outcome.task.taskId}`,
        `状态：${formatScheduledTaskStatusLabel(outcome.task.status)}`,
        `计划：${formatSchedule(outcome.task.schedule, outcome.task.timezone)}`,
        `下次运行：${formatScheduledAt(outcome.task.nextRunAt)}`,
        `模型：${outcome.task.modelProvider}/${outcome.task.model ?? "默认"}`,
        `思考等级：${outcome.task.reasoningEffort ?? "默认"}`,
      ].join("\n"));
    case "scheduled-task.run-requested":
    case "scheduled-task.retry-requested":
      return toStructuredMarkdownList([
        outcome.type === "scheduled-task.run-requested"
          ? "已请求立即运行计划任务"
          : "已解除 uncertain Run 并请求重试",
        `Run：${outcome.run.runId}`,
        `状态：${scheduledRunStateLabel(outcome.run.state)}`,
        `计划时间：${formatScheduledAt(outcome.run.scheduledFor)}`,
        ...(outcome.run.dispatchStartedAt === null
          ? []
          : [`触发时间：${formatScheduledAt(outcome.run.dispatchStartedAt)}`]),
        ...(outcome.run.startedAt === null
          ? []
          : [`开始时间：${formatScheduledAt(outcome.run.startedAt)}`]),
        ...(outcome.run.completedAt === null
          ? []
          : [`完成时间：${formatScheduledAt(outcome.run.completedAt)}`]),
        ...(outcome.run.threadId ? [`Thread：${outcome.run.threadId}`] : []),
      ].join("\n"));
  }
}

function scheduledTaskOutcomeTitle(type: Extract<ConversationCommandOutcome, {
  type:
    | "scheduled-task.created"
    | "scheduled-task.deleted"
    | "scheduled-task.renamed"
    | "scheduled-task.paused"
    | "scheduled-task.resumed";
}>["type"]): string {
  switch (type) {
    case "scheduled-task.created": return "已创建 Gateway 计划任务";
    case "scheduled-task.deleted": return "已删除 Gateway 计划任务";
    case "scheduled-task.renamed": return "已重命名 Gateway 计划任务";
    case "scheduled-task.paused": return "已暂停 Gateway 计划任务";
    case "scheduled-task.resumed": return "已恢复 Gateway 计划任务";
  }
}

export function formatScheduledTaskStatusLabel(
  status: "active" | "paused" | "blocked" | "finished" | "deleted",
): string {
  switch (status) {
    case "active": return "已启用";
    case "paused": return "已暂停";
    case "blocked": return "已阻止";
    case "finished": return "已完成";
    case "deleted": return "已删除";
  }
}

function scheduledRunStateLabel(state: Extract<ConversationCommandResult, {
  kind: "scheduled-runs";
}>["result"]["runs"][number]["state"]): string {
  switch (state) {
    case "dispatching": return "正在派发";
    case "running": return "运行中";
    case "completed": return "已完成";
    case "failed": return "失败";
    case "interrupted": return "已中断";
    case "uncertain": return "结果未知";
    case "missed": return "已错过";
    case "skipped_overlap": return "重叠跳过";
    case "skipped_capacity": return "容量跳过";
    case "blocked": return "已阻止";
  }
}

function formatSchedule(
  schedule: Extract<ConversationCommandResult, { kind: "scheduled-tasks" }>["result"]["tasks"][number]["schedule"],
  timezone: string,
): string {
  switch (schedule.type) {
    case "interval": return `每 ${formatIntervalMinutes(schedule.intervalMinutes)} · ${timezone}`;
    case "once": return "afterMinutes" in schedule
      ? `一次性 ${formatDelayMinutes(schedule.afterMinutes)}后 · ${timezone}`
      : `一次性 ${schedule.date} ${schedule.time} · ${timezone}`;
    case "monthly": return `每月 ${schedule.day} 号 ${schedule.time} · ${timezone}`;
    case "daily": return `每天 ${schedule.time} · ${timezone}`;
    case "weekdays": return `工作日 ${schedule.time} · ${timezone}`;
    case "weekly": return `每周 ${schedule.days.join(",")} ${schedule.time} · ${timezone}`;
  }
}

export function formatDelayMinutes(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatIntervalMinutes(minutes: number): string {
  return `每 ${formatDelayMinutes(minutes)}`;
}

function formatScheduledAt(value: number | null): string {
  return value === null ? "无" : new Date(value).toISOString();
}

export function formatConversationOccupancy(
  result: Extract<ConversationCommandResult, { kind: "occupancy" }>,
): string {
  const { result: release } = result;
  switch (release.status) {
    case "unbound":
      return toStructuredMarkdownList([
        "当前会话没有绑定 Codex Thread，无需释放占用。",
      ].join("\n"));
    case "free":
      return toStructuredMarkdownList([
        "当前会话的 Codex Thread 未被占用。",
        `Thread：${release.threadId}`,
      ].join("\n"));
    case "released":
      return toStructuredMarkdownList([
        "已释放 Codex Thread 占用，正在自动恢复订阅。",
        `Thread：${release.threadId}`,
        `占用进程：PID ${release.holder.pid}`,
        formatProcessCommand(release.holder.command),
      ].join("\n"));
    case "held":
      return toStructuredMarkdownList([
        `Codex Thread 被 PID ${release.holder.pid} 占用。`,
        `进程：${formatProcessCommand(release.holder.command)}`,
        release.releasable
          ? release.stuck
            ? "当前会话恢复失败，可确认释放：/release force（会向该进程发送结束信号；若是 App Server 子进程，服务会自动重启并重连所有会话）。"
            : "当前会话运行正常，通常无需释放；如确认需要，/release force 会结束该进程（App Server 子进程会重启并重连所有会话）。"
          : "该进程无法自动释放，请关闭占用 Thread 的 Codex 客户端，或重启 App Server 服务。",
        `Thread：${release.threadId}`,
      ].join("\n"));
    case "unidentifiable":
      return toStructuredMarkdownList([
        "无法识别占用 Codex Thread 的进程（当前平台不支持进程诊断）。",
        "请关闭占用该 Thread 的 Codex 客户端，或重启 App Server 服务后等待自动恢复。",
        `Thread：${release.threadId}`,
      ].join("\n"));
  }
}

function formatProcessCommand(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximumProcessCommandCharacters) {
    return normalized;
  }
  return `${normalized.slice(0, maximumProcessCommandCharacters - 1)}…`;
}

export function isTurnLifecycleAcknowledgedOutcome(
  outcome: Extract<ConversationCommandResult, { kind: "outcome" }>["outcome"],
): boolean {
  return (
    outcome.type === "skill.started"
    || outcome.type === "plugin.started"
    || outcome.type === "agents.started"
  ) && !outcome.steered;
}

function formatQueueItem(
  item: ThreadQueueItem,
): string {
  const preview = item.textPreview ? ` · ${item.textPreview}` : "";
  return `${item.id} · 类型：${formatThreadQueueInputTypeLabel(item.inputType)}${item.editable ? " · 可更新" : " · 只读摘要"}${preview}`;
}

export function formatThreadQueueInputTypeLabel(type: ThreadQueueInputType): string {
  switch (type) {
    case "text": return "纯文本";
    case "image": return "图片";
    case "audio": return "音频";
    case "skill": return "Skill";
    case "mention": return "Mention";
    default: return "复合输入";
  }
}

function formatTakeoverSource(surface: string): string {
  switch (surface) {
    case "telegram":
      return "已从 Telegram 接管 Codex Thread";
    case "feishu":
      return "已从飞书接管 Codex Thread";
    case "weixin":
      return "已从微信接管 Codex Thread";
    default:
      return "已从其他渠道接管 Codex Thread";
  }
}

export function formatConversationWorkspaces(
  result: Extract<ConversationCommandResult, { kind: "workspaces" }>,
): string {
  return toStructuredMarkdownList([
    `Workspace（${result.workspaces.length}）：`,
    ...result.workspaces.flatMap((workspace, index) => [
      `${index + 1}. ${workspace.name} · ${workspace.id}${workspace.id === result.currentWorkspaceId ? " ← 当前" : ""}`,
      workspace.cwd,
      ...workspacePermissionLines(workspace),
    ]),
    "",
    "切换：/workspace <序号、ID 或名称>",
  ].join("\n"));
}

export function formatConversationWorkspacePermissions(
  result: Extract<
    ConversationCommandResult,
    { kind: "workspace-permissions" }
  >,
): string {
  const permissionLines = workspacePermissionLines(result.workspace);
  return toStructuredMarkdownList([
    `工作区权限（${result.workspace.name} · ${result.workspace.id}）：`,
    ...(permissionLines.length > 0
      ? permissionLines
      : ["未配置（使用全局默认）"]),
    "",
    "修改：",
    "- /workspaceperm sandbox <read-only|workspace-write|danger-full-access|clear>",
    "- /workspaceperm approval <untrusted|on-request|never|clear>",
    "- /workspaceperm profile <Profile ID|clear>",
    "权限热加载后对新建或恢复的 Thread 生效，不改变已绑定 Thread。",
  ].join("\n"));
}

function workspacePermissionLines(
  workspace: Extract<ConversationCommandResult, { kind: "workspaces" }>["workspaces"][number],
): string[] {
  const lines: string[] = [];
  if (workspace.sandbox !== undefined) {
    lines.push(`  - 沙箱：${workspaceSandboxLabel(workspace.sandbox)}`);
  }
  if (workspace.approvalPolicy !== undefined) {
    lines.push(`  - 审批：${workspaceApprovalPolicyLabel(workspace.approvalPolicy)}`);
  }
  if (workspace.permissions !== undefined) {
    lines.push(`  - 权限 Profile：${workspace.permissions}`);
  }
  return lines;
}

function workspaceSandboxLabel(
  sandbox: "read-only" | "workspace-write" | "danger-full-access",
): string {
  return ({
    "read-only": "只读",
    "workspace-write": "工作区写",
    "danger-full-access": "完全访问",
  } as const)[sandbox];
}

function workspaceApprovalPolicyLabel(
  policy: "untrusted" | "on-request" | "never",
): string {
  return ({
    untrusted: "不信任",
    "on-request": "按需审批",
    never: "免审批",
  } as const)[policy];
}

export function formatConversationSkills(
  result: Extract<ConversationCommandResult, { kind: "skills" }>,
): string {
  return result.entries.length === 0
    ? "当前没有已启用的 Skills。"
    : toStructuredMarkdownList([
        `已安装 Skills（${result.entries.length}）：`,
        ...result.entries.map(
          (skill, index) => `${index + 1}. ${skill.name}：${skill.description}`,
        ),
        "",
        "使用：/skill <名称或序号> <任务>",
      ].join("\n"));
}

export function formatConversationAgents(
  result: Extract<ConversationCommandResult, { kind: "agents" }>,
): string {
  return result.roles.length === 0
    ? "当前没有可用的子代理角色。"
    : toStructuredMarkdownList([
        `子代理角色（${result.roles.length}）：`,
        ...result.roles.map(
          (role, index) =>
            `${index + 1}. ${role.name}${role.description ? `：${role.description}` : ""}`,
        ),
        "",
        "使用：/agents <角色名称或序号> <任务>",
      ].join("\n"));
}

export function formatConversationMcp(
  result: Extract<ConversationCommandResult, { kind: "mcp" }>,
): string {
  if (result.servers.length === 0) {
    return toStructuredMarkdownList("MCP Servers（0）：");
  }
  return toStructuredMarkdownList([
    `MCP Servers（${result.servers.length}）：`,
    ...result.servers.map(
      (server, index) =>
        `${index + 1}. ${server.name} · auth=${server.authStatus} · tools=${server.toolCount}`,
    ),
    "",
    "详情：/mcp <名称或序号>",
  ].join("\n"));
}

export function formatConversationMcpHealth(
  result: Extract<ConversationCommandResult, { kind: "mcp-health" }>,
): string {
  const report = result.report;
  const visibleActions = report.actions.slice(0, maximumMcpHealthFindings);
  const visibleNotices = report.notices.slice(
    0,
    maximumMcpHealthFindings - visibleActions.length,
  );
  const omittedFindings = report.actions.length
    + report.notices.length
    - visibleActions.length
    - visibleNotices.length;
  return toStructuredMarkdownList([
    "MCP 健康检查",
    report.serverCount === 0
      ? "状态：未配置 MCP Server"
      : report.actions.length > 0
      ? `状态：发现 ${report.actions.length} 项需要处理`
      : "状态：未发现需要处理的问题",
    `Server：${report.serverCount} 个 · 工具：${report.toolCount} 个 · 资源：${report.resourceCount} 个 · 资源模板：${report.resourceTemplateCount} 个`,
    ...(visibleActions.length > 0
      ? [
          "需要处理：",
          ...visibleActions.flatMap((action) => [
            `- ${action.server}：尚未登录`,
            `  - 处理：/mcp login ${action.selector}`,
          ]),
        ]
      : []),
    ...(visibleNotices.length > 0 || omittedFindings > 0
      ? [
          "提示：",
          ...visibleNotices.map((notice) => notice.type === "authUnknown"
            ? `- ${notice.server}：认证状态未知，可检查配置或尝试 /mcp login ${notice.selector}`
            : `- ${notice.server}：未公开工具、资源或资源模板`),
          ...(omittedFindings > 0
            ? [`- 其余 ${omittedFindings} 项已省略；使用 /mcp 查看完整 Server 列表`]
            : []),
        ]
      : []),
  ].join("\n"));
}

export function formatConversationMcpReload(
  result: Extract<ConversationCommandResult, { kind: "mcp-reload" }>,
): string {
  void result;
  return toStructuredMarkdownList([
    "MCP 配置重新加载",
    "状态：已请求",
    "生效：已加载 Thread 会在下一次活动 Turn 时刷新",
    "提示：无需重启 Codex App Server",
  ].join("\n"));
}

export function formatConversationMcpDetail(
  result: Extract<ConversationCommandResult, { kind: "mcp-detail" }>,
): string {
  const server = result.server;
  const selector = result.selector;
  const detailSections = result.view
    ? formatSelectedMcpDetailSection(server, result.view, selector)
    : [
        ...formatMcpDetailEntries("工具", server.tools, (tool) =>
          formatMcpToolLine(tool)
        ),
        mcpToolAccessNotice,
        ...formatMcpDetailEntries("资源", server.resources, (resource) =>
          `- ${resource.title ?? resource.name} · ${resource.uri}${resource.mimeType ? ` · ${formatMcpDescription(resource.mimeType)}` : ""}`
        ),
        ...formatMcpDetailEntries("资源模板", server.resourceTemplates, (template) =>
          `- ${template.title ?? template.name} · ${template.uriTemplate}`
        ),
      ];
  return toStructuredMarkdownList([
    `MCP Server：${server.serverTitle ?? server.name}`,
    `名称：${server.name}`,
    ...(server.pluginId ? [`来源 Plugin：${server.pluginId}`] : []),
    `版本：${server.serverVersion ?? "未提供"}`,
    `认证：${server.authStatus}`,
    ...(server.serverDescription
      ? [`说明：${formatMcpDescription(server.serverDescription)}`]
      : []),
    ...detailSections,
    "",
    ...(supportsMcpOAuthLogin(server.authStatus)
      ? [`OAuth：/mcp login ${selector}`]
      : []),
    `浏览工具：/mcp ${selector} tools`,
    `浏览资源：/mcp ${selector} resources`,
    `浏览资源模板：/mcp ${selector} templates`,
    `读取资源：/mcp resource ${selector} <URI>`,
  ].join("\n"));
}

function formatSelectedMcpDetailSection(
  server: Extract<ConversationCommandResult, { kind: "mcp-detail" }>["server"],
  view: NonNullable<Extract<ConversationCommandResult, { kind: "mcp-detail" }>["view"]>,
  selector: string,
): string[] {
  if (view.section === "tools") {
    return [
      ...formatMcpDetailPage(
        "工具",
        server.tools,
        view,
        selector,
        (tool) => [tool.name, tool.title, tool.description],
        formatMcpToolLine,
      ),
      mcpToolAccessNotice,
    ];
  }
  if (view.section === "resources") {
    return formatMcpDetailPage(
      "资源",
      server.resources,
      view,
      selector,
      (resource) => [
        resource.name,
        resource.title,
        resource.description,
        resource.uri,
        resource.mimeType,
      ],
      (resource) =>
        `- ${resource.title ?? resource.name} · ${resource.uri}${resource.mimeType ? ` · ${formatMcpDescription(resource.mimeType)}` : ""}`,
    );
  }
  return formatMcpDetailPage(
    "资源模板",
    server.resourceTemplates,
    view,
    selector,
    (template) => [
      template.name,
      template.title,
      template.description,
      template.uriTemplate,
      template.mimeType,
    ],
    (template) => `- ${template.title ?? template.name} · ${template.uriTemplate}`,
  );
}

function formatMcpToolLine(
  tool: Extract<ConversationCommandResult, { kind: "mcp-detail" }>["server"]["tools"][number],
): string {
  const access = ({
    readOnly: "上游标记只读",
    writeCapable: "可能写入",
    unknown: "读写属性未知",
  } as const)[tool.access];
  return `- ${tool.title ?? tool.name} · ${tool.name} · ${access}${tool.description ? ` · ${formatMcpDescription(tool.description)}` : ""}`;
}

function formatMcpDetailPage<T>(
  label: string,
  entries: readonly T[],
  view: NonNullable<Extract<ConversationCommandResult, { kind: "mcp-detail" }>["view"]>,
  selector: string,
  searchableValues: (entry: T) => ReadonlyArray<string | null>,
  format: (entry: T) => string,
): string[] {
  const normalizedSearch = view.searchTerm?.toLowerCase() ?? null;
  const matches = normalizedSearch
    ? entries.filter((entry) =>
        searchableValues(entry).some((value) =>
          value?.toLowerCase().includes(normalizedSearch)
        )
      )
    : [...entries];
  const pageCount = Math.max(1, Math.ceil(matches.length / maximumMcpDetailEntries));
  const commandSuffix = view.searchTerm ? ` search ${view.searchTerm}` : "";
  if (view.page > pageCount) {
    return [
      `${label}（${view.searchTerm ? `匹配 ${matches.length} · ` : ""}共 ${pageCount} 页）：`,
      `- 第 ${view.page} 页不存在，共 ${pageCount} 页`,
      `返回第一页：/mcp ${selector} ${view.section} 1${commandSuffix}`,
    ];
  }
  const pageStart = (view.page - 1) * maximumMcpDetailEntries;
  const pageEntries = matches.slice(pageStart, pageStart + maximumMcpDetailEntries);
  const visible: string[] = [];
  let sectionCharacters = 0;
  for (const entry of pageEntries) {
    const line = format(entry);
    if (sectionCharacters + line.length > maximumMcpDetailSectionCharacters) break;
    visible.push(line);
    sectionCharacters += line.length;
  }
  return [
    `${label}（${view.searchTerm ? `匹配 ${matches.length} · ` : ""}第 ${view.page}/${pageCount} 页）：`,
    ...(visible.length > 0 ? visible : ["- 当前页没有匹配项"]),
    ...(pageEntries.length > visible.length
      ? [`- 当前页其余 ${pageEntries.length - visible.length} 项因展示上限省略`]
      : []),
    ...(view.page > 1
      ? [`上一页：/mcp ${selector} ${view.section} ${view.page - 1}${commandSuffix}`]
      : []),
    ...(view.page < pageCount
      ? [`下一页：/mcp ${selector} ${view.section} ${view.page + 1}${commandSuffix}`]
      : []),
  ];
}

function formatMcpDetailEntries<T>(
  label: string,
  entries: readonly T[],
  format: (entry: T) => string,
): string[] {
  const visible: string[] = [];
  let sectionCharacters = 0;
  for (const entry of entries.slice(0, maximumMcpDetailEntries)) {
    const line = format(entry);
    if (sectionCharacters + line.length > maximumMcpDetailSectionCharacters) break;
    visible.push(line);
    sectionCharacters += line.length;
  }
  return [
    `${label}（${entries.length}）：`,
    ...visible,
    ...(entries.length > visible.length
      ? [`- 其余 ${entries.length - visible.length} 项已省略`]
      : []),
  ];
}

function formatMcpDescription(value: string): string {
  const characters = [...value];
  return characters.length <= maximumMcpDescriptionCharacters
    ? value
    : `${characters.slice(0, maximumMcpDescriptionCharacters - 1).join("")}…`;
}

export function formatConversationMcpLogin(
  result: Extract<ConversationCommandResult, { kind: "mcp-login" }>,
): string {
  if (result.login.type === "bearerToken") {
    return toStructuredMarkdownList([
      "MCP 认证",
      `Server：${result.login.server}`,
      "状态：已使用 Bearer Token 认证，无需 OAuth 登录",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    "MCP OAuth 登录已启动",
    `Server：${result.login.server}`,
    `请在浏览器完成授权：${result.login.authorizationUrl}`,
    "授权完成后再次发送 /mcp 查看登录状态。",
  ].join("\n"));
}

export function formatConversationMcpResource(
  result: Extract<ConversationCommandResult, { kind: "mcp-resource" }>,
): string {
  const resource = result.resource;
  const heading = [
    "MCP Resource（外部不可信内容）",
    `Server：${resource.server}`,
    `请求 URI：${resource.requestedUri}`,
  ];
  const blocks: string[] = [];
  let visibleContentCount = 0;
  for (const content of resource.contents) {
    const block = formatMcpResourceContent(content, visibleContentCount);
    const nextVisibleCount = visibleContentCount + 1;
    const omittedContentCount = resource.omittedContentCount
      + resource.contents.length
      - nextVisibleCount;
    const candidate = toStructuredMarkdownList([
      ...heading,
      ...blocks,
      ...block,
      ...(omittedContentCount > 0
        ? [`其余 ${omittedContentCount} 个内容已省略。`]
        : []),
    ].join("\n"));
    if (candidate.length > maximumMcpOutputCharacters) break;
    blocks.push(...block);
    visibleContentCount = nextVisibleCount;
  }
  const omittedContentCount = resource.omittedContentCount
    + resource.contents.length
    - visibleContentCount;
  return toStructuredMarkdownList([
    ...heading,
    ...blocks,
    ...(omittedContentCount > 0
      ? [`其余 ${omittedContentCount} 个内容已省略。`]
      : []),
  ].join("\n"));
}

function formatMcpResourceContent(
  content: McpResourceContent,
  index: number,
): string[] {
  if (content.kind === "blob") {
    return [
      `内容 ${index + 1}：${content.uri}`,
      `二进制内容未在渠道中展开 · MIME=${formatMcpDescription(content.mimeType ?? "未知")} · Base64 字符=${content.encodedCharacters}`,
    ];
  }
  return [
    `内容 ${index + 1}：${content.uri}${content.mimeType ? ` · ${formatMcpDescription(content.mimeType)}` : ""}`,
    "```text",
    escapeCodeFence(content.text),
    "```",
    ...(content.truncated ? ["文本展示达到整次读取 8000 字符上限，当前内容已截断。"] : []),
  ];
}

function escapeCodeFence(value: string): string {
  return value.replace(/```/gu, "``\u200b`");
}

export function formatConversationPlugins(
  result: Extract<ConversationCommandResult, { kind: "plugins" }>,
): string {
  const {
    plugins,
    selectors,
    loadErrorCount,
    totalPluginCount,
    matchedPluginCount,
    page,
    pageCount,
    searchTerm,
  } = result;
  const loadErrorNotice = loadErrorCount > 0
    ? [`注意：${loadErrorCount} 个 Plugin Marketplace 加载失败，列表可能不完整。`, ""]
    : [];
  if (totalPluginCount === 0 && loadErrorCount === 0) {
    return "当前没有已安装的 Plugin。";
  }
  const commandSuffix = searchTerm ? ` search ${searchTerm}` : "";
  const hasReservedPluginName = plugins.some((plugin) =>
    plugin.name === "health" || plugin.name === "list"
  );
  const callableCommands = plugins.flatMap((plugin, index) => {
    const selector = selectors[index];
    return plugin.enabled && plugin.available && selector
      ? [`${plugin.displayName}：/plugin ${selector} <任务>`]
      : [];
  });
  if (page > pageCount) {
    return toStructuredMarkdownList([
      `已安装 Plugin（开发中${searchTerm ? `，匹配 ${matchedPluginCount}` : ""}）：`,
      ...loadErrorNotice,
      `第 ${page} 页不存在，共 ${pageCount} 页`,
      `返回第一页：/plugin list 1${commandSuffix}`,
    ].join("\n"));
  }
  if (plugins.length === 0 && searchTerm) {
    return toStructuredMarkdownList([
      "已安装 Plugin（开发中，匹配 0 · 第 1/1 页）：",
      ...loadErrorNotice,
      `没有匹配“${searchTerm}”的 Plugin。`,
      "重新搜索：/plugin list search <关键词>",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    `已安装 Plugin（开发中，${searchTerm ? `匹配 ${matchedPluginCount}` : `共 ${totalPluginCount}`} · 第 ${page}/${pageCount} 页）：`,
    ...loadErrorNotice,
    ...plugins.map((plugin, index) => {
      const status = !plugin.available
        ? "不可用"
        : plugin.enabled
          ? "已启用"
          : "未启用";
      return `${selectors[index]}. ${plugin.displayName} · ${plugin.id} · ${status}${plugin.description ? ` · ${plugin.description}` : ""}`;
    }),
    "",
    ...(page > 1 ? [`上一页：/plugin list ${page - 1}${commandSuffix}`] : []),
    ...(page < pageCount ? [`下一页：/plugin list ${page + 1}${commandSuffix}`] : []),
    ...(callableCommands.length > 0
      ? ["当前页快捷调用：", ...callableCommands]
      : []),
    "健康检查：/plugin health",
    "搜索：/plugin list search <关键词>",
    ...(hasReservedPluginName
      ? ["提示：名称为 health 或 list 时，查看详情请使用完整 ID 或序号。"]
      : []),
    "详情：/plugin <名称、完整 ID 或序号>",
    "调用：/plugin <名称、完整 ID 或序号> <任务>",
  ].join("\n"));
}

export function formatConversationPluginHealth(
  result: Extract<ConversationCommandResult, { kind: "plugin-health" }>,
): string {
  const { report } = result;
  const visibleIssues = report.issues.slice(0, 8);
  const lines = [
    "Plugin 健康（开发中）",
    `已安装：${report.installedCount}`,
    `已启用：${report.enabledCount}`,
    `可调用：${report.callableCount}`,
    ...(report.marketplaceLoadErrorCount > 0
      ? [`提示：${report.marketplaceLoadErrorCount} 个 Marketplace 加载失败，结果可能不完整。`]
      : []),
    ...(visibleIssues.length > 0 ? ["", "需要处理："] : []),
    ...visibleIssues.map((issue) =>
      `${issue.plugin} · ${pluginHealthIssueLabel(issue.type, issue.reason)} · 详情：/plugin ${issue.selector}`
    ),
    ...(report.issues.length > visibleIssues.length
      ? [`其余 ${report.issues.length - visibleIssues.length} 项已省略，请使用 /plugin 分页查看。`]
      : []),
    ...(report.issues.length === 0 && report.marketplaceLoadErrorCount === 0
      ? ["", "没有需要处理的问题。"]
      : []),
  ];
  return toStructuredMarkdownList(lines.join("\n"));
}

function pluginHealthIssueLabel(
  type: Extract<ConversationCommandResult, { kind: "plugin-health" }>["report"]["issues"][number]["type"],
  reason: Extract<ConversationCommandResult, { kind: "plugin-health" }>["report"]["issues"][number]["reason"],
): string {
  if (type === "notEnabled") return "未启用";
  return reason ? pluginDisabledReasonLabel(reason) : "上游标记不可用";
}

export function formatConversationPluginDetail(
  result: Extract<ConversationCommandResult, { kind: "plugin-detail" }>,
): string {
  const plugin = result.plugin;
  return toStructuredMarkdownList([
    `Plugin：${plugin.displayName}`,
    `ID：${plugin.id}`,
    `Marketplace：${plugin.marketplaceName}`,
    `状态：${pluginStatusLabel(plugin)}`,
    ...(plugin.developerName ? [`开发者：${plugin.developerName}`] : []),
    ...(plugin.category ? [`分类：${plugin.category}`] : []),
    `来源：${pluginSourceLabel(plugin.source)}`,
    `远端版本：${plugin.version ?? "未提供"}`,
    `本地版本：${plugin.localVersion ?? "未提供"}`,
    `安装时间：${formatPluginInstalledAt(plugin.installedAt)}`,
    `认证时机：${pluginAuthPolicyLabel(plugin.authPolicy)}`,
    ...(plugin.capabilities.length > 0
      ? [`能力：${formatPluginValues(plugin.capabilities)}`]
      : []),
    ...(plugin.disabledReason
      ? [`不可用原因：${pluginDisabledReasonLabel(plugin.disabledReason)}`]
      : []),
    ...(plugin.eligiblePlanTypes.length > 0
      ? [`适用套餐（上游标识）：${formatPluginValues(plugin.eligiblePlanTypes)}`]
      : []),
    ...(plugin.description ? [`说明：${plugin.description}`] : []),
    "",
    plugin.enabled && plugin.available
      ? `调用：/plugin ${plugin.id} <任务>`
      : "当前 Plugin 不可调用。",
    "提示：Plugin API 仍处于开发中。",
  ].join("\n"));
}

function pluginStatusLabel(
  plugin: Extract<ConversationCommandResult, { kind: "plugin-detail" }>["plugin"],
): string {
  if (!plugin.available) return "不可用";
  return plugin.enabled ? "已启用" : "未启用";
}

function pluginSourceLabel(
  source: Extract<ConversationCommandResult, { kind: "plugin-detail" }>["plugin"]["source"],
): string {
  return ({
    local: "本地",
    git: "Git",
    npm: "npm",
    remote: "远端",
  } as const)[source];
}

function formatPluginInstalledAt(value: number | null): string {
  if (value === null) return "未提供";
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime())
    ? "未提供"
    : date.toISOString().replace(".000Z", "Z");
}

function pluginDisabledReasonLabel(
  reason: NonNullable<
    Extract<ConversationCommandResult, { kind: "plugin-detail" }>["plugin"]["disabledReason"]
  >,
): string {
  return ({
    disabled_by_admin: "被管理员禁用",
    plan_not_eligible: "当前套餐不可用",
    required_app_unavailable: "所需 App 不可用",
    unknown: "上游未提供明确原因",
  } as const)[reason];
}

function pluginAuthPolicyLabel(
  policy: Extract<ConversationCommandResult, { kind: "plugin-detail" }>["plugin"]["authPolicy"],
): string {
  return policy === "onInstall" ? "安装时" : "使用时";
}

function formatPluginValues(values: readonly string[]): string {
  const visible = values.slice(0, 8);
  const omittedCount = values.length - visible.length;
  return `${visible.join("、")}${omittedCount > 0 ? `（另有 ${omittedCount} 项）` : ""}`;
}

export function formatConversationPermissions(
  result: Extract<ConversationCommandResult, { kind: "permissions" }>,
): string {
  return toStructuredMarkdownList([
    "权限查询说明",
    "- 本次为只读查询，不会修改当前 Workspace 权限；需要调整请使用 /workspaceperm。",
    ...(result.workspace
      ? [
          `当前 Workspace：${result.workspace.name}（${result.workspace.id}）`,
          `- 沙箱：${result.workspace.sandbox ?? "跟随 Gateway 默认"}`,
          `- 审批：${result.workspace.approvalPolicy ?? "跟随默认"}`,
          `- Profile：${result.workspace.permissions ?? "未配置"}`,
        ]
      : [
          "当前 Workspace 权限：未能从当前会话读取；Gateway 默认模式为配置中的 read-only 或 workspace-write。",
        ]),
    "- 沙盒网络：跟随 Codex 用户默认设置（当前 Workspace 无独立覆盖）。",
    "可选择的 Permission Profiles（可选择不代表当前正在使用）：",
    ...result.profiles.map(
      (profile) =>
        `- ${profile.id} · ${profile.allowed ? "可选择" : "不可选择（受策略禁止）"}${profile.description ? ` · ${profile.description}` : ""}`,
    ),
  ].join("\n"));
}

export function formatConversationProjectRules(
  result: Extract<ConversationCommandResult, { kind: "project-rules" }>,
): string {
  return toStructuredMarkdownList([
    result.action === "initialized"
      ? "项目规则已生成并检查通过"
      : "项目规则检查通过",
    `Workspace：${result.projectRoot}`,
    `规则文件：${result.rulesPath}`,
    ...(result.action === "initialized"
      ? ["重启 Codex/App Server 后生效；Gateway 无需重启。"]
      : []),
  ].join("\n"));
}

export function formatConversationArtifacts(
  result: Extract<ConversationCommandResult, { kind: "artifacts" }>,
): string {
  return result.artifacts?.diff?.trim()
    ? [
        `Turn Diff · ${result.artifacts.turnId}`,
        "",
        result.artifacts.diff,
      ].join("\n")
    : "当前 Thread 暂无 Turn Diff。";
}

export function formatConversationCollaborationMode(
  result: Extract<ConversationCommandResult, { kind: "collaboration-mode" }>,
): string {
  const label = result.state.mode === "plan" ? "Plan" : "Default";
  return toStructuredMarkdownList([
    `协作模式：${label}${result.state.pending ? "（下一次 Turn 生效）" : ""}`,
    "",
    result.state.mode === "plan"
      ? "下一条普通消息将按 Plan 模式处理；再次发送 /plan 可切回 Default。"
      : "下一条普通消息将按 Default 模式处理；发送 /plan 可切换到 Plan。",
    "也可发送 /plan <规划需求>，直接进入 Plan 并开始规划。",
  ].join("\n"));
}

export function formatConversationGoal(
  result: Extract<ConversationCommandResult, { kind: "goal" }>,
): string {
  return result.goal
    ? toStructuredMarkdownList([
        `当前 Goal：${result.goal.objective}`,
        `状态：${formatGoalStatus(result.goal.status)}`,
        `Tokens：${formatGoalTokens(result.goal)}`,
      ].join("\n"))
    : "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。";
}

export function formatConversationModels(
  result: Extract<ConversationCommandResult, { kind: "models" }>,
): string {
  const { state } = result;
  const current = state.models.find((model) =>
    model.model === state.model
    && (model.provider ?? "openai") === (state.modelProvider ?? "openai"));
  const fast = isFastServiceTier(state.serviceTier, current) ? "开启" : "关闭";
  const providerSwitchNotice = state.providerPending
    ? ["提供商切换将在下一条消息中创建新 Thread；当前 Thread 会保留，可通过 /resume 恢复。", ""]
    : [];
  if (result.view === "fast") {
    return toStructuredMarkdownList([
      formatModelStateLine(state),
      `Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`,
      `模型支持：${current && fastServiceTierId(current) ? "支持 Fast" : "不支持 Fast"}`,
      "",
      "切换：/fast [on|off|status]",
    ].join("\n"));
  }
  if (result.view === "effort") {
    return toStructuredMarkdownList([
      formatModelStateLine(state),
      `当前思考等级：${state.effort ?? current?.defaultReasoningEffort ?? "模型默认"}${state.effortPending ? "（下一次 Turn 生效）" : ""}`,
      ...(current && fastServiceTierId(current)
        ? [`Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`]
        : []),
      "",
      ...providerSwitchNotice,
      ...(result.nextSelection === "effort"
        ? ["模型已选择，请继续选择思考等级。", ""]
        : []),
      "可用思考等级：",
      ...(current?.supportedReasoningEfforts ?? []).map(
        (option, index) =>
          `${index + 1}. ${option.effort}${option.effort === state.effort ? " ← 当前" : ""} · ${option.description}`,
      ),
      "",
      "切换：/effort <序号或档位>",
    ].join("\n"));
  }
  return toStructuredMarkdownList([
    formatModelStateLine(state),
    `思考等级：${state.effort ?? "模型默认"}`,
    ...(current && fastServiceTierId(current)
      ? [`Fast 模式：${fast}${state.serviceTierPending ? "（下一次 Turn 生效）" : ""}`]
      : []),
    "",
    ...providerSwitchNotice,
    `模型列表（${state.models.length}）：`,
    ...state.models.map(
      (model, index) =>
        `${index + 1}. ${model.displayName} · ${model.model}${model.available === false ? ` · 暂不可用${model.unavailableReason ? `（${model.unavailableReason}）` : ""}` : ""}${fastServiceTierId(model) ? " · 支持 Fast" : ""}${model.model === state.model && (model.provider ?? "openai") === (state.modelProvider ?? "openai") ? " ← 当前" : ""}`,
    ),
    "",
    "切换：/model <序号、模型 ID 或名称>",
  ].join("\n"));
}

function formatNextMessageModel(value: { model: string; modelProvider?: string }): string {
  return formatConversationModel("下一条消息模型", value);
}

function formatConversationModel(
  label: string,
  value: { model: string; modelProvider?: string },
): string {
  return `${label}：${value.model}${value.modelProvider ? ` · Provider：${value.modelProvider}` : ""}`;
}

function formatModelStateLine(
  state: Extract<ConversationCommandResult, { kind: "models" }>["state"],
): string {
  return state.modelPending
    ? formatNextMessageModel(state)
    : `当前模型：${state.model}`;
}

export function formatConversationUsage(
  result: Extract<ConversationCommandResult, { kind: "usage" }>,
): string {
  if (result.result.kind === "unsupported") {
    return `${formatCodexProviderLabel(result.result.provider)} 仅提供模型请求，不提供账户余额/额度查询。请求次数、Token 与费用可通过 /metrics 查看。`;
  }
  if (result.result.kind === "balance") {
    return toStructuredMarkdownList([
      `${formatCodexProviderLabel(result.result.provider)} 账户余额：`,
      `API 可用：${result.result.available ? "是" : "否"}`,
      ...(result.result.balances.length === 0
        ? ["暂无余额信息"]
        : result.result.balances.flatMap((balance) => [
            "",
            `${balance.currency}：`,
            `总余额：${balance.totalBalance}`,
            `赠金余额：${balance.grantedBalance}`,
            `充值余额：${balance.toppedUpBalance}`,
        ])),
    ].join("\n"));
  }
  if (result.result.kind === "quota-windows") {
    const modelUsage = result.result.modelUsage ?? [];
    const firstEstimate = modelUsage[0];
    const windowRange = firstEstimate?.windowStartAtMs === null
      || firstEstimate?.windowStartAtMs === undefined
      || firstEstimate?.windowEndAtMs === null
      || firstEstimate?.windowEndAtMs === undefined
      ? ""
      : `（月度窗口 ${formatResetTime(Math.floor(firstEstimate.windowStartAtMs / 1_000))} – ${formatResetTime(Math.floor(firstEstimate.windowEndAtMs / 1_000))}）`;
    return toStructuredMarkdownList([
      `${formatCodexProviderLabel(result.result.provider)} 账户用量：`,
      `API 可用：${result.result.available ? "是" : "否"}`,
      ...(result.result.windows.length === 0
        ? ["暂无用量数据"]
        : result.result.windows.map((window) => {
            const reset = window.resetsAt === null
              ? "未知"
              : formatResetTime(window.resetsAt);
            const localTokens = window.localTokens === undefined
              || window.localTokens === null
              ? ""
              : ` · 本地 Token 约 ${formatTokenCount(window.localTokens)}`;
            const totalUsd = window.totalUsd === undefined || window.totalUsd === null
              ? ""
              : ` · 总额 $${window.totalUsd.toFixed(2)}`;
            return `- ${window.label}：已用 ${formatPercent(window.usedPercent)}${totalUsd}${localTokens} · 重置 ${reset}`;
          })),
      ...(modelUsage.length === 0
        ? []
        : [
            "",
            `模型本地用量${windowRange}（按当前价格基线按请求时间重算，非官方账单）：`,
            ...modelUsage.map((estimate) => {
              const used = estimate.usedUsdNanos === null
                ? "未知"
                : formatUsdAmount(estimate.usedUsdNanos);
              const included = formatUsdAmount(
                Math.round(estimate.includedUsageUsd * 1_000_000_000),
              );
              const percent = estimate.usedPercent === null
                ? "未知"
                : formatPercent(estimate.usedPercent);
              const remaining = estimate.remainingUsdNanos === null
                ? "未知"
                : formatUsdAmount(estimate.remainingUsdNanos);
              const bucket = estimate.bucket === undefined
                ? ""
                : `（${formatModelUsageBucket(estimate.bucket)}）`;
              return `- ${estimate.model}${bucket}：已用 ${used} / 包含 ${included}（${percent}）· 剩余 ${remaining}`;
            }),
          ]),
    ].join("\n"));
  }
  const daily = [...result.result.usage.daily]
    .sort((left, right) => right.startDate.localeCompare(left.startDate))
    .slice(0, 7);
  const lines = [
    "OpenAI Codex 账户用量摘要：",
    `累计 Tokens：${formatMillions(result.result.usage.summary.lifetimeTokens)}`,
    `单日峰值：${formatMillions(result.result.usage.summary.peakDailyTokens)}`,
    `最长 Turn：${formatAccountDuration(result.result.usage.summary.longestRunningTurnSec)}`,
    `当前连续天数：${formatMetric(result.result.usage.summary.currentStreakDays)}`,
    `最长连续天数：${formatMetric(result.result.usage.summary.longestStreakDays)}`,
    "",
    "最近每日用量：",
    ...(daily.length === 0
      ? ["暂无每日数据"]
      : daily.map(
          (entry) => `- ${entry.startDate}：${formatMillions(entry.tokens)}`,
        )),
  ];
  appendThreadUsage(lines, result.result.threadUsage);
  return toStructuredMarkdownList(lines.join("\n"));
}

function appendThreadUsage(
  lines: string[],
  threadUsage: AccountThreadUsage | undefined,
): void {
  if (!threadUsage) {
    return;
  }
  lines.push("", "当前 Thread 官方估算：");
  if (threadUsage.kind === "unavailable") {
    lines.push(
      "当前 Thread 的官方计费估算不可用；该能力目前仅向部分 Business/Enterprise 工作区开放。",
    );
    return;
  }
  if (threadUsage.kind === "failed") {
    lines.push("当前 Thread 官方估算暂时无法查询，请稍后重试 /usage。");
    return;
  }
  lines.push(`Credits：${formatMicros(threadUsage.estimatedUsageCreditsMicros)}`);
  if (threadUsage.estimatedUsageUsdMicros !== null) {
    lines.push(`估算费用：$${formatMicros(threadUsage.estimatedUsageUsdMicros)}`);
  }
  const tokenSummary = formatThreadTokenSummary(threadUsage.groups);
  if (tokenSummary) {
    lines.push(`计费 Token：${tokenSummary}`);
  }
  const visibleGroups = threadUsage.groups.slice(0, maximumThreadUsageGroups);
  lines.push(
    ...visibleGroups.map((group) =>
      `${group.model ?? "其他"} · ${group.reasoningEffort ?? "其他"} · ${group.speed ?? "其他"}`
      + `：${formatMicros(group.estimatedUsageCreditsMicros)} Credits`),
  );
  if (threadUsage.groups.length > visibleGroups.length) {
    lines.push(`尚未展示 ${threadUsage.groups.length - visibleGroups.length} 组`);
  }
  lines.push(
    "",
    "官方估算可能延迟更新；本地请求明细与子代理累计请查看 /metrics。",
  );
}

function formatThreadTokenSummary(
  groups: readonly AccountThreadUsageGroup[],
): string | null {
  if (groups.length === 0) {
    return null;
  }
  const entries: Array<[
    string,
    "inputTokens" | "cachedInputTokens" | "outputTokens",
  ]> = [
    ["输入", "inputTokens"],
    ["缓存", "cachedInputTokens"],
    ["输出", "outputTokens"],
  ];
  const parts = entries.flatMap(([label, field]) => {
    const total = sumThreadMetric(groups, field);
    return total === null ? [] : [`${label} ${formatMetric(total)}`];
  });
  return parts.length === 0 ? null : parts.join(" · ");
}

function sumThreadMetric(
  groups: readonly AccountThreadUsageGroup[],
  field: "inputTokens" | "cachedInputTokens" | "outputTokens",
): AccountMetric | null {
  let total = 0n;
  for (const group of groups) {
    const value = group[field];
    if (value === null) {
      return null;
    }
    total += typeof value === "bigint" ? value : BigInt(value);
  }
  return total;
}

function formatMicros(value: AccountMetric): string {
  const micros = typeof value === "bigint" ? value : BigInt(value);
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function formatUsdAmount(nanos: number): string {
  return `$${(nanos / 1_000_000_000).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatConversationLimits(
  result: Extract<ConversationCommandResult, { kind: "limits" }>,
): string {
  if (result.result.kind === "unsupported") {
    return `${formatCodexProviderLabel(result.result.provider)} 仅提供模型请求，不提供账户限额查询。请求统计可通过 /metrics 查看。`;
  }
  const planType = result.result.limits.limits.find(
    (limit) => limit.planType,
  )?.planType;
  const weeklyEstimates = result.result.weeklyEstimates ?? [];
  const hasWeeklyWindow = result.result.limits.limits.some((limit) =>
    [limit.primary, limit.secondary].some(
      (window) => window?.windowDurationMins === 10_080,
    ));
  return toStructuredMarkdownList([
    "OpenAI Codex 额度：",
    `套餐：${planType ? formatPlanType(planType) : "未知"}`,
    ...result.result.limits.limits.flatMap((limit) => [
      "",
      `${limit.limitName ?? limit.limitId}：`,
      `主窗口：${formatAccountLimitWindow(limit.primary)}`,
      ...(limit.secondary
        ? [`次窗口：${formatAccountLimitWindow(limit.secondary)}`]
        : []),
      ...(limit.credits
        ? [`Credits：${limit.credits.unlimited
          ? "无限"
          : limit.credits.hasCredits
            ? `余额 ${limit.credits.balance ?? "未知"}`
            : "无可用 Credits"}`]
        : []),
      ...(limit.individualLimit
        ? [
            `个人限额：已用 ${limit.individualLimit.used} / ${limit.individualLimit.limit}`,
            `个人限额剩余：${formatPercent(limit.individualLimit.remainingPercent)}`,
            `个人限额重置：${formatResetTime(limit.individualLimit.resetsAt)}`,
          ]
        : []),
      ...(limit.spendControlReached === null
        ? []
        : [`消费控制：${limit.spendControlReached ? "已达到上限" : "正常"}`]),
      `限流状态：${formatRateLimitState(limit.rateLimitReachedType)}`,
    ]),
    ...(result.result.limits.resetCreditsAvailable === null
      ? []
      : ["", `可用额度重置券：${result.result.limits.resetCreditsAvailable}`]),
    ...(hasWeeklyWindow
      ? [
          "",
          "周限估算（本机代理样本）：",
          ...(weeklyEstimates.length === 0
            ? ["正在采样；需要同一周窗口内至少出现一次可观测的额度增长。"]
            : weeklyEstimates.flatMap((estimate) => {
                const pricedSuccesses = Math.max(
                  0,
                  estimate.requestCount - estimate.unsuccessfulRequestCount,
                );
                return [
                `${estimate.limitId}：已使用 ${formatPercent(estimate.usedPercent)} · 观测变化 ${formatPercent(estimate.observedDeltaPercent)}（${estimate.intervalCount} 个区间）`,
                `样本：${estimate.requestCount} 次请求${estimate.unsuccessfulRequestCount > 0 ? ` · ${estimate.unsuccessfulRequestCount} 次未成功` : ""}`,
                `每 1%：约 ${formatTokenCount(estimate.totalTokensPerPercent)} Token`,
                `  - 输入：约 ${formatTokenCount(estimate.inputTokensPerPercent)}`,
                `  - 输出：约 ${formatTokenCount(estimate.outputTokensPerPercent)}`,
                `  - API 参考费用：${formatEstimatedLimitCost(estimate.pricingCurrency, estimate.costPerPercentNanos)}${estimate.pricedRequestCount === pricedSuccesses ? "" : `（计价 ${estimate.pricedRequestCount}/${pricedSuccesses}）`}`,
                `剩余 ${formatPercent(estimate.remainingPercent)}：约 ${formatTokenCount(estimate.remainingTokens)} Token · API 参考费用 ${formatEstimatedLimitCost(estimate.pricingCurrency, estimate.remainingCostNanos)}`,
                ...(estimate.observedDeltaPercent < 1
                  ? ["提示：观测到的额度变化不足 1%，估算波动可能较大。"]
                  : []),
                ];
              })),
          "口径：按统计代理相邻额度快照的增量折算；其他客户端在快照间的用量可能造成偏差，费用不是订阅实际扣款。",
        ]
      : []),
  ].join("\n"));
}

function formatEstimatedLimitCost(
  currency: string | null,
  nanos: number | null,
): string {
  return currency === null || nanos === null
    ? "暂无完整价格样本"
    : `约 ${formatCurrencyNanos(currency, nanos)}`;
}

export function formatConversationStatus(status: ConversationStatus): string {
  const lines = [
    "Codex 状态",
    `Workspace：${status.workspaceName} (${status.workspaceId})`,
    `Thread：${status.threadId ?? "尚未绑定"}`,
    `Turn：${status.turnId ?? "空闲"}`,
    `工作目录：${status.cwd}`,
    `Git 分支：${status.gitBranch ?? "未检测到"}`,
    `模型：${status.model}${status.modelPending ? "（下一次 Turn 生效）" : ""}`,
    `提供商：${formatCodexProviderLabel(status.modelProvider)}`,
    `思考等级：${status.effort ?? "模型默认"}${status.effortPending ? "（下一次 Turn 生效）" : ""}`,
    ...(supportsFastMode(status.modelProvider)
      ? [`Fast 模式：${status.threadId ? (isFastServiceTier(status.serviceTier) ? "开启" : "关闭") : "未知"}${status.fastModePending ? "（下一次 Turn 生效）" : ""}`]
      : []),
    `协作模式：${status.collaborationMode === "plan" ? "Plan" : "Default"}${status.collaborationModePending ? "（下一次 Turn 生效）" : ""}`,
  ];
  if (status.contextCompactionCount !== undefined) {
    lines.push(`上下文压缩：${status.contextCompactionCount} 次`);
  }
  if (status.goal) {
    lines.push(
      `Goal 状态：${formatGoalStatus(status.goal.status)}`,
      `Goal 目标：${status.goal.objective}`,
      `Goal 用量：${formatGoalUsage(status.goal)}`,
    );
  }
  if (status.tokenUsage) {
    const { total, last, modelContextWindow } = status.tokenUsage;
    lines.push(
      "",
      "当前 Thread 用量：",
      `- **Token**：${formatTokenCount(total.totalTokens)}`,
      `  - 最近模型请求：${formatTokenCount(last.totalTokens)}`,
      `  - 输入命中缓存：${formatTokenCount(total.cachedInputTokens)}`,
      `  - 输入未命中缓存：${formatTokenCount(Math.max(0, total.inputTokens - total.cachedInputTokens))}`,
      `  - 缓存命中率：${formatCacheHitRate(total.inputTokens, total.cachedInputTokens)}`,
      ...(total.cacheWriteInputTokens > 0
        ? [`  - 缓存写入：${formatTokenCount(total.cacheWriteInputTokens)}`]
        : []),
      `  - 输出：${formatTokenCount(total.outputTokens)}`,
      ...(total.reasoningOutputTokens > 0
        ? [`  - 其中推理输出：${formatTokenCount(total.reasoningOutputTokens)}`]
        : []),
      `  - Codex 有效上下文窗口：${modelContextWindow === null ? "未知" : formatTokenCount(modelContextWindow)}`,
    );
  } else if (status.threadId) {
    lines.push("", "当前 Thread 用量：等待 App Server 推送统计");
  }
  if (usesOpenAiAccount(status.modelProvider) && status.weeklyLimit) {
    lines.push(`周限：${formatRemainingRateLimitWindow(status.weeklyLimit)}`);
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

export { formatConversationMetrics } from "./metrics-format.js";

function formatGoalStatus(status: ThreadGoal["status"]): string {
  switch (status) {
    case "active":
      return "进行中";
    case "paused":
      return "已暂停";
    case "blocked":
      return "已阻塞";
    case "usageLimited":
      return "用量受限";
    case "budgetLimited":
      return "预算已用尽";
    case "complete":
      return "已完成";
  }
}

function formatGoalUsage(goal: ThreadGoal): string {
  const tokens = goal.tokenBudget === null
    ? formatTokenCount(goal.tokensUsed)
    : `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)}`;
  return `${tokens} · ${formatDuration(goal.timeUsedSeconds)}`;
}

function formatGoalTokens(goal: ThreadGoal): string {
  return goal.tokenBudget === null
    ? formatTokenCount(goal.tokensUsed)
    : `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)}`;
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor(wholeSeconds % 3_600 / 60);
  const remainder = wholeSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}小时`] : []),
    ...(minutes > 0 ? [`${minutes}分`] : []),
    ...(remainder > 0 || (hours === 0 && minutes === 0)
      ? [`${remainder}秒`]
      : []),
  ].join("");
}

function formatAccountLimitWindow(
  window: Parameters<typeof formatRateLimitWindow>[0],
): string {
  return formatRateLimitWindow(window);
}

function formatMetric(value: bigint | number | null): string {
  return value === null ? "未知" : String(value);
}

function formatAccountDuration(value: bigint | number | null): string {
  return value === null ? "未知" : formatElapsedSeconds(value);
}

function formatMillions(value: bigint | number | null): string {
  return value === null
    ? "未知"
    : `${(Number(value) / 1_000_000).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} M`;
}
