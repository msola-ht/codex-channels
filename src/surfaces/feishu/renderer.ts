import type {
  ConversationCommandResult,
  ConversationStatus,
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
} from "../../application/index.js";
import type {
  OutputEvent,
  UserFacingError,
} from "../../conversation-core/index.js";
import {
  conversationCommandHelpLines,
  formatConversationAgents,
  formatConversationArtifacts,
  formatConversationCollaborationMode,
  formatConversationCommandOutcome,
  isTurnLifecycleAcknowledgedOutcome,
  formatConversationGoal,
  formatConversationLimits,
  formatConversationMetrics,
  formatConversationMcp,
  formatConversationMcpDetail,
  formatConversationMcpHealth,
  formatConversationMcpLogin,
  formatConversationMcpReload,
  formatConversationMcpResource,
  formatConversationPluginDetail,
  formatConversationPlugins,
  formatConversationModels,
  formatConversationPermissions,
  formatConversationProjectRules,
  formatConversationSessions,
  formatConversationSkills,
  formatConversationStatus,
  formatConversationUsage,
  formatConversationWorkspacePermissions,
  formatConversationWorkspaces,
  toStructuredMarkdownList,
} from "../conversation-command-format.js";
import {
  emptyCodexResponseText,
  formatCliInput,
} from "../output-copy.js";
import { formatSurfaceConfigurationChange } from "../configuration-change-format.js";
import {
  createStartupPresentation,
  createSubagentCompletedPresentation,
  createSubagentStartedPresentation,
  createTurnCompletedPresentation,
  createTurnStartedPresentation,
  renderStructuredLifecyclePresentation,
  type LifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import {
  formatVisionCompleted,
  formatVisionProgress,
  formatVisionStarted,
} from "../input-copy.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";
import {
  formatCodexWarning,
  formatConnectionLost,
} from "../output-copy.js";
import {
  formatRuntimeAccountUpdate,
  formatRuntimeMcpOAuthCompleted,
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
  return toStructuredMarkdownList([
    "飞书 Codex 命令",
    "",
    "普通文本会发送到当前 Codex Thread。",
    "",
    ...conversationCommandHelpLines,
    "飞书：",
    "- /whoami · /fs <status|doctor|revoke>",
    "- /start · /help · /h",
    "- /vision <要求> · /vision <2–4> <要求> · /vision retry · /vision cancel",
  ].join("\n"));
}

export function renderFeishuIdentity(
  message: Pick<FeishuInboxMessage, "actorId" | "target">,
): string {
  return toStructuredMarkdownList([
    "飞书身份",
    `用户 Open ID：${message.actorId}`,
    `Chat ID：${message.target.conversationId}`,
    `App ID：${message.target.accountId}`,
  ].join("\n"));
}

export function renderFeishuCommandResult(
  result: ConversationCommandResult,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string | null {
  switch (result.kind) {
    case "outcome":
      if (isTurnLifecycleAcknowledgedOutcome(result.outcome)) {
        return null;
      }
      return formatConversationCommandOutcome(result.outcome);
    case "sessions":
      return formatConversationSessions(result);
    case "status":
      return formatConversationStatus(result.status);
    case "workspaces":
      return formatConversationWorkspaces(result);
    case "workspace-permissions":
      return formatConversationWorkspacePermissions(result);
    case "models":
      return formatConversationModels(result);
    case "collaboration-mode":
      return formatConversationCollaborationMode(result);
    case "skills":
      return formatConversationSkills(result);
    case "agents":
      return formatConversationAgents(result);
    case "mcp":
      return formatConversationMcp(result);
    case "mcp-health":
      return formatConversationMcpHealth(result);
    case "mcp-reload":
      return formatConversationMcpReload(result);
    case "mcp-detail":
      return formatConversationMcpDetail(result);
    case "mcp-login":
      return formatConversationMcpLogin(result);
    case "mcp-resource":
      return formatConversationMcpResource(result);
    case "plugins":
      return formatConversationPlugins(result);
    case "plugin-detail":
      return formatConversationPluginDetail(result);
    case "usage":
      return formatConversationUsage(result);
    case "metrics":
      return formatConversationMetrics(result, priceCurrency, exchangeRate);
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

export function renderFeishuOutput(
  event: OutputEvent,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
  debug = false,
): string | null {
  switch (event.type) {
    case "vision.started":
      return formatVisionStarted(event.imageCount);
    case "vision.progress":
      return formatVisionProgress(event.elapsedSeconds);
    case "vision.completed":
      return formatVisionCompleted(event, debug);
    case "turn.started":
      return renderFeishuLifecyclePresentation(
        createTurnStartedPresentation(
          event.background ? event.threadId : undefined,
          event.identity,
        ),
      );
    case "text.delta":
      return null;
    case "user.message":
      return formatCliInput(event.text);
    case "text.completed":
      return event.text.trim()
        ? `${event.background ? `后台任务 · ${event.threadId.slice(0, 12)}\n\n` : ""}${event.text}`
        : emptyCodexResponseText;
    case "operation.updated":
    case "plan.updated":
      return null;
    case "subagent.spawned":
      return renderFeishuLifecyclePresentation(
        createSubagentStartedPresentation(event),
      );
    case "subagent.completed":
      return renderFeishuSubagentCompleted(event, priceCurrency, exchangeRate, debug);
    case "turn.completed":
      return renderFeishuTurnCompleted(event, priceCurrency, exchangeRate, debug);
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
    case "mcp.oauth.completed":
      return formatRuntimeMcpOAuthCompleted(event);
    case "warning":
      return formatCodexWarning(visibleUpstreamMessage(event.message));
  }
}

function renderFeishuSubagentCompleted(
  event: Extract<OutputEvent, { type: "subagent.completed" }>,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
  debug = false,
): string {
  return renderFeishuLifecyclePresentation(
    createSubagentCompletedPresentation(event, priceCurrency, exchangeRate, debug),
  );
}

function renderFeishuTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
  debug = false,
): string {
  return renderFeishuLifecyclePresentation(
    createTurnCompletedPresentation(event, priceCurrency, exchangeRate, debug),
  );
}

function renderFeishuLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  return renderStructuredLifecyclePresentation(presentation);
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
