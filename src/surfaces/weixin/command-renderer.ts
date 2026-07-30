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
  formatConversationSessions,
  formatConversationSkills,
  formatConversationStatus,
  formatConversationUsage,
  formatConversationWorkspaces,
} from "../conversation-command-format.js";
import {
  createStartupPresentation,
  createTurnCompletedPresentation,
  type LifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";

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
  return renderWeixinLifecyclePresentation(
    createStartupPresentation(workspaces, status, runtime),
  );
}

export function renderWeixinHelp(): string {
  return [
    "微信 Codex 命令",
    "普通文本会发送到当前 Codex Thread。",
    ...conversationCommandHelpLines,
    "微信：",
    "- /whoami · /wx doctor",
    "- /start · /help · /h",
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
  return renderWeixinLifecyclePresentation(
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
      return formatConversationSessions(result);
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
  const lines = text
    .replace(/\r\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .split("\n");
  let fenced = false;
  return lines.map((line, index) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return line;
    }
    const next = lines[index + 1];
    if (
      fenced
      || line.length === 0
      || next === undefined
      || next.length === 0
      || next.trimStart().startsWith("```")
    ) {
      return line;
    }
    return `${line}  `;
  }).join("\n");
}

function renderWeixinLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  return [
    presentation.title,
    ...presentation.fields.map(formatLifecycleField),
    ...(presentation.sections ?? []).flatMap((section) => [
      "",
      section.title,
      ...section.fields.map(formatLifecycleField),
    ]),
  ].join("\n");
}

function formatLifecycleField(
  field: LifecyclePresentation["fields"][number],
): string {
  return `- ${field.label}：${field.value}`;
}
