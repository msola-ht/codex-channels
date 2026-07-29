import {
  type ConversationCommandResult,
  type ConversationStatus,
} from "../../application/index.js";
import type {
  OutputEvent,
  UserFacingError,
} from "../../conversation-core/index.js";
import {
  conversationCommandHelpLines,
  formatConversationArtifacts,
  formatConversationCollaborationMode,
  formatConversationCommandOutcome,
  formatConversationGoal,
  formatConversationLimits,
  formatConversationMcp,
  formatConversationModels,
  formatConversationPermissions,
  formatConversationPlugins,
  formatConversationProjectRules,
  formatConversationSkills,
  formatConversationStatus,
  formatConversationUsage,
  formatConversationWorkspaces,
} from "../conversation-command-format.js";
import {
  createStartupPresentation,
  createTurnCompletedPresentation,
  renderPlainLifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";

const maximumSessionEntries = 20;
const maximumSessionLabelCharacters = 48;

export type WeixinStartupRuntimeInfo = LifecycleStartupRuntimeInfo;

export function renderWeixinStartupNotification(
  workspaces: ReadonlyArray<{ id: string; name: string; cwd: string }>,
  status: Pick<
    ConversationStatus,
    | "threadId"
    | "workspaceId"
    | "model"
    | "effort"
    | "serviceTier"
    | "modelPending"
    | "effortPending"
    | "fastModePending"
    | "collaborationMode"
    | "collaborationModePending"
    | "weeklyLimit"
    | "gitBranch"
  >,
  runtime: WeixinStartupRuntimeInfo,
): string {
  return renderPlainLifecyclePresentation(
    createStartupPresentation(workspaces, status, runtime),
  );
}

export function renderWeixinHelp(): string {
  return [
    "微信 Codex 命令",
    "普通文本会发送到当前 Codex Thread。",
    ...conversationCommandHelpLines,
    "/whoami",
    "/weixin doctor",
    "/start · /help",
  ].join("\n");
}

export function renderWeixinIdentity(message: {
  actorId: string;
  target: {
    accountId: string;
    conversationId: string;
  };
}): string {
  return [
    "微信身份",
    `用户 ID：${message.actorId}`,
    `会话 ID：${message.target.conversationId}`,
    `账号 ID：${message.target.accountId}`,
  ].join("\n");
}

export function renderWeixinTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
): string {
  return renderPlainLifecyclePresentation(
    createTurnCompletedPresentation(event),
  );
}

export function renderWeixinCommandResult(
  result: ConversationCommandResult,
): string {
  switch (result.kind) {
    case "outcome":
      return formatConversationCommandOutcome(result.outcome);
    case "sessions":
      return renderSessions(result);
    case "status":
      return formatConversationStatus(result.status);
    case "workspaces":
      return formatConversationWorkspaces(result);
    case "models":
      return formatConversationModels(result);
    case "collaboration-mode":
      return formatConversationCollaborationMode(result);
    case "skills":
      return formatConversationSkills(result);
    case "mcp":
      return formatConversationMcp(result);
    case "plugins":
      return formatConversationPlugins(result);
    case "usage":
      return formatConversationUsage(result);
    case "limits":
      return formatConversationLimits(result);
    case "permissions":
      return formatConversationPermissions(result);
    case "project-rules":
      return formatConversationProjectRules(result);
    case "artifacts":
      return formatConversationArtifacts(result);
    case "goal":
      return formatConversationGoal(result);
  }
}

export function renderWeixinUserFacingError(
  error: UserFacingError,
): string {
  return formatSurfaceUserFacingError(error, "微信");
}

export function formatWeixinCommandText(text: string): string {
  return text.replace(/(?:\r?\n)+/gu, "\n\n");
}

function renderSessions(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
): string {
  if (result.sessions.length === 0) {
    return result.archived
      ? "当前 Workspace 没有匹配的已归档会话。"
      : "当前 Workspace 没有匹配的可恢复会话。";
  }
  const sessions = result.sessions.slice(0, maximumSessionEntries);
  const hiddenCount = result.sessions.length - sessions.length;
  return [
    `${result.archived ? "已归档会话" : "历史会话"}（${result.sessions.length}）${result.searchTerm ? ` · 搜索：${result.searchTerm}` : ""}：`,
    ...sessions.map(
      (session, index) =>
        `${index + 1}. ${sessionLabel(session.name ?? session.preview)} · ${session.id.slice(0, 12)} · ${session.status.type}${session.id === result.currentThreadId ? " ← 当前" : ""}`,
    ),
    ...(hiddenCount > 0
      ? [`另有 ${hiddenCount} 条未显示，请使用搜索词缩小范围。`]
      : []),
    result.archived
      ? "恢复归档：/unarchive <序号、名称或 Thread ID>"
      : "恢复：/resume <序号、名称或 Thread ID>",
  ].join("\n");
}

function sessionLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "未命名";
  }
  return normalized.length > maximumSessionLabelCharacters
    ? `${normalized.slice(0, maximumSessionLabelCharacters - 1)}…`
    : normalized;
}
