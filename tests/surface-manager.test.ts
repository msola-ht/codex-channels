import pino, { type Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScheduledTaskConfirmation } from "../src/application/index.js";
import type { InteractionPort } from "../src/approval/index.js";
import { SurfaceManager } from "../src/bootstrap/surface-manager.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { EventBus } from "../src/event-bus/index.js";
import type { SurfaceAdapter } from "../src/surfaces/index.js";

const interactions = {} as InteractionPort;
const logger = pino({ level: "silent" });

describe("SurfaceManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts every Surface and stops them in reverse registration order", async () => {
    const calls: string[] = [];
    const manager = createManager([
      surface("telegram", "default", calls),
      surface("feishu", "tenant-a", calls),
    ]);

    await manager.start();
    await manager.stop();

    expect(calls).toEqual([
      "start:telegram",
      "start:feishu",
      "stop:feishu",
      "stop:telegram",
    ]);
  });

  it("keeps healthy Surfaces running and retries a failed Surface independently", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let feishuStarts = 0;
    const feishu = surface("feishu", "tenant-a", calls);
    feishu.start = async () => {
      feishuStarts += 1;
      calls.push("start:feishu");
      if (feishuStarts === 1) {
        throw new Error("start failed");
      }
    };
    const manager = createManager([
      surface("telegram", "default", calls),
      feishu,
    ], undefined, { retryDelaysMs: [10] });

    await expect(manager.start()).resolves.toBeUndefined();
    expect(calls).toEqual([
      "start:telegram",
      "start:feishu",
    ]);

    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([
      "start:telegram",
      "start:feishu",
      "start:feishu",
    ]);

    await manager.stop();
    expect(calls.slice(-2)).toEqual(["stop:feishu", "stop:telegram"]);
  });

  it("recovers only the failed Surface after a runtime fatal error", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const availability: string[] = [];
    const telegram = surface("telegram", "default", calls);
    const feishu = surface("feishu", "tenant-a", calls);
    const manager = createManager(
      [telegram, feishu],
      undefined,
      {
        retryDelaysMs: [10],
        setInteractionAvailable: (surfaceId, accountId, available) => {
          availability.push(`${surfaceId}:${accountId}:${available}`);
        },
      },
    );
    await manager.start();

    manager.reportFatal("telegram", "default", new Error("polling failed"));
    await vi.advanceTimersByTimeAsync(10);

    expect(calls).toEqual([
      "start:telegram",
      "start:feishu",
      "start:telegram",
    ]);
    expect(availability).toEqual([
      "telegram:default:true",
      "feishu:tenant-a:true",
      "telegram:default:false",
      "telegram:default:true",
    ]);
    await manager.stop();
  });

  it("queues critical output during recovery and flushes it after reconnecting", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const received: string[] = [];
    const telegram = surface("telegram", "default", calls);
    telegram.output.handle = (event) => {
      received.push(event.type);
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager(
      [telegram],
      output,
      { retryDelaysMs: [10] },
    );
    await manager.start();
    manager.reportFatal("telegram", "default", new Error("polling failed"));

    output.publish({
      type: "warning",
      target: {
        surface: "telegram",
        accountId: "default",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      message: "需要保留",
    });
    output.publish({
      type: "text.delta",
      target: {
        surface: "telegram",
        accountId: "default",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "可以丢弃",
    });
    await settle();

    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(received).toEqual(["warning"]);
    await manager.stop();
  });

  it("queues critical output while a Surface is still starting", async () => {
    const calls: string[] = [];
    const received: string[] = [];
    let resolveStart!: () => void;
    const telegram = surface("telegram", "default", calls);
    telegram.start = () => new Promise<void>((resolve) => {
      calls.push("start:telegram");
      resolveStart = resolve;
    });
    telegram.output.handle = (event) => {
      received.push(event.type);
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([telegram], output);

    const starting = manager.start();
    output.publish({
      type: "warning",
      target: {
        surface: "telegram",
        accountId: "default",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      message: "启动期间不能丢失",
    });
    await settle();
    expect(received).toEqual([]);

    resolveStart();
    await starting;
    expect(received).toEqual(["warning"]);
    await manager.stop();
    await output.close();
  });

  it("continues stopping remaining Surfaces after one stop fails", async () => {
    const calls: string[] = [];
    const manager = createManager([
      surface("telegram", "default", calls),
      surface("feishu", "tenant-a", calls, { failStop: true }),
    ]);
    await manager.start();

    await expect(manager.stop()).rejects.toThrow("部分 Surface 未能停止");

    expect(calls).toEqual([
      "start:telegram",
      "start:feishu",
      "stop:feishu",
      "stop:telegram",
    ]);
  });

  it("retains failed Surfaces so a later cleanup attempt can retry them", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const retrying = surface("telegram", "default", calls);
    retrying.stop = async () => {
      attempts += 1;
      calls.push("stop:telegram");
      if (attempts === 1) {
        throw new Error("stop failed");
      }
    };
    const manager = createManager([retrying]);
    await manager.start();

    await expect(manager.stop()).rejects.toThrow("部分 Surface 未能停止");
    await expect(manager.stop()).resolves.toBeUndefined();

    expect(calls).toEqual([
      "start:telegram",
      "stop:telegram",
      "stop:telegram",
    ]);
  });

  it("forwards configuration changes only to started Surfaces", async () => {
    const calls: string[] = [];
    const adapter = surface("telegram", "default", calls);
    adapter.configurationChanged = (change) => {
      calls.push(`workspace:${change.addedWorkspaces[0]?.id}`);
    };
    const manager = createManager([adapter]);

    manager.configurationChanged({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "ignored", name: "Ignored", cwd: "/ignored" }],
    });
    await manager.start();
    manager.configurationChanged({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "docs", name: "Docs", cwd: "/docs" }],
    });
    await manager.stop();

    expect(calls).toEqual([
      "start:telegram",
      "workspace:docs",
      "stop:telegram",
    ]);
  });

  it("filters Surface-scoped changes while preserving process restart notices", async () => {
    const calls: string[] = [];
    const telegram = surface("telegram", "default", calls);
    const feishu = surface("feishu", "tenant-a", calls);
    telegram.configurationChanged = (change) => {
      calls.push(`telegram:${change.action}:${change.changes.map((item) => item.code).join(",")}`);
    };
    feishu.configurationChanged = (change) => {
      calls.push(`feishu:${change.action}:${change.changes.map((item) => item.code).join(",")}`);
    };
    const manager = createManager([telegram, feishu]);
    await manager.start();
    calls.length = 0;

    manager.configurationChanged({
      action: "reloaded",
      changes: [{ code: "surface.telegram.allowed-users", scope: "telegram" }],
      addedWorkspaces: [],
    });
    manager.configurationChanged({
      action: "restarting",
      changes: [{ code: "surface.telegram.token", scope: "telegram" }],
      addedWorkspaces: [],
    });
    manager.configurationChanged({
      action: "reloaded",
      changes: [{ code: "surface.feishu.allowed-users", scope: "feishu" }],
      addedWorkspaces: [],
    });

    expect(calls).toEqual([
      "telegram:reloaded:surface.telegram.allowed-users",
      "telegram:restarting:surface.telegram.token",
      "feishu:restarting:",
      "feishu:reloaded:surface.feishu.allowed-users",
    ]);
    await manager.stop();
  });

  it("delivers global persistent changes to every Surface", async () => {
    const deliveries: string[] = [];
    const telegram = surface("telegram", "default", []);
    const feishu = surface("feishu", "tenant-a", []);
    telegram.deliverConfigurationChange = async (change) => {
      deliveries.push(`telegram:${change.changes[0]?.code}`);
    };
    feishu.deliverConfigurationChange = async (change) => {
      deliveries.push(`feishu:${change.changes[0]?.code}`);
    };
    const manager = createManager([telegram, feishu]);
    await manager.start();

    await manager.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "docs", name: "Docs", cwd: "/docs" }],
    });

    expect(deliveries.sort()).toEqual([
      "feishu:workspace.registry",
      "telegram:workspace.registry",
    ]);
    await manager.stop();
  });

  it("reports when a Surface fails to deliver a persistent configuration notification", async () => {
    const calls: string[] = [];
    const accepted = surface("telegram", "default", calls);
    const rejected = surface("feishu", "tenant-a", calls);
    rejected.deliverConfigurationChange = async () => {
      throw new Error("delivery failed");
    };
    const manager = createManager([accepted, rejected]);
    await manager.start();

    await expect(manager.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "docs", name: "Docs", cwd: "/docs" }],
    })).rejects.toThrow("部分 Surface 未收到配置事件");

    await manager.stop();
  });

  it("does not confirm persistent notifications before all Surfaces start", async () => {
    const manager = createManager([
      surface("telegram", "default", []),
    ]);

    await expect(manager.deliverConfigurationChange({
      action: "reloaded",
      changes: [{ code: "workspace.registry", scope: "global" }],
      addedWorkspaces: [{ id: "docs", name: "Docs", cwd: "/docs" }],
    })).rejects.toThrow("部分 Surface 当前不可用");
  });

  it("routes output by exact Surface and account", async () => {
    const telegram = surface("telegram", "default", []);
    const feishu = surface("feishu", "tenant-a", []);
    const received: string[] = [];
    telegram.output.handle = (event) => {
      received.push(`telegram:${event.type}`);
    };
    feishu.output.handle = (event) => {
      received.push(`feishu:${event.type}`);
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([telegram, feishu], output);
    await manager.start();

    output.publish({
      type: "thread.status",
      target: {
        surface: "feishu",
        accountId: "tenant-a",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      status: "idle",
    });
    await settle();

    expect(received).toEqual(["feishu:thread.status"]);
    await manager.stop();
    await output.close();
  });

  it("routes a scheduled-task confirmation only to the exact interactive Surface", () => {
    const telegram = surface("telegram", "default", []);
    const feishu = surface("feishu", "tenant-a", []);
    const weixin = surface("weixin", "wx-a", []);
    const telegramPresentation = vi.fn();
    const feishuPresentation = vi.fn();
    telegram.presentScheduledTaskConfirmation = telegramPresentation;
    feishu.presentScheduledTaskConfirmation = feishuPresentation;
    const manager = createManager([telegram, feishu, weixin]);
    const target = {
      surface: "feishu",
      accountId: "tenant-a",
      conversationId: "chat-1",
    };
    const preview = scheduledTaskPreview();

    expect(manager.presentScheduledTaskConfirmation(
      target,
      "actor-1",
      preview,
    )).toBe(true);
    expect(feishuPresentation).toHaveBeenCalledWith(
      target,
      "actor-1",
      preview,
    );
    expect(telegramPresentation).not.toHaveBeenCalled();
    expect(manager.presentScheduledTaskConfirmation(
      { surface: "weixin", accountId: "wx-a", conversationId: "wx-chat" },
      "wx-actor",
      preview,
    )).toBe(false);
  });

  it("does not amplify per-token text deltas in debug logs", async () => {
    const debug = vi.fn();
    const diagnosticLogger = {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    const telegram = surface("telegram", "default", []);
    const output = new EventBus<OutputEvent>(logger);
    const manager = new SurfaceManager(
      [telegram],
      output,
      diagnosticLogger,
    );
    await manager.start();

    output.publish({
      type: "text.delta",
      target: {
        surface: "telegram",
        accountId: "default",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "不应进入日志",
    });
    output.publish({
      type: "thread.status",
      target: {
        surface: "telegram",
        accountId: "default",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      status: "idle",
    });
    await output.close();

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "thread.status" }),
      "输出事件已提交到 Surface 队列",
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain("text.delta");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("不应进入日志");

    await manager.stop();
  });

  it("buffers critical output before startup and stops routing after shutdown", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: string[] = [];
    feishu.output.handle = (event) => {
      received.push(event.type);
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output);
    const event: OutputEvent = {
      type: "thread.status",
      target: {
        surface: "feishu",
        accountId: "tenant-a",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      status: "idle",
    };

    output.publish(event);
    await settle();
    await manager.start();
    output.publish(event);
    await settle();
    await manager.stop();
    output.publish(event);
    await settle();

    expect(received).toEqual(["thread.status", "thread.status"]);
    await output.close();
  });

  it("adds the current Git branch to completed Turns before routing", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: OutputEvent[] = [];
    feishu.output.handle = (event) => {
      received.push(event);
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = new SurfaceManager(
      [feishu],
      output,
      logger,
      () => "feature/weixin-surface",
    );
    await manager.start();

    output.publish({
      type: "turn.completed",
      target: {
        surface: "feishu",
        accountId: "tenant-a",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    await settle();

    expect(received).toEqual([
      expect.objectContaining({
        type: "turn.completed",
        gitBranch: "feature/weixin-surface",
      }),
    ]);
    await manager.stop();
    await output.close();
  });

  it("reads session reference cost after an asynchronous task aggregate", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const order: string[] = [];
    let resolveTask!: () => void;
    let resolveTaskStarted!: () => void;
    const taskGate = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    const taskStarted = new Promise<void>((resolve) => {
      resolveTaskStarted = resolve;
    });
    let resolveDelivery!: () => void;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    feishu.output.handle = () => {
      order.push("output");
      resolveDelivery();
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      sessionReferenceCost: () => {
        order.push("session");
        return undefined;
      },
      taskAggregate: async () => {
        order.push("task-start");
        resolveTaskStarted();
        await taskGate;
        order.push("task-finished");
        return undefined;
      },
    });
    await manager.start();

    output.publish({
      type: "turn.completed",
      target: {
        surface: "feishu",
        accountId: "tenant-a",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    await taskStarted;

    expect(order).toEqual(["task-start"]);
    resolveTask();
    await delivered;
    expect(order).toEqual([
      "task-start",
      "task-finished",
      "session",
      "output",
    ]);

    await manager.stop();
    await output.close();
  });

  it("waits for recovered completion timing before reading the session aggregate", async () => {
    const received: OutputEvent[] = [];
    const order: string[] = [];
    let releaseTiming!: () => void;
    let markTimingStarted!: () => void;
    const timingGate = new Promise<void>((resolve) => {
      releaseTiming = resolve;
    });
    const timingStarted = new Promise<void>((resolve) => {
      markTimingStarted = resolve;
    });
    let markDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      markDelivered = resolve;
    });
    const feishu = surface("feishu", "tenant-a", []);
    feishu.output.handle = (event) => {
      order.push("output");
      received.push(event);
      markDelivered();
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      completionTiming: async () => {
        order.push("timing-start");
        markTimingStarted();
        await timingGate;
        order.push("timing-finished");
        return {
          modelRequestCount: 2,
          requestInputTokens: 1_000,
          requestOutputTokens: 100,
          referenceCost: {
            currency: "USD",
            totalCostNanos: 12_000,
            inputTokens: 1_000,
            outputTokens: 100,
            inputCostNanos: 8_000,
            cachedInputCostNanos: 1_000,
            outputCostNanos: 3_000,
            pricedRequestCount: 2,
            requestCount: 2,
            uncachedInputPricePerMillionNanos: 10,
            cachedInputPricePerMillionNanos: 1,
            outputPricePerMillionNanos: 30,
            hasMixedPrices: false,
          },
        };
      },
      sessionReferenceCost: (_threadId, _turnId, current) => {
        order.push(`session-${current?.requestCount ?? "missing"}`);
        return current;
      },
    });
    await manager.start();

    output.publish({
      type: "turn.completed",
      target: {
        surface: "feishu",
        accountId: "tenant-a",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    await timingStarted;

    expect(order).toEqual(["timing-start"]);
    releaseTiming();
    await delivered;
    expect(order).toEqual([
      "timing-start",
      "timing-finished",
      "session-2",
      "output",
    ]);
    expect(received).toEqual([
      expect.objectContaining({
        type: "turn.completed",
        timing: expect.objectContaining({
          modelRequestCount: 2,
          requestInputTokens: 1_000,
          requestOutputTokens: 100,
        }),
        sessionReferenceCost: expect.objectContaining({
          requestCount: 2,
          inputTokens: 1_000,
          outputTokens: 100,
        }),
      }),
    ]);

    await manager.stop();
    await output.close();
  });

  it("isolates a Surface output rejection from later events", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: string[] = [];
    let attempts = 0;
    let resolveSecond!: () => void;
    const secondDelivered = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    feishu.output.handle = (event) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("not ready");
      }
      received.push(event.type);
      resolveSecond();
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output);
    await manager.start();
    const event: OutputEvent = {
      type: "thread.status",
      target: {
        surface: "feishu",
        accountId: "tenant-a",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      status: "idle",
    };

    output.publish(event);
    output.publish(event);
    await secondDelivered;

    expect(received).toEqual(["thread.status"]);
    await manager.stop();
    await output.close();
  });

  it("ignores output for an unregistered account", async () => {
    const telegram = surface("telegram", "default", []);
    const received: OutputEvent[] = [];
    telegram.output.handle = (event) => {
      received.push(event);
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([telegram], output);

    output.publish({
      type: "thread.status",
      target: {
        surface: "telegram",
        accountId: "other",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      status: "idle",
    });
    await settle();

    expect(received).toEqual([]);
    await manager.stop();
    await output.close();
  });

  it("rejects duplicate Surface account registrations", async () => {
    const output = new EventBus<OutputEvent>(logger);

    expect(() => createManager([
      surface("telegram", "default", []),
      surface("telegram", "default", []),
    ], output)).toThrow("Surface 重复注册");

    await output.close();
  });
});

function createManager(
  surfaces: SurfaceAdapter[],
  output = new EventBus<OutputEvent>(logger),
  options?: ConstructorParameters<typeof SurfaceManager>[4],
): SurfaceManager {
  return new SurfaceManager(surfaces, output, logger, undefined, options);
}

function surface(
  id: string,
  accountId: string,
  calls: string[],
  failures: { failStart?: boolean; failStop?: boolean } = {},
): SurfaceAdapter {
  return {
    surface: id,
    accountId,
    interactions,
    output: {
      handle() {},
    },
    async start() {
      calls.push(`start:${id}`);
      if (failures.failStart) {
        throw new Error("start failed");
      }
    },
    async stop() {
      calls.push(`stop:${id}`);
      if (failures.failStop) {
        throw new Error("stop failed");
      }
    },
    async deliverConfigurationChange() {},
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function scheduledTaskPreview(): ScheduledTaskConfirmation {
  return {
    action: "create",
    token: "12345678-1234-1234-1234-123456789abc",
    expiresAt: 2,
    task: {
      taskId: "task-preview",
      name: "检查 CI",
      status: "active",
      schedule: { type: "interval", intervalMinutes: 60, anchorAt: 1 },
      timezone: "Asia/Shanghai",
      nextRunAt: 2,
      workspaceId: "main",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      sandbox: "workspace-write",
      permissions: null,
      promptPreview: "检查 CI",
    },
  };
}
