import pino from "pino";
import { describe, expect, it } from "vitest";

import { ConversationCore } from "../src/conversation-core/core.js";
import type { OutputEvent } from "../src/conversation-core/events.js";
import { EventBus } from "../src/event-bus/event-bus.js";
import type { SessionRouter } from "../src/session-routing/router.js";

describe("ConversationCore", () => {
  it("reduces thread token usage notifications for status rendering", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const router = {
      allBindings: () => [],
      targetForThread: () => undefined,
      forgetThread: () => undefined,
    } as unknown as SessionRouter;
    const core = new ConversationCore(router, output);

    core.handle({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: breakdown(20_000),
          last: breakdown(2_000),
          modelContextWindow: 200_000,
        },
      },
    });

    expect(core.tokenUsage("thread-1")).toEqual({
      total: breakdown(20_000),
      last: breakdown(2_000),
      modelContextWindow: 200_000,
    });
    await output.close();
  });
});

function breakdown(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: totalTokens - 500,
    cachedInputTokens: 500,
    cacheWriteInputTokens: 100,
    outputTokens: 400,
    reasoningOutputTokens: 50,
  };
}
