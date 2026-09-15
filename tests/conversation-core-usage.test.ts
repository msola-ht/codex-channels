import pino from "pino";
import { describe, expect, it } from "vitest";

import { ConversationCore } from "../src/conversation-core/core.js";
import type { OutputEvent } from "../src/conversation-core/events.js";
import { EventBus } from "../src/event-bus/event-bus.js";
import {
  handleNotification,
  usageBreakdown,
} from "./conversation-core-test-fixture.js";

describe("ConversationCore usage", () => {
  it("uses only the main Codex seven-day window as the weekly limit", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => undefined,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    core.rememberRateLimits([{
      limitId: "code_review",
      limitName: "Code Review",
      primary: null,
      secondary: { usedPercent: 88, windowDurationMins: 10_080, resetsAt: null },
      credits: null,
      individualLimit: null,
      spendControlReached: false,
      planType: "pro",
      rateLimitReachedType: null,
    }]);
    expect(core.weeklyRateLimit()).toBeUndefined();

    core.rememberRateLimits([{
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 2_000_000_000 },
      credits: null,
      individualLimit: null,
      spendControlReached: false,
      planType: "pro",
      rateLimitReachedType: null,
    }]);
    expect(core.weeklyRateLimit()).toEqual({
      usedPercent: 42,
      windowDurationMins: 10_080,
      resetsAt: 2_000_000_000,
    });
    await output.close();
  });

  it("aggregates request outcomes, Token usage and compaction without delta timing", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = {
      surface: "telegram" as const,
      accountId: "default",
      conversationId: "100",
    };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => ({
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
        effort: "high",
        serviceTier: null,
      }),
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-0",
        tokenUsage: {
          total: usageBreakdown(100, 0),
          last: usageBreakdown(100, 0),
          modelContextWindow: 200_000,
        },
      },
    });
    handleNotification(core, {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    handleNotification(core, {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "commentary-1",
          text: "",
          phase: "commentary",
        },
      },
    });
    handleNotification(core, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "commentary-1",
        delta: "思考",
      },
    });
    handleNotification(core, {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "final-1",
          text: "",
          phase: "final_answer",
        },
      },
    });
    handleNotification(core, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "final-1",
        delta: "A",
      },
    });
    handleNotification(core, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "final-1",
        delta: "B",
      },
    });
    handleNotification(core, {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "final-2",
          text: "",
          phase: "final_answer",
        },
      },
    });
    handleNotification(core, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "final-2",
        delta: "C",
      },
    });
    handleNotification(core, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "final-2",
        delta: "D",
      },
    });
    handleNotification(core, {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "final-1",
          text: "AB",
          phase: "final_answer",
        },
      },
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningOutputTokens: 10,
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      operation: "compact",
      model: "gpt-5.6-sol",
      inputTokens: 200,
      cachedInputTokens: 160,
      outputTokens: 60,
      reasoningOutputTokens: 40,
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      outcome: "interrupted",
      outputTokens: 50,
      reasoningOutputTokens: 0,
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      outcome: "incomplete",
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      outcome: "failed",
      retryableFailure: true,
    });
    handleNotification(core, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: usageBreakdown(160, 40),
          last: usageBreakdown(60, 40),
          modelContextWindow: 200_000,
        },
      },
    });
    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          error: null,
          durationMs: 5_000,
        },
      },
    });

    await output.close();
    const completed = events.find(
      (event) => event.type === "turn.completed",
    ) as Extract<OutputEvent, { type: "turn.completed" }> | undefined;
    expect(completed).toMatchObject({
      durationMs: 5_000,
    });
    expect(completed?.timing).toEqual({
      modelRequestCount: 5,
      completedModelRequestCount: 2,
      interruptedModelRequestCount: 1,
      incompleteModelRequestCount: 1,
      failedModelRequestCount: 1,
      retryableFailureModelRequestCount: 1,
      reasoningRequestCount: 2,
      requestInputTokens: 300,
      requestCachedInputTokens: 240,
      requestOutputTokens: 140,
      nonReasoningOutputTokens: 90,
      reasoningTokens: 50,
      compact: {
        model: "gpt-5.6-sol",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 200,
        cachedInputTokens: 160,
        outputTokens: 60,
      },
    });
  });

  it("keeps the reasoning token count but omits timing-stream fields for OpenAI", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = {
      surface: "telegram" as const,
      accountId: "default",
      conversationId: "100",
    };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => ({
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        effort: "medium",
        serviceTier: null,
      }),
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "turn/started",
      params: { threadId: "thread-openai", turn: { id: "turn-openai" } },
    });
    handleNotification(core, {
      method: "item/started",
      params: {
        threadId: "thread-openai",
        turnId: "turn-openai",
        item: {
          type: "agentMessage",
          id: "final-openai",
          text: "",
          phase: "final_answer",
        },
      },
    });
    for (const delta of ["A", "B"]) {
      handleNotification(core, {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-openai",
          turnId: "turn-openai",
          itemId: "final-openai",
          delta,
        },
      });
    }
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-openai",
      turnId: "turn-openai",
      outputTokens: 30,
      reasoningOutputTokens: 10,
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-openai",
      turnId: "turn-openai",
      outputTokens: 60,
      reasoningOutputTokens: 40,
    });
    handleNotification(core, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-openai",
        turnId: "turn-openai",
        tokenUsage: {
          total: usageBreakdown(320, 200),
          last: usageBreakdown(60, 40),
          modelContextWindow: 200_000,
        },
      },
    });
    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-openai",
        turn: {
          id: "turn-openai",
          status: "completed",
          error: null,
        },
      },
    });

    await output.close();
    const completed = events.find(
      (event) => event.type === "turn.completed",
    ) as Extract<OutputEvent, { type: "turn.completed" }> | undefined;
    expect(completed?.timing).toEqual({
      modelRequestCount: 2,
      reasoningRequestCount: 2,
      requestOutputTokens: 90,
      nonReasoningOutputTokens: 40,
      reasoningTokens: 50,
    });
  });

  it("keeps request and Token facts for OpenCode Go completions", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = {
      surface: "telegram" as const,
      accountId: "default",
      conversationId: "100",
    };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => ({
        model: "deepseek-v4-flash",
        modelProvider: "ocg-main",
        effort: "high",
        serviceTier: null,
      }),
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "turn/started",
      params: { threadId: "thread-og", turn: { id: "turn-og" } },
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-og",
      turnId: "turn-og",
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 40,
      reasoningOutputTokens: 20,
    });
    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-og",
        turn: {
          id: "turn-og",
          status: "completed",
          error: null,
          durationMs: 3_000,
        },
      },
    });

    await output.close();
    const completed = events.find(
      (event) => event.type === "turn.completed",
    ) as Extract<OutputEvent, { type: "turn.completed" }> | undefined;
    expect(completed?.timing).toEqual({
      modelRequestCount: 1,
      reasoningRequestCount: 1,
      requestInputTokens: 100,
      requestCachedInputTokens: 80,
      requestOutputTokens: 40,
      nonReasoningOutputTokens: 20,
      reasoningTokens: 20,
    });
  });

  it.each(["turn-1", "previous-turn"])(
    "uses only current Turn token usage without proxy requests or text timing (%s)",
    async (usageTurnId) => {
      const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
      const events: OutputEvent[] = [];
      output.subscribe("test", (event) => { events.push(event); });
      const target = {
        surface: "telegram" as const,
        accountId: "default",
        conversationId: "100",
      };
      const core = new ConversationCore({
        allBindings: () => [],
        targetForThread: () => target,
        modelSettingsForThread: () => undefined,
        contextCompactionItemIdsForThread: () => undefined,
      }, output);

      core.handle({ type: "turn.started", threadId: "thread-1", turnId: "turn-1" });
      core.handle({
        type: "thread.tokenUsage.updated",
        threadId: "thread-1",
        turnId: usageTurnId,
        tokenUsage: {
          total: usageBreakdown(320, 200),
          last: usageBreakdown(60, 40),
          modelContextWindow: 200_000,
        },
      });
      core.handle({
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        error: null,
      });

      await output.close();
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.timing).toEqual(usageTurnId === "turn-1"
        ? { nonReasoningOutputTokens: 20, reasoningTokens: 40 }
        : undefined);
    },
  );
});
