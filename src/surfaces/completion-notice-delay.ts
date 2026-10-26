import { setTimeout as delay } from "node:timers/promises";

/** Call inside the conversation queue after body/stream settlement, immediately
 * before a visible completion notice. Platform ACKs do not prove client render
 * completion; this is only a display buffer, not another delivery receipt. */
export async function waitForCompletionNotice(signal: AbortSignal): Promise<void> {
  await delay(2_000, undefined, { signal });
}
