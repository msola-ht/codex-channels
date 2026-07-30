import {
  type AccountRateLimits,
  type AccountUsage,
  type ConversationSession,
  type ConversationStatus,
  type ModelSelectionState,
} from "../../application/index.js";
import {
  formatSurfaceConfigurationChange,
  formatWorkspacesAdded as formatSharedWorkspacesAdded,
} from "../configuration-change-format.js";
import {
  createStartupPresentation,
  type LifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import {
  formatConversationLimits,
  formatConversationModels,
  formatConversationSessions,
  formatConversationStatus,
  formatConversationUsage,
} from "../conversation-command-format.js";
import type { Workspace } from "../../policy/index.js";
import type { SurfaceConfigurationChange } from "../types.js";

export function splitTelegramText(text: string, limit = 4_000): string[] {
  if (!text) {
    return [];
  }
  const chunks: string[] = [];
  let remaining = Array.from(text);
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("\n", limit);
    if (boundary < limit / 2) {
      boundary = limit;
    }
    chunks.push(remaining.slice(0, boundary).join(""));
    remaining = remaining.slice(boundary);
    if (remaining[0] === "\n") {
      remaining.shift();
    }
  }
  if (remaining.length > 0) {
    chunks.push(remaining.join(""));
  }
  return chunks;
}

export function formatSessions(
  threads: ConversationSession[],
  currentThreadId?: string,
  options: { archived?: boolean; searchTerm?: string } = {},
): string {
  return formatConversationSessions({
    kind: "sessions",
    sessions: threads,
    archived: options.archived ?? false,
    ...(currentThreadId ? { currentThreadId } : {}),
    ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
  });
}

export function formatModels(state: ModelSelectionState): string {
  return formatConversationModels({ kind: "models", view: "model", state });
}

export function formatReasoningEfforts(state: ModelSelectionState): string {
  return formatConversationModels({ kind: "models", view: "effort", state });
}

export function formatFastModeState(state: ModelSelectionState): string {
  return formatConversationModels({ kind: "models", view: "fast", state });
}

export function formatUsage(result: AccountUsage): string {
  return formatConversationUsage({ kind: "usage", result });
}

export function formatLimits(
  result: AccountRateLimits,
): string {
  return formatConversationLimits({ kind: "limits", result });
}

export function formatStatus(status: ConversationStatus): string {
  return formatConversationStatus(status);
}

export function formatWorkspacesAdded(workspaces: readonly Workspace[]): string {
  return formatSharedWorkspacesAdded(workspaces, true);
}

export function formatConfigurationChange(
  change: SurfaceConfigurationChange,
): string {
  return formatSurfaceConfigurationChange(change, "telegram", true);
}

export function formatStartupNotification(
  workspaces: Workspace[],
  status: Pick<ConversationStatus, "threadId" | "workspaceId" | "model" | "effort" | "serviceTier" | "modelPending" | "effortPending" | "fastModePending" | "collaborationMode" | "collaborationModePending" | "weeklyLimit" | "gitBranch">,
  runtime: StartupRuntimeInfo,
): string {
  return renderTelegramLifecyclePresentation(
    createStartupPresentation(workspaces, status, runtime),
  );
}

export function renderTelegramLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  return [
    presentation.title,
    ...(presentation.fields.length > 0
      ? ["", ...presentation.fields.map(formatLifecycleListField)]
      : []),
    ...(presentation.sections ?? []).flatMap((section) => [
      "",
      `${section.title}：`,
      ...section.fields.map(formatLifecycleListField),
    ]),
  ].join("\n");
}

export type StartupRuntimeInfo = LifecycleStartupRuntimeInfo;

function formatLifecycleListField(
  field: LifecyclePresentation["fields"][number],
): string {
  return `- ${field.label}：${field.value}`;
}
