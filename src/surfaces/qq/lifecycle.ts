import type { ConversationStatus } from "../../application/index.js";
import type { OutputEvent } from "../../conversation-core/index.js";
import {
  createStartupPresentation, createTurnStartedPresentation, createTurnCompletedPresentation,
  createHookCompletedPresentation, createAutoApprovalReviewPresentation,
  renderStructuredLifecyclePresentation, renderPlainLifecyclePresentation, type StartupRuntimeInfo, type PresentationDetail,
} from "../lifecycle-presentation.js";
import { ContextCompactionNotices } from "../operation-presentation.js";
import { formatCodexWarning, formatConnectionLost, formatConnectionRestored,
  formatConversationIdleReleased, formatThreadAvailability, visibleUpstreamMessage } from "../output-copy.js";
import { formatRuntimeAccountUpdate, formatRuntimeRateLimitUpdate, formatRuntimeMcpStatusUpdate,
  formatRuntimeMcpOAuthCompleted } from "../runtime-status-format.js";
import type { SurfaceNotificationDeliverySource } from "../types.js";

export type QqLifecycleNotification = Extract<OutputEvent, { type: SurfaceNotificationDeliverySource["eventType"] }>;

export function isQqLifecycleNotification(event: OutputEvent): event is QqLifecycleNotification {
  return event.type === "mcp.oauth.completed" || event.type === "conversation.idle.released" || event.type === "warning"
    || event.type === "hook.completed" || event.type === "autoApprovalReview.updated" || event.type === "operation.updated"
    || event.type === "connection.lost" || event.type === "connection.restored" || event.type === "thread.availability"
    || event.type === "thread.name" || event.type === "account.updated" || event.type === "account.rateLimits.updated"
    || event.type === "mcp.status.updated";
}

/** Presentation state only; admission and delivery authority remain in QqMessages. */
export class QqLifecycleNotifications {
  private readonly compaction = new ContextCompactionNotices();

  render(event: QqLifecycleNotification, retained = false, detailed: PresentationDetail = "detailed"): string | null {
    switch (event.type) {
      case "conversation.idle.released": return formatConversationIdleReleased(event.minutes, event.threadId);
      case "warning": return formatCodexWarning(visibleUpstreamMessage(event.message));
      case "connection.lost": return formatConnectionLost(visibleUpstreamMessage(event.message));
      case "connection.restored": return formatConnectionRestored(visibleUpstreamMessage(event.message));
      case "thread.availability": return formatThreadAvailability(event.availability, event.threadId, event.background);
      case "thread.name": return `Session 名称已更新：${event.name ?? "未命名"}`;
      case "account.updated": return formatRuntimeAccountUpdate(event.authMode, event.planType);
      case "account.rateLimits.updated": return formatRuntimeRateLimitUpdate(event.rateLimits);
      case "mcp.status.updated": return formatRuntimeMcpStatusUpdate(event);
      case "mcp.oauth.completed": return formatRuntimeMcpOAuthCompleted(event);
      case "hook.completed": return renderStructuredLifecyclePresentation(createHookCompletedPresentation(event));
      case "autoApprovalReview.updated": {
        const presentation = createAutoApprovalReviewPresentation(event, detailed);
        return presentation ? renderStructuredLifecyclePresentation(presentation) : null;
      }
      case "operation.updated": return this.compaction.accept(event, retained);
    }
  }
}

export function renderQqStartupNotification(
  workspaces: ReadonlyArray<{ id: string; name: string; cwd: string }>,
  status: ConversationStatus,
  runtime: StartupRuntimeInfo,
): string {
  return renderStructuredLifecyclePresentation(createStartupPresentation(workspaces, status, runtime));
}

export function renderQqTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
  detailed: PresentationDetail = "basic",
  mode: "brief" | "detailed" = "detailed",
): { text: string; markdown: string } {
  const presentation = createTurnCompletedPresentation(event, detailed, mode);
  return { text: renderPlainLifecyclePresentation(presentation), markdown: renderStructuredLifecyclePresentation(presentation) };
}

export function renderQqTurnStarted(
  event: Extract<OutputEvent, { type: "turn.started" }>,
): { text: string; markdown: string } {
  const presentation = { ...createTurnStartedPresentation(
    event.background ? event.threadId : undefined, event.identity, event.approvalsReviewer,
  ), titleStyle: "emphasis" as const };
  return { text: renderPlainLifecyclePresentation(presentation), markdown: renderStructuredLifecyclePresentation(presentation) };
}
