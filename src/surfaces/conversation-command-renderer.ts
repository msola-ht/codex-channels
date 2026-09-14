import type { ConversationCommandResult } from "../application/index.js";

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
  formatConversationCollaborationMode,
  formatConversationGoal,
  formatConversationPermissions,
  formatConversationProjectRules,
  formatConversationStatus,
  formatConversationWorkspacePermissions,
  formatConversationWorkspaces,
} from "./conversation-workspace-status-command-format.js";
import { formatConversationCommandOutcome } from "./conversation-command-outcome-format.js";
import { formatConversationMetrics } from "./metrics-format.js";

export function renderConversationCommandResult(
  result: ConversationCommandResult,
): string | null {
  switch (result.kind) {
    case "outcome":
      if (isTurnLifecycleAcknowledgedOutcome(result.outcome)) {
        return null;
      }
      return formatConversationCommandOutcome(result.outcome);
    case "sessions":
      return formatConversationSessions(result);
    case "thread-queue":
      return formatConversationThreadQueue(result);
    case "thread-revert":
      return formatConversationThreadRevert(result);
    case "thread-revert-preview":
      return formatConversationThreadRevertPreview(result);
    case "scheduled-tasks":
      return formatConversationScheduledTasks(result);
    case "scheduled-runs":
      return formatConversationScheduledRuns(result);
    case "scheduled-confirmation":
      return formatConversationScheduledConfirmation(result);
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
    case "plugin-health":
      return formatConversationPluginHealth(result);
    case "plugin-detail":
      return formatConversationPluginDetail(result);
    case "usage":
      return formatConversationUsage(result);
    case "metrics":
      return formatConversationMetrics(result);
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
    case "occupancy":
      return formatConversationOccupancy(result);
  }
  return null;
}
