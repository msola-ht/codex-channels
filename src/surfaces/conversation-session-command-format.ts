import type {
  ConversationCommandResult,
  ThreadQueueInputType,
  ThreadQueueItem,
} from "../application/index.js";

import { toStructuredMarkdownList } from "./markdown-list.js";
import { formatDisplayedProvider } from "./conversation-model-account-command-format.js";

const maximumSessionEntries = 20;
const maximumSessionLabelCharacters = 48;
const maximumProcessCommandCharacters = 160;

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
        `${session.selector ?? index + 1}. ${formatSessionSection(session)}${formatSessionLabel(session.name ?? session.preview)}${session.model ? ` · 模型：${session.model}` : ""}${session.reasoningEffort ? ` · 思考等级：${session.reasoningEffort}` : ""}${session.modelProvider ? ` · Provider：${formatDisplayedProvider(session.modelProvider)}` : ""}${session.turnCount === undefined ? "" : ` · 轮数：${session.turnCount}`} · ${session.id.slice(0, 12)} · ${session.status.type}${session.id === result.currentThreadId ? " ← 当前" : backgroundThreadIds.has(session.id) ? " · 后台运行" : ""}`,
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
      ? "恢复归档：/unarchive <序号、名称或 Session ID>"
      : "恢复：/resume <序号、名称或 Session ID>",
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
    "确认完成前请勿从 TUI 或其他客户端向该 Session 追加 Turn。",
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

export function formatSessionListCommand(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
  page: number,
): string {
  const command = result.archived ? "archived" : "sessions";
  const parts = [`/${command}`, String(page)];
  if (result.view.filter !== "all") parts.push("filter", result.view.filter);
  if (result.view.provider) parts.push("provider", result.view.provider);
  if (result.view.searchTerm) parts.push("search", result.view.searchTerm);
  return parts.join(" ");
}

function formatSessionSection(
  session: Extract<ConversationCommandResult, { kind: "sessions" }>["sessions"][number],
): string {
  if (session.isPinned) return "固定 · ";
  return "";
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

export function formatConversationOccupancy(
  result: Extract<ConversationCommandResult, { kind: "occupancy" }>,
): string {
  const { result: release } = result;
  switch (release.status) {
    case "unbound":
      return toStructuredMarkdownList([
        "当前会话没有绑定 Codex Session，无需释放占用。",
      ].join("\n"));
    case "free":
      return toStructuredMarkdownList([
        "当前会话的 Codex Session 未被占用。",
        `Session ID：${release.threadId}`,
      ].join("\n"));
    case "released":
      return toStructuredMarkdownList([
        "已释放 Codex Session 占用，正在自动恢复订阅。",
        `Session ID：${release.threadId}`,
        `占用进程：PID ${release.holder.pid}`,
        formatProcessCommand(release.holder.command),
      ].join("\n"));
    case "held":
      return toStructuredMarkdownList([
        `Codex Session 被 PID ${release.holder.pid} 占用。`,
        `进程：${formatProcessCommand(release.holder.command)}`,
        release.releasable
          ? release.stuck
            ? "当前会话恢复失败，可确认释放：/release force（会向该进程发送结束信号；若是 App Server 子进程，服务会自动重启并重连所有会话）。"
            : "当前会话运行正常，通常无需释放；如确认需要，/release force 会结束该进程（App Server 子进程会重启并重连所有会话）。"
          : "该进程无法自动释放，请关闭占用 Session 的 Codex 客户端，或重启 App Server 服务。",
        `Session ID：${release.threadId}`,
      ].join("\n"));
    case "unidentifiable":
      return toStructuredMarkdownList([
        "无法识别占用 Codex Session 的进程（当前平台不支持进程诊断）。",
        "请关闭占用该 Session 的 Codex 客户端，或重启 App Server 服务后等待自动恢复。",
        `Session ID：${release.threadId}`,
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

export function formatQueueItem(
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

export function formatTakeoverSource(surface: string): string {
  switch (surface) {
    case "telegram":
      return "已从 Telegram 接管 Codex Session";
    case "feishu":
      return "已从飞书接管 Codex Session";
    case "weixin":
      return "已从微信接管 Codex Session";
    default:
      return "已从其他渠道接管 Codex Session";
  }
}
