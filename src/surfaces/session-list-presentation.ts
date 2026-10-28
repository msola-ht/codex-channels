import type { ConversationCommandResult } from "../application/index.js";

export function createSessionListPresentation(
  result: Extract<ConversationCommandResult, { kind: "sessions" }>,
) {
  const backgroundThreadIds = new Set(result.backgroundThreadIds ?? []);
  return result.sessions.map((session, index) => ({
    session,
    selector: session.selector ?? index + 1,
    isCurrent: session.id === result.currentThreadId,
    isBackground: backgroundThreadIds.has(session.id),
  }));
}
