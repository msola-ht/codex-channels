import type { ConversationCommandResult } from "../application/index.js";
import { formatConversationHooks } from "./conversation-hook-command-format.js";

import {
  formatConversationAgents,
  formatConversationMcp,
  formatConversationMcpDetail,
  formatConversationMcpHealth,
  formatConversationMcpLogin,
  formatConversationMcpReload,
  formatConversationMcpResource,
  formatConversationPluginDetail,
  formatConversationPluginHealth,
  formatConversationPlugins,
  formatConversationSkills,
} from "./conversation-extension-command-format.js";
import {
  formatConversationLimits,
  formatConversationResetCredits,
  formatConversationModels,
  formatConversationUsage,
} from "./conversation-model-account-command-format.js";
import {
  formatConversationOccupancy,
  formatConversationSessions,
  formatConversationThreadQueue,
  formatConversationThreadRevert,
  formatConversationThreadRevertPreview,
  isTurnLifecycleAcknowledgedOutcome,
} from "./conversation-session-command-format.js";
import {
  formatConversationScheduledConfirmation,
  formatConversationScheduledRuns,
  formatConversationScheduledTasks,
} from "./conversation-scheduled-task-command-format.js";
import {
  formatConversationArtifacts,
  formatConversationAutoReview,
  formatConversationCollaborationMode,
  formatConversationGoal,
  formatConversationPermissions,
  formatConversationStatus,
  formatConversationWorkspaces,
} from "./conversation-workspace-status-command-format.js";
import { formatConversationCommandOutcome } from "./conversation-command-outcome-format.js";
import { formatConversationMetrics } from "./metrics-format.js";

export function renderConversationCommandResult(
  result: ConversationCommandResult,
  formatCommand?: (command: string) => string,
  formatLiteral?: (value: string) => string,
): string | null {
  switch (result.kind) {
    case "outcome":
      if (isTurnLifecycleAcknowledgedOutcome(result.outcome)) {
        return null;
      }
      return formatConversationCommandOutcome(result.outcome, formatLiteral);
    case "sessions":
      return formatConversationSessions(result, formatLiteral, formatCommand);
    case "thread-queue":
      return formatConversationThreadQueue(result);
    case "thread-revert":
      return formatConversationThreadRevert(result);
    case "thread-revert-preview":
      return formatConversationThreadRevertPreview(result);
    case "scheduled-tasks":
      return formatConversationScheduledTasks(result, "snapshot", "text", formatLiteral);
    case "scheduled-runs":
      return formatConversationScheduledRuns(result, "snapshot", "text", formatLiteral);
    case "scheduled-confirmation":
      return formatConversationScheduledConfirmation(result, formatLiteral);
    case "status":
      return formatConversationStatus(result.status, undefined, result);
    case "workspaces":
      return formatConversationWorkspaces(result, formatLiteral);
    case "auto-review":
      return formatConversationAutoReview(result, formatCommand);
    case "models":
      return formatConversationModels(result, formatCommand, formatLiteral);
    case "collaboration-mode":
      return formatConversationCollaborationMode(result);
    case "skills":
      return formatConversationSkills(result, false, formatLiteral);
    case "agents":
      return formatConversationAgents(result, false, formatLiteral);
    case "mcp":
      return formatConversationMcp(result, 0, formatLiteral);
    case "mcp-health":
      return formatConversationMcpHealth(result, false, formatLiteral);
    case "mcp-reload":
      return formatConversationMcpReload(result);
    case "mcp-detail":
      return formatConversationMcpDetail(result, false, formatLiteral);
    case "mcp-login":
      return formatConversationMcpLogin(result, formatLiteral);
    case "mcp-resource":
      return formatConversationMcpResource(result, formatLiteral);
    case "plugins":
      return formatConversationPlugins(result, false, formatLiteral);
    case "hooks":
      return formatConversationHooks(result.view);
    case "plugin-health":
      return formatConversationPluginHealth(result, formatLiteral);
    case "plugin-detail":
      return formatConversationPluginDetail(result, false, formatLiteral);
    case "usage":
      return formatConversationUsage(result);
    case "metrics":
      return formatConversationMetrics(result);
    case "reset-credit":
      return formatConversationResetCredits(result);
    case "limits":
      return formatConversationLimits(result);
    case "permissions":
      return formatConversationPermissions(result);
    case "artifacts":
      return formatConversationArtifacts(result);
    case "goal":
      return formatConversationGoal(result);
    case "occupancy":
      return formatConversationOccupancy(result, formatCommand);
  }
  return null;
}
