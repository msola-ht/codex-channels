import type { ConversationStatus } from "../../application/index.js";
import type { OutputEvent } from "../../conversation-core/index.js";
import {
  createStartupPresentation, createTurnCompletedPresentation,
  renderStructuredLifecyclePresentation, type StartupRuntimeInfo,
} from "../lifecycle-presentation.js";

export function renderQqStartupNotification(
  workspaces: ReadonlyArray<{ id: string; name: string; cwd: string }>,
  status: ConversationStatus,
  runtime: StartupRuntimeInfo,
): string {
  return renderStructuredLifecyclePresentation(createStartupPresentation(workspaces, status, runtime));
}

export function renderQqTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
  debug = false,
  autoCompactPercent?: (provider: string | null | undefined, model: string | null | undefined) => number | null,
): string {
  return renderStructuredLifecyclePresentation(createTurnCompletedPresentation(event, debug, autoCompactPercent));
}
