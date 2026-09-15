import {
  toConversationInputEvent,
  type RpcNotification,
} from "../src/codex-client/index.js";
import { ConversationCore } from "../src/conversation-core/core.js";

export function handleNotification(
  core: ConversationCore,
  notification: RpcNotification,
): void {
  const event = toConversationInputEvent(notification);
  if (event) {
    core.handle(event);
  }
}

export function breakdown(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: totalTokens - 500,
    cachedInputTokens: 500,
    cacheWriteInputTokens: 100,
    outputTokens: 400,
    reasoningOutputTokens: 50,
  };
}

export function usageBreakdown(
  outputTokens: number,
  reasoningOutputTokens: number,
) {
  return {
    totalTokens: outputTokens + 1_000,
    inputTokens: 1_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens,
  };
}
