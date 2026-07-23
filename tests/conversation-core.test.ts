import pino from "pino";
import { describe, expect, it } from "vitest";

import { ConversationCore } from "../src/conversation-core/core.js";
import {
  gatewayUserMessageClientIdPrefix,
  type OutputEvent,
} from "../src/conversation-core/events.js";
import { EventBus } from "../src/event-bus/event-bus.js";
import type { ConversationRoutingPort } from "../src/conversation-core/routing-port.js";

describe("ConversationCore", () => {
  it("reduces thread token usage notifications for status rendering", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const router = {
      allBindings: () => [],
      targetForThread: () => undefined,
      modelSettingsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
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

  it("attaches only the completed turn's context usage to its output event", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, conversationId: "100" };
    const router = {
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => ({ model: "gpt-main", effort: "high" }),
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);

    core.handle({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: breakdown(20_000),
          last: breakdown(12_500),
          modelContextWindow: 200_000,
        },
      },
    });
    core.handle({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });
    core.handle({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-2", status: "completed", error: null },
      },
    });
    await output.close();

    const completions = events.filter((event) => event.type === "turn.completed");
    expect(completions[0]).toMatchObject({
      turnId: "turn-1",
      model: "gpt-main",
      effort: "high",
      tokenUsage: {
        last: { totalTokens: 12_500 },
        modelContextWindow: 200_000,
      },
    });
    expect(completions[1]).not.toHaveProperty("tokenUsage");
  });

  it("publishes external turn input once and tracks the external active turn", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, conversationId: "100" };
    const router = {
      allBindings: () => [],
      targetForThread: (threadId: string) => threadId === "thread-1" ? target : undefined,
      modelSettingsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);

    core.handle({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    const userMessage = {
      type: "userMessage",
      id: "item-1",
      clientId: "codex_cli:1",
      content: [{ type: "text", text: "从 CLI 发来的输入" }],
    };
    core.handle({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: userMessage },
    });
    core.handle({
      method: "item/completed",
      params: { threadId: "thread-1", turnId: "turn-1", item: userMessage },
    });
    await output.close();

    expect(core.activeTurn(target)?.turnId).toBe("turn-1");
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "user.message")).toEqual([
      {
        type: "user.message",
        target,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        text: "从 CLI 发来的输入",
      },
    ]);
  });

  it("does not echo Gateway-originated Telegram input", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, conversationId: "100" };
    const router = {
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);

    core.handle({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "userMessage",
          id: "item-local",
          clientId: `${gatewayUserMessageClientIdPrefix}request-1`,
          content: [{ type: "text", text: "TG 已经显示的输入" }],
        },
      },
    });
    await output.close();

    expect(events.some((event) => event.type === "user.message")).toBe(false);
  });

  it("propagates agent message phases and emits a disconnect event for cleanup", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, conversationId: "100" };
    const router = {
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);

    core.handle({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "agent-1", text: "", phase: "commentary" },
      },
    });
    core.handle({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "检查中" },
    });
    core.handle({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "agent-1", text: "检查完成", phase: "commentary" },
      },
    });
    core.connectionLost("连接已断开");
    await output.close();

    expect(events).toContainEqual(expect.objectContaining({
      type: "text.delta",
      phase: "commentary",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "text.completed",
      phase: "commentary",
    }));
    expect(events).toContainEqual({
      type: "connection.lost",
      target,
      threadId: "thread-1",
      message: "连接已断开",
    });
  });

  it("publishes sanitized operation snapshots for command and file items", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, conversationId: "100" };
    const router = {
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);
    const startedCommand = {
      type: "commandExecution",
      id: "command-1",
      command: "TELEGRAM_BOT_TOKEN=super-secret git status --short",
      status: "inProgress",
      durationMs: null,
      exitCode: null,
    };

    core.handle({
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: startedCommand },
    });
    core.handle({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { ...startedCommand, status: "completed", durationMs: 125, exitCode: 0 },
      },
    });
    core.handle({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "file-1",
          status: "completed",
          changes: [
            { path: "src/main.ts" },
            { path: "README.md" },
          ],
        },
      },
    });
    await output.close();

    const operations = events.filter((event) => event.type === "operation.updated");
    expect(operations).toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({
          itemId: "command-1",
          status: "running",
          detail: "TELEGRAM_BOT_TOKEN=[REDACTED] git status --short",
        }),
      }),
      expect.objectContaining({
        operation: expect.objectContaining({
          itemId: "command-1",
          status: "completed",
          durationMs: 125,
          exitCode: 0,
        }),
      }),
      expect.objectContaining({
        operation: expect.objectContaining({
          itemId: "file-1",
          kind: "fileChange",
          detail: "src/main.ts、README.md",
        }),
      }),
    ]);
    expect(JSON.stringify(operations)).not.toContain("super-secret");
  });

  it("keeps the latest turn diff and plan in ephemeral core state", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => undefined,
      modelSettingsForThread: () => undefined,
    }, output);

    core.handle({
      method: "turn/diff/updated",
      params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/a b/a" },
    });
    core.handle({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "实施计划",
        plan: [
          { step: "检查", status: "completed" },
          { step: "修改", status: "inProgress" },
        ],
      },
    });

    expect(core.artifacts("thread-1")).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      diff: "diff --git a/a b/a",
      plan: {
        explanation: "实施计划",
        steps: [
          { step: "检查", status: "completed" },
          { step: "修改", status: "inProgress" },
        ],
      },
    });

    core.markTurnStarted(
      { surface: "telegram", conversationId: "100" },
      "thread-1",
      "turn-2",
    );
    expect(core.artifacts("thread-1")).toEqual({
      threadId: "thread-1",
      turnId: "turn-2",
    });
    await output.close();
  });

  it("merges sparse rate-limit updates and broadcasts threshold crossings once", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
    }, output);

    core.handle({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex 5 小时",
          planType: "pro",
          primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 2_000_000_000 },
        },
      },
    });
    core.handle({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          planType: null,
          primary: null,
        },
      },
    });
    core.handle({
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex", primary: { usedPercent: 50 } } },
    });
    core.handle({
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex", primary: { usedPercent: 91 } } },
    });
    core.handle({
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "thread-1",
        name: "docs",
        status: "ready",
        error: null,
        failureReason: null,
      },
    });
    await output.close();

    const limitEvents = events.filter((event) => event.type === "account.rateLimits.updated");
    expect(limitEvents).toHaveLength(2);
    expect(limitEvents.at(-1)).toMatchObject({
      rateLimits: {
        limitName: "Codex 5 小时",
        planType: "pro",
        primary: { windowDurationMins: 300, resetsAt: 2_000_000_000 },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "mcp.status.updated",
      target,
      name: "docs",
      status: "ready",
    }));
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
