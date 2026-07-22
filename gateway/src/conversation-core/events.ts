import type { MessagePhase } from "../codex-protocol/index.js";

export interface ConversationTarget {
  surface: "telegram";
  conversationId: string;
}

export const gatewayUserMessageClientIdPrefix = "codex_tg_gateway:";

export type OutputEvent =
  | { type: "turn.started"; target: ConversationTarget; threadId: string; turnId: string }
  | { type: "user.message"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "text.delta"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string; phase?: MessagePhase | null }
  | { type: "text.completed"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string; phase?: MessagePhase | null }
  | { type: "turn.completed"; target: ConversationTarget; threadId: string; turnId: string; status: string; error?: string }
  | { type: "thread.status"; target: ConversationTarget; threadId: string; status: string }
  | { type: "connection.lost"; target: ConversationTarget; threadId: string; message: string }
  | { type: "warning"; target: ConversationTarget; threadId?: string; message: string };

export function isCriticalOutputEvent(event: OutputEvent): boolean {
  return event.type !== "text.delta" && event.type !== "turn.started";
}
