import {
  type ConversationStatus,
} from "../../application/index.js";
import type { OutputEvent } from "../../conversation-core/index.js";
import {
  formatSurfaceConfigurationChange,
  formatWorkspacesAdded as formatSharedWorkspacesAdded,
} from "../configuration-change-format.js";
import {
  createStartupPresentation,
  createSubagentCompletedPresentation,
  renderStructuredLifecyclePresentation,
  type LifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import { formatConversationStatus } from "../conversation-workspace-status-command-format.js";
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

export function formatIdleReleaseNotification(minutes: number, threadId: string): string {
  return [
    "## 会话已自动解除占用",
    "",
    `${minutes} 分钟内没有输入或输出。`,
    "",
    "### 恢复会话",
    `/r ${threadId}`,
    "",
    "直接发送消息将开始新会话。",
  ].join("\n");
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
  status: Pick<ConversationStatus, "threadId" | "threadName" | "workspaceId" | "model" | "modelProvider" | "effort" | "serviceTier" | "modelPending" | "effortPending" | "fastModePending" | "collaborationMode" | "collaborationModePending" | "weeklyLimit" | "gitBranch">,
  runtime: StartupRuntimeInfo,
): string {
  return renderTelegramLifecyclePresentation(
    createStartupPresentation(workspaces, status, runtime),
  );
}

export function renderTelegramLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  const { footer, ...rest } = presentation;
  // sendPanel performs HTML escaping; Markdown escapes would become visible text.
  const body = renderStructuredLifecyclePresentation(rest, false);
  return footer === undefined
    ? body
    : `${body}\n\n${footer.label}：${footer.value}`;
}

export function renderTelegramSubagentCompleted(
  event: Extract<OutputEvent, { type: "subagent.completed" }>,
  debug = false,
): string {
  return renderTelegramLifecyclePresentation(
    createSubagentCompletedPresentation(event, debug),
  );
}

export type StartupRuntimeInfo = LifecycleStartupRuntimeInfo;
