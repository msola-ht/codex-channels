import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  toConversationInputEvent,
  type RpcNotification,
} from "../src/codex-client/index.js";
import { ConversationCore } from "../src/conversation-core/core.js";
import {
  gatewayUserMessageClientIdPrefix,
  type OutputEvent,
} from "../src/conversation-core/events.js";
import { EventBus } from "../src/event-bus/event-bus.js";
import type { ConversationRoutingPort } from "../src/conversation-core/routing-port.js";

describe("ConversationCore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks foreground and background Turns independently", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    let foregroundThreadId = "thread-1";
    const background = new Set<string>();
    const core = new ConversationCore({
      allBindings: () => [],
      foregroundThreadId: () => foregroundThreadId,
      isBackgroundThread: (threadId) => background.has(threadId),
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);
    core.markTurnStarted(target, "thread-1", "turn-1");
    background.add("thread-1");
    foregroundThreadId = "thread-2";
    core.markTurnStarted(target, "thread-2", "turn-2");

    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });
    await output.close();

    expect(core.activeTurn(target)?.threadId).toBe("thread-2");
    expect(core.activeTurnForThread("thread-1")).toBeUndefined();
    expect(events.find(
      (event) => event.type === "turn.completed" && event.threadId === "thread-1",
    )).toMatchObject({ background: true, target });
  });

  it("shows one thinking status per reasoning segment and resumes after operations", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [],
      foregroundThreadId: () => "thread-1",
      isBackgroundThread: () => false,
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    const reasoningDelta = (): void => handleNotification(core, {
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-r1",
        contentIndex: 0,
        delta: "x",
      },
    });
    reasoningDelta();
    reasoningDelta();
    reasoningDelta();
    const commandItem = {
      type: "commandExecution",
      id: "cmd-1",
      command: "git status --short",
      status: "inProgress",
      durationMs: null,
      exitCode: null,
    };
    handleNotification(core, {
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: commandItem },
    });
    handleNotification(core, {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { ...commandItem, status: "completed", durationMs: 125, exitCode: 0 },
      },
    });
    reasoningDelta();
    reasoningDelta();
    handleNotification(core, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-a1",
        delta: "OK",
      },
    });
    await output.close();

    const reasoning = events.filter((event) => event.type === "turn.reasoning");
    const starts = reasoning.filter((event) => event.final !== true);
    const finals = reasoning.filter((event) => event.final === true);
    expect(starts).toHaveLength(2);
    expect(finals).toHaveLength(2);
    expect(starts[0]).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      target,
    });
    expect(starts[0]!.elapsedMs).toBeLessThan(1_000);
    expect(starts[1]).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      target,
    });
    expect(starts[1]!.elapsedMs).toBeLessThan(1_000);
    expect(finals[0]).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      final: true,
      target,
    });
    expect(finals[0]!.elapsedMs).toBeGreaterThanOrEqual(
      starts[0]!.elapsedMs,
    );
    expect(finals[1]).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      final: true,
      target,
    });
    expect(finals[1]!.elapsedMs).toBeGreaterThanOrEqual(
      starts[1]!.elapsedMs,
    );
    expect(events.some((event) => event.type === "operation.updated")).toBe(true);
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
  });

  it("streams the thinking elapsed time every second and stops after the segment ends", async () => {
    vi.useFakeTimers();
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "feishu" as const, accountId: "cli_app", conversationId: "oc_chat" };
    const core = new ConversationCore({
      allBindings: () => [],
      foregroundThreadId: () => "thread-1",
      isBackgroundThread: () => false,
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    handleNotification(core, {
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-r1",
        contentIndex: 0,
        delta: "x",
      },
    });
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(2_000);
    handleNotification(core, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-a1",
        delta: "OK",
      },
    });
    vi.advanceTimersByTime(5_000);
    await output.close();

    const reasoning = events.filter((event) => event.type === "turn.reasoning");
    expect(reasoning.map((event) => event.elapsedMs)).toEqual([
      0,
      1_000,
      2_000,
      3_000,
      3_000,
    ]);
    expect(reasoning[4]).toMatchObject({ final: true });
  });

  it("stops stale thinking updates when a new Turn starts on the same Thread", async () => {
    vi.useFakeTimers();
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "feishu" as const, accountId: "cli_app", conversationId: "oc_chat" };
    const core = new ConversationCore({
      allBindings: () => [],
      foregroundThreadId: () => "thread-1",
      isBackgroundThread: () => false,
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    handleNotification(core, {
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-r1",
        contentIndex: 0,
        delta: "x",
      },
    });
    vi.advanceTimersByTime(1_000);
    handleNotification(core, {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2" } },
    });
    vi.advanceTimersByTime(5_000);
    await output.close();

    const reasoning = events.filter((event) => event.type === "turn.reasoning");
    expect(reasoning.map((event) => event.elapsedMs)).toEqual([0, 1_000, 1_000]);
    expect(reasoning.at(-1)).toMatchObject({
      turnId: "turn-1",
      final: true,
    });
  });

  it("reduces thread token usage notifications for status rendering", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const router = {
      allBindings: () => [],
      targetForThread: () => undefined,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);

    handleNotification(core, {
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

  it("reduces Goal notifications and attaches the current Goal to turn completion", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "thread/goal/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        goal: {
          threadId: "thread-1",
          objective: "完成 Gateway",
          status: "active",
          tokenBudget: 100_000,
          tokensUsed: 12_500,
          timeUsedSeconds: 90,
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      },
    });
    expect(core.goal("thread-1")).toMatchObject({
      objective: "完成 Gateway",
      status: "active",
      tokensUsed: 12_500,
    });

    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          error: null,
          durationMs: 65_432,
        },
      },
    });
    await output.close();
    expect(events.find((event) => event.type === "turn.completed"))
      .toHaveProperty("goal.status", "active");
    expect(events.find((event) => event.type === "turn.completed"))
      .toHaveProperty("durationMs", 65_432);

    handleNotification(core, {
      method: "thread/goal/cleared",
      params: { threadId: "thread-1" },
    });
    expect(core.goal("thread-1")).toBeUndefined();
  });

  it("attaches only the completed turn's context usage to its output event", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const router = {
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => ({
        model: "gpt-main",
        modelProvider: "openai",
        effort: "high",
        serviceTier: "fast",
      }),
      contextCompactionItemIdsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);
    core.rememberRateLimits([{
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: null },
      credits: null,
      individualLimit: null,
      spendControlReached: false,
      planType: "pro",
      rateLimitReachedType: null,
    }]);

    handleNotification(core, {
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
    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });
    handleNotification(core, {
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
      modelProvider: "openai",
      effort: "high",
      serviceTier: "fast",
      weeklyLimit: {
        usedPercent: 42,
        windowDurationMins: 10_080,
        resetsAt: null,
      },
      tokenUsage: {
        last: { totalTokens: 12_500 },
        modelContextWindow: 200_000,
      },
    });
    expect(completions[1]).not.toHaveProperty("tokenUsage");
  });

  it("does not attach OpenAI account limits to a third-party Provider completion", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
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
    core.rememberRateLimits([{
      limitId: "codex",
      limitName: "Codex",
      primary: null,
      secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: null },
      credits: null,
      individualLimit: null,
      spendControlReached: false,
      planType: "pro",
      rateLimitReachedType: null,
    }]);

    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-deepseek",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });
    await output.close();

    const completion = events.find((event) => event.type === "turn.completed");
    expect(completion).toMatchObject({ modelProvider: "deepseek" });
    expect(completion).not.toHaveProperty("weeklyLimit");
  });

  it("restores and deduplicates completed context compactions for thread status", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => ["compact-history"],
    }, output);

    const completedCompaction = {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "contextCompaction", id: "compact-live" },
      },
    } satisfies RpcNotification;
    handleNotification(core, completedCompaction);
    handleNotification(core, completedCompaction);
    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });
    await output.close();

    expect(core.contextCompactionCount("thread-1")).toBe(2);
    expect(events.find((event) => event.type === "turn.completed"))
      .toHaveProperty("contextCompactionCount", 2);
  });

  it("publishes subagent spawn activity for a bound parent thread", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          id: "item-1",
          kind: "started",
          agentThreadId: "subagent-thread-1",
          agentPath: "/root/ds_probe",
        },
      },
    });
    await output.close();

    expect(events).toContainEqual(expect.objectContaining({
      type: "subagent.spawned",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      agentThreadId: "subagent-thread-1",
      agentPath: "/root/ds_probe",
    }));
  });

  it("does not present follow-up or interruption activity as a new subagent", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    for (const kind of ["interacted", "interrupted"] as const) {
      core.handle({
        type: "item.subagentActivity",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: `item-${kind}`,
        kind,
        agentThreadId: "subagent-thread-1",
        agentPath: "/root/ds_probe",
      });
    }
    await output.close();

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "subagent.spawned",
    }));
  });

  it("does not invent a successful completion for a malformed turn status", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", error: null },
      },
    });
    await output.close();

    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
  });

  it("does not carry a transient retried error into a successful turn completion", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: true,
        error: { message: "暂时失败，稍后重试" },
      },
    });
    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });
    await output.close();

    expect(events.find((event) => event.type === "turn.completed"))
      .not.toHaveProperty("error");
  });

  it("publishes external turn input once and tracks the external active turn", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const router = {
      allBindings: () => [],
      targetForThread: (threadId: string) => threadId === "thread-1" ? target : undefined,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);

    handleNotification(core, {
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    const userMessage = {
      type: "userMessage",
      id: "item-1",
      clientId: "codex_cli:1",
      content: [{ type: "text", text: "从 CLI 发来的输入" }],
    };
    handleNotification(core, {
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: userMessage },
    });
    handleNotification(core, {
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
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const router = {
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);

    handleNotification(core, {
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
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const router = {
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);

    handleNotification(core, {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "agent-1", text: "", phase: "commentary" },
      },
    });
    handleNotification(core, {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "检查中" },
    });
    handleNotification(core, {
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

  it("isolates a Provider connection loss to its affected Threads", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const openaiTarget = {
      surface: "telegram" as const,
      accountId: "default",
      conversationId: "openai",
    };
    const deepseekTarget = {
      surface: "feishu" as const,
      accountId: "default",
      conversationId: "deepseek",
    };
    const core = new ConversationCore({
      allBindings: () => [
        { target: openaiTarget, threadId: "thread-openai" },
        { target: deepseekTarget, threadId: "thread-deepseek" },
      ],
      targetForThread: () => undefined,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);
    core.markTurnStarted(openaiTarget, "thread-openai", "turn-openai");
    core.markTurnStarted(deepseekTarget, "thread-deepseek", "turn-deepseek");

    core.connectionLost("DeepSeek 连接已断开", new Set(["thread-deepseek"]));
    await output.close();

    expect(core.activeTurn(openaiTarget)?.turnId).toBe("turn-openai");
    expect(core.activeTurn(deepseekTarget)).toBeUndefined();
    expect(events.filter((event) => event.type === "connection.lost")).toEqual([{
      type: "connection.lost",
      target: deepseekTarget,
      threadId: "thread-deepseek",
      message: "DeepSeek 连接已断开",
    }]);
  });

  it("publishes a connection restore notice without clearing active state", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const router = {
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    } satisfies ConversationRoutingPort;
    const core = new ConversationCore(router, output);
    core.markTurnStarted(target, "thread-1", "turn-1");

    core.connectionRestored("openai App Server 已重新连接");
    await output.close();

    expect(core.activeTurn(target)?.turnId).toBe("turn-1");
    expect(events.filter((event) => event.type === "connection.restored")).toEqual([{
      type: "connection.restored",
      target,
      threadId: "thread-1",
      message: "openai App Server 已重新连接",
    }]);
  });

  it("isolates a connection restore notice to its affected Threads", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const openaiTarget = {
      surface: "telegram" as const,
      accountId: "default",
      conversationId: "openai",
    };
    const deepseekTarget = {
      surface: "feishu" as const,
      accountId: "default",
      conversationId: "deepseek",
    };
    const core = new ConversationCore({
      allBindings: () => [
        { target: openaiTarget, threadId: "thread-openai" },
        { target: deepseekTarget, threadId: "thread-deepseek" },
      ],
      targetForThread: () => undefined,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    core.connectionRestored("DeepSeek App Server 已重新连接", new Set(["thread-deepseek"]));
    await output.close();

    expect(events.filter((event) => event.type === "connection.restored")).toEqual([{
      type: "connection.restored",
      target: deepseekTarget,
      threadId: "thread-deepseek",
      message: "DeepSeek App Server 已重新连接",
    }]);
  });

  it("publishes sanitized operation snapshots for command and file items", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const router = {
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
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

    handleNotification(core, {
      method: "item/started",
      params: { threadId: "thread-1", turnId: "turn-1", item: startedCommand },
    });
    handleNotification(core, {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { ...startedCommand, status: "completed", durationMs: 125, exitCode: 0 },
      },
    });
    handleNotification(core, {
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
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = {
      surface: "telegram",
      accountId: "default",
      conversationId: "100",
    };
    const core = new ConversationCore({
      allBindings: () => [],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "turn/diff/updated",
      params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/a b/a" },
    });
    handleNotification(core, {
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
      { surface: "telegram", accountId: "default", conversationId: "100" },
      "thread-1",
      "turn-2",
    );
    expect(core.artifacts("thread-1")).toEqual({
      threadId: "thread-1",
      turnId: "turn-2",
    });
    await output.close();
    expect(events).toContainEqual({
      type: "plan.updated",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "实施计划",
      steps: [
        { step: "检查", status: "completed" },
        { step: "修改", status: "inProgress" },
      ],
    });
  });

  it("merges sparse rate-limit updates and broadcasts threshold crossings once", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
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
    handleNotification(core, {
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
    handleNotification(core, {
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex", primary: { usedPercent: 50 } } },
    });
    handleNotification(core, {
      method: "account/rateLimits/updated",
      params: { rateLimits: { limitId: "codex", primary: { usedPercent: 91 } } },
    });
    handleNotification(core, {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "thread-1",
        name: "docs",
        status: "ready",
        error: null,
        failureReason: null,
      },
    });
    handleNotification(core, {
      method: "mcpServer/oauthLogin/completed",
      params: {
        threadId: "thread-1",
        name: "docs",
        success: true,
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
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "mcp.status.updated",
      name: "docs",
    }));
    expect(events).toContainEqual({
      type: "mcp.oauth.completed",
      target,
      threadId: "thread-1",
      name: "docs",
      success: true,
      error: null,
    });
  });

  it("broadcasts global App Server warnings to bound conversations", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
    const core = new ConversationCore({
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => undefined,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "warning",
      params: {
        threadId: null,
        message: "全局配置警告",
      },
    });
    await output.close();

    expect(events).toContainEqual({
      type: "warning",
      target,
      message: "全局配置警告",
    });
  });

  it("routes Provider-global MCP status and warnings only to matching conversations", async () => {
    const output = new EventBus<OutputEvent>(pino({ level: "silent" }));
    const events: OutputEvent[] = [];
    output.subscribe("test", (event) => {
      events.push(event);
    });
    const openaiTarget = {
      surface: "telegram" as const,
      accountId: "default",
      conversationId: "openai",
    };
    const deepseekTarget = {
      surface: "feishu" as const,
      accountId: "default",
      conversationId: "deepseek",
    };
    const core = new ConversationCore({
      allBindings: () => [
        { target: openaiTarget, threadId: "thread-openai" },
        { target: deepseekTarget, threadId: "thread-deepseek" },
      ],
      targetForThread: () => undefined,
      modelSettingsForThread: (threadId) => threadId === "thread-deepseek"
        ? {
          model: "deepseek-v4-flash",
          modelProvider: "deepseek",
          effort: "high",
          serviceTier: null,
        }
        : {
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          effort: "medium",
          serviceTier: null,
        },
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: null,
        name: "codex_apps",
        status: "failed",
        error: null,
        failureReason: null,
      },
      provider: "deepseek",
    });
    handleNotification(core, {
      method: "mcpServer/oauthLogin/completed",
      params: {
        threadId: null,
        name: "codex_apps",
        success: false,
        error: "OAuth denied",
      },
      provider: "deepseek",
    });
    handleNotification(core, {
      method: "warning",
      params: { threadId: null, message: "DeepSeek 配置警告" },
      provider: "deepseek",
    });
    await output.close();

    expect(events).toEqual([
      expect.objectContaining({
        type: "mcp.status.updated",
        target: deepseekTarget,
        name: "codex_apps",
        status: "failed",
      }),
      {
        type: "warning",
        target: deepseekTarget,
        message: "DeepSeek 配置警告",
      },
    ]);
  });

  it("publishes MCP failure and recovery but not normal startup progress", async () => {
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
      allBindings: () => [{ target, threadId: "thread-1" }],
      targetForThread: () => target,
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);
    const status = (value: "starting" | "ready" | "failed") => {
      handleNotification(core, {
        method: "mcpServer/startupStatus/updated",
        params: {
          threadId: "thread-1",
          name: "docs",
          status: value,
          error: value === "failed" ? "连接失败" : null,
          failureReason: null,
        },
      });
    };

    status("starting");
    status("ready");
    status("failed");
    status("starting");
    status("ready");
    await output.close();

    expect(events).toEqual([
      expect.objectContaining({
        type: "mcp.status.updated",
        name: "docs",
        status: "failed",
      }),
      expect.objectContaining({
        type: "mcp.status.updated",
        name: "docs",
        status: "ready",
      }),
    ]);
  });

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

  it("computes per-turn first-token time, output duration and visible tokens/s", async () => {
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
      receivedAtMs: 1_000,
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
      receivedAtMs: 1_500,
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
      receivedAtMs: 2_000,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "final-1",
        delta: "A",
      },
    });
    handleNotification(core, {
      method: "item/agentMessage/delta",
      receivedAtMs: 3_000,
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
      receivedAtMs: 4_000,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "final-2",
        delta: "C",
      },
    });
    handleNotification(core, {
      method: "item/agentMessage/delta",
      receivedAtMs: 4_500,
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
      requestStartedAtMs: 1_100,
      requestDurationMs: 2_000,
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      ttftMs: 300,
      thinkingDurationMs: 600,
      outputDurationMs: 800,
      generationDurationMs: 1_400,
      pricingCurrency: "USD",
      totalCostNanos: 100_000,
      uncachedInputPricePerMillionNanos: 140_000_000,
      cachedInputPricePerMillionNanos: 2_800_000,
      outputPricePerMillionNanos: 280_000_000,
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      operation: "compact",
      model: "gpt-5.6-sol",
      requestStartedAtMs: 1_200,
      requestDurationMs: 1_000,
      inputTokens: 200,
      cachedInputTokens: 160,
      outputTokens: 60,
      reasoningOutputTokens: 40,
      ttftMs: 250,
      thinkingDurationMs: 400,
      outputDurationMs: 500,
      generationDurationMs: 900,
      pricingCurrency: "USD",
      totalCostNanos: 200_000,
      uncachedInputPricePerMillionNanos: 140_000_000,
      cachedInputPricePerMillionNanos: 2_800_000,
      outputPricePerMillionNanos: 280_000_000,
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      requestStartedAtMs: 1_300,
      requestDurationMs: 500,
      outcome: "interrupted",
      outputTokens: 50,
      reasoningOutputTokens: 0,
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      requestStartedAtMs: 1_400,
      requestDurationMs: 500,
      outcome: "incomplete",
      thinkingDurationMs: 800,
      generationDurationMs: 900,
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      requestStartedAtMs: 1_500,
      requestDurationMs: 500,
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
      timing: {
        modelRequestCount: 5,
        modelRequestStartedAtMs: 1_500,
        completedModelRequestCount: 2,
        interruptedModelRequestCount: 1,
        incompleteModelRequestCount: 1,
        failedModelRequestCount: 1,
        retryableFailureModelRequestCount: 1,
        reasoningRequestCount: 2,
        modelRequestDurationMs: 4_500,
        requestInputTokens: 300,
        requestCachedInputTokens: 240,
        requestOutputTokens: 140,
        firstResponseLatencyMs: 500,
        outputDurationMs: 1_300,
        thinkingDurationMs: 1_000,
        nonReasoningOutputTokens: 90,
        reasoningTokens: 50,
        outputSpeedSampleCount: 3,
        outputSpeedTimedCount: 2,
        thinkingSpeedSampleCount: 2,
        thinkingSpeedTimedCount: 2,
        generationSpeedSampleCount: 3,
        generationSpeedTimedCount: 2,
        referenceCost: {
          currency: "USD",
          totalCostNanos: 300_000,
          pricedRequestCount: 2,
          requestCount: 5,
          uncachedInputPricePerMillionNanos: 140_000_000,
          cachedInputPricePerMillionNanos: 2_800_000,
          outputPricePerMillionNanos: 280_000_000,
          hasMixedPrices: false,
        },
        compact: {
          model: "gpt-5.6-sol",
          hasMixedModels: false,
          requestCount: 1,
          unsuccessfulRequestCount: 0,
          inputTokens: 200,
          cachedInputTokens: 160,
          outputTokens: 60,
          pricingCurrency: "USD",
          pricedRequestCount: 1,
          totalCostNanos: 200_000,
        },
      },
    });
    expect(completed?.timing?.outputTokensPerSecond).toBeCloseTo(40 / 1.3);
    expect(completed?.timing?.thinkingTokensPerSecond).toBeCloseTo(50);
    expect(completed?.timing?.generationTokensPerSecond).toBeCloseTo(90 / 2.3);
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
      receivedAtMs: 1_000,
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
    for (const [receivedAtMs, delta] of [[2_000, "A"], [3_000, "B"]] as const) {
      handleNotification(core, {
        method: "item/agentMessage/delta",
        receivedAtMs,
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
      requestStartedAtMs: 1_100,
      requestDurationMs: 2_000,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      ttftMs: 200,
      thinkingDurationMs: 500,
      outputDurationMs: 1_000,
      generationDurationMs: 1_500,
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-openai",
      turnId: "turn-openai",
      requestStartedAtMs: 1_200,
      requestDurationMs: 1_500,
      outputTokens: 60,
      reasoningOutputTokens: 40,
      ttftMs: 300,
      thinkingDurationMs: 400,
      outputDurationMs: 1_000,
      generationDurationMs: 1_400,
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
    expect(completed?.timing).toMatchObject({
      modelRequestCount: 2,
      modelRequestDurationMs: 3_500,
      requestOutputTokens: 90,
      nonReasoningOutputTokens: 40,
      outputTokensPerSecond: 20,
      outputSpeedSampleCount: 2,
      outputSpeedTimedCount: 2,
      firstResponseLatencyMs: 1_000,
    });
    expect(completed?.timing?.ttftMs).toBeUndefined();
    expect(completed?.timing?.reasoningTokens).toBe(50);
    expect(completed?.timing?.thinkingTokensPerSecond).toBeUndefined();
    expect(completed?.timing?.generationTokensPerSecond).toBeUndefined();
  });

  it("includes timing-stream fields for OpenCode Go completions", async () => {
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
        modelProvider: "opencode-go",
        effort: "high",
        serviceTier: null,
      }),
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    handleNotification(core, {
      method: "turn/started",
      receivedAtMs: 1_000,
      params: { threadId: "thread-og", turn: { id: "turn-og" } },
    });
    core.handle({
      type: "turn.modelTiming.updated",
      threadId: "thread-og",
      turnId: "turn-og",
      requestStartedAtMs: 1_200,
      requestDurationMs: 1_000,
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 40,
      reasoningOutputTokens: 20,
      ttftMs: 200,
      thinkingDurationMs: 400,
      outputDurationMs: 500,
      generationDurationMs: 900,
      pricingCurrency: "USD",
      totalCostNanos: 100_000,
      uncachedInputPricePerMillionNanos: 140_000_000,
      cachedInputPricePerMillionNanos: 2_800_000,
      outputPricePerMillionNanos: 280_000_000,
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
    expect(completed).toMatchObject({
      timing: {
        modelRequestCount: 1,
        thinkingDurationMs: 400,
        thinkingSpeedSampleCount: 1,
        thinkingSpeedTimedCount: 1,
        generationSpeedSampleCount: 1,
        generationSpeedTimedCount: 1,
      },
    });
  });

  it("collects distinct pricing buckets across priced model requests", async () => {
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
      modelSettingsForThread: () => undefined,
      contextCompactionItemIdsForThread: () => undefined,
    }, output);

    core.handle({
      type: "turn.started",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    for (const pricingBucket of ["off-peak", "peak", "off-peak"] as const) {
      core.handle({
        type: "turn.modelTiming.updated",
        threadId: "thread-1",
        turnId: "turn-1",
        requestStartedAtMs: 1_000,
        requestDurationMs: 500,
        pricingCurrency: "USD",
        totalCostNanos: 10_000,
        pricingBucket,
        uncachedInputPricePerMillionNanos: 1_000_000_000,
        cachedInputPricePerMillionNanos: 500_000_000,
        outputPricePerMillionNanos: 2_000_000_000,
      });
    }
    handleNotification(core, {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", error: null },
      },
    });
    await output.close();

    expect(events.find(
      (event) => event.type === "turn.completed",
    )).toMatchObject({
      timing: {
        referenceCost: {
          pricedRequestCount: 3,
          pricingBuckets: ["off-peak", "peak"],
        },
      },
    });
  });
});

function handleNotification(
  core: ConversationCore,
  notification: RpcNotification,
): void {
  const event = toConversationInputEvent(notification);
  if (event) {
    core.handle(event);
  }
}

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

function usageBreakdown(outputTokens: number, reasoningOutputTokens: number) {
  return {
    totalTokens: outputTokens + 1_000,
    inputTokens: 1_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens,
  };
}
