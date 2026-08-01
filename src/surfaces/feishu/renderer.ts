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
  formatConversationSessions,
  formatConversationSkills,
  formatConversationStatus,
  formatConversationUsage,
  formatConversationWorkspaces,
} from "../conversation-command-format.js";
import {
  emptyCodexResponseText,
  formatCliInput,
} from "../output-copy.js";
import { formatSurfaceConfigurationChange } from "../configuration-change-format.js";
import {
  createStartupPresentation,
  createTurnCompletedPresentation,
  createTurnStartedPresentation,
  type LifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import { formatVisionStarted } from "../input-copy.js";
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

export type FeishuStartupRuntimeInfo = LifecycleStartupRuntimeInfo;

export function renderFeishuStartupNotification(
  workspaces: ReadonlyArray<{ id: string; name: string; cwd: string }>,
  status: Pick<
    ConversationStatus,
    | "threadId"
    | "workspaceId"
    | "model"
    | "modelProvider"
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
    "飞书：",
    "- /whoami · /fs <status|doctor|revoke>",
    "- /start · /help · /h",
    "- /vision <图片识别要求> · /vision cancel",
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
    case "vision.started":
      return formatVisionStarted(event.imageCount);
    case "turn.started":
      return renderFeishuLifecyclePresentation(
        createTurnStartedPresentation(),
      );
    case "text.delta":
      return null;
    case "user.message":
      return formatCliInput(event.text);
    case "text.completed":
      return event.text.trim() ? event.text : emptyCodexResponseText;
    case "operation.updated":
    case "plan.updated":
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

function threadStatusLabel(status: string): string {
  return status === "active"
    ? "运行中"
    : status === "idle"
      ? "空闲"
      : "未知";
}
