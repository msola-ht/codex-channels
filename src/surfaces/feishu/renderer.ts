import type {
  ConversationCommandResult,
  ConversationStatus,
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
import { formatSurfaceConfigurationChange } from "../configuration-change-format.js";
import {
  createStartupPresentation,
  createTurnCompletedPresentation,
  createTurnStartedPresentation,
  type LifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";
import {
  formatCodexWarning,
  formatConnectionLost,
} from "../output-copy.js";
import {
  formatRuntimeAccountUpdate,
  formatRuntimeMcpStatusUpdate,
  formatRuntimeRateLimitUpdate,
} from "../runtime-status-format.js";
import type { SurfaceConfigurationChange } from "../types.js";
import type { FeishuInboxMessage } from "./inbox.js";

const maximumFeishuSessionEntries = 20;
const maximumFeishuSessionLabelCharacters = 48;

export type FeishuStartupRuntimeInfo = LifecycleStartupRuntimeInfo;

export function renderFeishuStartupNotification(
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
  runtime: FeishuStartupRuntimeInfo,
): string {
  return renderFeishuLifecyclePresentation(
    createStartupPresentation(workspaces, status, runtime),
  );
}

export function renderFeishuHelp(): string {
  return [
    "飞书 Codex 命令",
    "",
    "普通文本会发送到当前 Codex Thread。",
    "",
    ...conversationCommandHelpLines,
    "/whoami",
    "/feishu <status|doctor|revoke>",
    "/start · /help",
  ].join("\n");
}

export function renderFeishuIdentity(
  message: Pick<FeishuInboxMessage, "actorId" | "target">,
): string {
  return [
    "飞书身份",
    `用户 Open ID：${message.actorId}`,
    `Chat ID：${message.target.conversationId}`,
    `App ID：${message.target.accountId}`,
  ].join("\n");
}

export function renderFeishuCommandResult(
  result: ConversationCommandResult,
): string {
  switch (result.kind) {
    case "outcome":
      return formatConversationCommandOutcome(result.outcome);
    case "sessions":
      return renderFeishuSessions(result);
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

export function renderFeishuConfigurationChange(
  change: SurfaceConfigurationChange,
): string {
  return formatSurfaceConfigurationChange(change, "feishu");
}

export function renderFeishuUserFacingError(
  error: UserFacingError,
): string {
  return formatSurfaceUserFacingError(error, "飞书");
}

export function renderFeishuOutput(event: OutputEvent): string | null {
  switch (event.type) {
    case "turn.started":
      return renderFeishuLifecyclePresentation(
        createTurnStartedPresentation(),
      );
    case "text.delta":
      return null;
    case "user.message":
      return `CLI 输入\n${event.text}`;
    case "text.completed":
      return event.text.trim() ? event.text : "Codex 返回了空消息。";
    case "operation.updated":
      return null;
    case "turn.completed":
      return renderFeishuTurnCompleted(event);
    case "thread.status":
      return `Thread 状态：${threadStatusLabel(event.status)}`;
    case "connection.lost":
      return formatConnectionLost(visibleUpstreamMessage(event.message));
    case "account.updated":
      return formatRuntimeAccountUpdate(event.authMode, event.planType);
    case "account.rateLimits.updated":
      return formatRuntimeRateLimitUpdate(event.rateLimits);
    case "mcp.status.updated":
      return formatRuntimeMcpStatusUpdate(event);
    case "warning":
      return formatCodexWarning(visibleUpstreamMessage(event.message));
  }
}

function renderFeishuTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
): string {
  return renderFeishuLifecyclePresentation(
    createTurnCompletedPresentation(event),
  );
}

function renderFeishuLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  return [
    `**${presentation.title}**`,
    ...(presentation.fields.length > 0
      ? [
          "",
          ...presentation.fields.map(
            ({ label, value }) => `- **${label}：** ${value}`,
          ),
        ]
      : []),
    ...(presentation.sections ?? []).flatMap((section) => [
      "",
      `**${section.title}**`,
      ...section.fields.map(
        ({ label, value }) => `- **${label}：** ${value}`,
      ),
    ]),
  ].join("\n");
}

function visibleUpstreamMessage(message: string): string {
  return message.replaceAll("[REDACTED]", "[已隐藏]");
}

function renderFeishuSessions(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
): string {
  if (result.sessions.length === 0) {
    return result.archived
      ? "当前 Workspace 没有匹配的已归档会话。"
      : "当前 Workspace 没有匹配的可恢复会话。";
  }
  const visibleSessions = result.sessions.slice(
    0,
    maximumFeishuSessionEntries,
  );
  const hiddenCount = result.sessions.length - visibleSessions.length;
  return [
    `${result.archived ? "已归档会话" : "历史会话"}（${result.sessions.length}）${result.searchTerm ? ` · 搜索：${result.searchTerm}` : ""}：`,
    ...visibleSessions.map((session, index) => {
      const label = formatFeishuSessionLabel(
        session.name ?? session.preview,
      );
      return `${index + 1}. ${label} · ${session.id.slice(0, 12)} · ${session.status.type}${session.id === result.currentThreadId ? " ← 当前" : ""}`;
    }),
    ...(hiddenCount > 0
      ? [
          "",
          `另有 ${hiddenCount} 条未显示，请使用 /${result.archived ? "archived" : "sessions"} <搜索词> 缩小范围。`,
        ]
      : []),
    "",
    result.archived
      ? "恢复归档：/unarchive <序号、名称或 Thread ID>"
      : "恢复：/resume <序号、名称或 Thread ID>",
  ].join("\n");
}

function formatFeishuSessionLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return "未命名";
  }
  return normalized.length > maximumFeishuSessionLabelCharacters
    ? `${normalized.slice(0, maximumFeishuSessionLabelCharacters - 1)}…`
    : normalized;
}

function threadStatusLabel(status: string): string {
  return status === "active"
    ? "运行中"
    : status === "idle"
      ? "空闲"
      : "未知";
}
