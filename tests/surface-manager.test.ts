import pino, { type Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScheduledTaskConfirmation } from "../src/application/index.js";
import type { InteractionPort } from "../src/approval/index.js";
import { SurfaceManager } from "../src/bootstrap/surface-manager.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { EventBus } from "../src/event-bus/index.js";
import type { SurfaceAdapter } from "../src/surfaces/index.js";
import { WeixinInputFatalError } from "../src/surfaces/weixin/index.js";

const interactions = {} as InteractionPort;
const logger = pino({ level: "silent" });

class MessageProcessingFixtureError extends Error {
  constructor(options: ErrorOptions) {
    super("微信消息处理失败", options);
    this.name = "MessageProcessingFixtureError";
  }
}

describe("SurfaceManager", () => {
  it("correlates shared routing waits without confusing them with platform delivery", async () => {
    vi.useFakeTimers();
    const records: Array<Record<string, unknown>> = [];
    const diagnosticLogger = pino({ level: "info" }, { write(line) { records.push(JSON.parse(line)); } });
    const output = new EventBus<OutputEvent>(diagnosticLogger);
    const telegram = surface("telegram", "default", []);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    telegram.output.handle = async (event) => {
      if (event.type === "warning") { started(); await gate; }
    };
    const manager = new SurfaceManager([telegram], output, diagnosticLogger);
    await manager.start();
    const target = { surface: "telegram" as const, accountId: "default", conversationId: "chat" };
    output.publish({ type: "warning", target, threadId: "thread", message: "PRIVATE BODY" });
    await ready;
    output.publish({ type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: "answer", text: "PRIVATE BODY" }, true);
    await vi.advanceTimersByTimeAsync(6000);
    release();
    await output.close();
    await manager.stop();
    expect(records.find((record) => record.eventType === "text.completed")).toMatchObject({
      stage: "routing", eventBusWaitMs: 0, routingMs: 0, itemId: "answer", conversationId: "chat",
    });
    expect(JSON.stringify(records)).not.toContain("PRIVATE BODY");
  });

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

  it("logs a bounded error chain for fatal Surface errors", async () => {
    const calls: string[] = [];
    const telegram = surface("telegram", "default", calls);
    const output = new EventBus<OutputEvent>(logger);
    const records: Array<Record<string, unknown>> = [];
    const managerLogger = {
      debug() {},
      info() {},
      warn() {},
      error: (fields: Record<string, unknown>, message: string) => {
        if (message === "Surface 连接已中断，将独立重试") records.push(fields);
      },
    } as unknown as Logger;
    const manager = new SurfaceManager(
      [telegram],
      output,
      managerLogger,
      undefined,
      { retryDelaysMs: [60_000] },
    );
    await manager.start();

    manager.reportFatal("telegram", "default", new WeixinInputFatalError(
      "message-processing",
      {
        cause: new MessageProcessingFixtureError({
          cause: new Error("private application detail"),
        }),
      },
    ));
    await settle();

    expect(records).toEqual([
      expect.objectContaining({
        surface: "telegram",
        accountId: "default",
        // 日志序列化会剥掉小写错误码，这里必须显式补回受控的类型与错误码链。
        errorChain: [
          "WeixinInputFatalError:message-processing",
          "MessageProcessingFixtureError",
          "Error",
        ],
      }),
    ]);
    expect(JSON.stringify(records[0]?.errorChain)).not.toContain("private");
    await manager.stop();
    await output.close();
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
    await vi.waitFor(() => expect(received).toEqual(["warning"]));
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
    await settle();

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

  it("retains all critical output while a Surface is unavailable", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: string[] = [];
    feishu.output.handle = (event) => {
      if (event.type === "turn.completed") {
        received.push(event.turnId);
      }
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      maximumPendingCriticalOutput: 1,
    });
    const event = (turnId: string): OutputEvent => ({
      type: "turn.completed",
      target: {
        surface: "feishu",
        accountId: "tenant-a",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      turnId,
      status: "completed",
    });

    output.publish(event("turn-1"));
    output.publish(event("turn-2"));
    await settle();
    await manager.start();
    await settle();

    expect(received).toEqual(["turn-1", "turn-2"]);
    await manager.stop();
    await output.close();
  });

  it("reports the recovery buffer threshold only when the retained count doubles", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const output = new EventBus<OutputEvent>(logger);
    const thresholds: number[] = [];
    const managerLogger = {
      info() {},
      debug() {},
      warn() {},
      error: (fields: { pending?: number; threshold?: number }, message: string) => {
        if (message === "Surface 恢复队列达到告警阈值，关键输出继续保留") {
          thresholds.push(fields.pending ?? -1, fields.threshold ?? -1);
        }
      },
    } as unknown as Logger;
    // 告警阈值 2：越过 2、4、8 时各记录一次，其余保留期不再重复告警。
    const manager = new SurfaceManager([feishu], output, managerLogger, undefined, {
      maximumPendingCriticalOutput: 2,
    });

    for (let index = 0; index < 12; index += 1) {
      output.publish({
        type: "turn.completed",
        target: {
          surface: "feishu",
          accountId: "tenant-a",
          conversationId: "chat-1",
        },
        threadId: "thread-1",
        turnId: `turn-${index}`,
        status: "completed",
      });
    }
    await flushEventBus();

    expect(thresholds).toEqual([2, 2, 4, 4, 8, 8]);
    await manager.stop();
    await output.close();
  });

  it("coalesces unavailable reasoning snapshots per Turn while keeping approvals and completion", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: string[] = [];
    feishu.output.handle = (event) => {
      if (event.type === "turn.reasoning") {
        received.push(`reasoning:${event.turnId}:${event.summary}`);
      }
      if (event.type === "turn.completed") {
        received.push(`completed:${event.turnId}`);
      }
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      maximumPendingCriticalOutput: 2,
    });
    const reasoning = (turnId: string, summary: string): OutputEvent => ({
      type: "turn.reasoning",
      target: {
        surface: "feishu",
        accountId: "tenant-a",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      turnId,
      summary,
      elapsedMs: 1_000,
    });
    const completed = (turnId: string): OutputEvent => ({
      type: "turn.completed",
      target: {
        surface: "feishu",
        accountId: "tenant-a",
        conversationId: "chat-1",
      },
      threadId: "thread-1",
      turnId,
      status: "completed",
    });

    output.publish(reasoning("turn-1", "旧快照"));
    output.publish(reasoning("turn-1", "新快照"));
    output.publish(reasoning("turn-2", "另一轮"));
    output.publish(completed("turn-1"));
    output.publish(completed("turn-2"));
    // 让输出总线在 Surface 仍不可用时真正处理完这批事件，否则事件会在启动后才被
    // 读取，从而绕过恢复缓冲。
    await flushEventBus();
    await manager.start();
    await settle();

    expect(received).toEqual([
      "reasoning:turn-1:新快照",
      "reasoning:turn-2:另一轮",
      "completed:turn-1",
      "completed:turn-2",
    ]);
    await manager.stop();
    await output.close();
  });

  it("buffers exactly what a Surface would deliver while unavailable", async () => {
    const weixin = surface("weixin", "default", []);
    const received: string[] = [];
    weixin.output.handle = (event) => {
      received.push(event.type);
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([weixin], output, {
      maximumPendingCriticalOutput: 2,
    });
    const target = {
      surface: "weixin",
      accountId: "default",
      conversationId: "chat-1",
    };

    // 微信白名单内的开始确认与完成事件必须保留；被忽略的推理状态不占用恢复缓冲。
    output.publish({
      type: "turn.started",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    output.publish({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      summary: "",
      elapsedMs: 1_000,
    });
    output.publish({
      type: "turn.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    await flushEventBus();
    await manager.start();
    await settle();

    expect(received).toEqual(["turn.started", "turn.completed"]);
    await manager.stop();
    await output.close();
  });

  it("sheds process output only after the recovery buffer passes its hard limit", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: string[] = [];
    feishu.output.handle = (event) => {
      if (event.type === "turn.reasoning") {
        received.push(`reasoning:${event.turnId}`);
      }
      if (event.type === "turn.completed") {
        received.push(`completed:${event.turnId}`);
      }
    };
    const output = new EventBus<OutputEvent>(logger);
    // 告警阈值 1，硬上限为十倍即 10 条。
    const manager = createManager([feishu], output, {
      maximumPendingCriticalOutput: 1,
    });
    const target = {
      surface: "feishu",
      accountId: "tenant-a",
      conversationId: "chat-1",
    };

    for (let index = 0; index < 12; index += 1) {
      output.publish({
        type: "turn.reasoning",
        target,
        threadId: "thread-1",
        turnId: `turn-${index}`,
        summary: "",
        elapsedMs: 1_000,
      });
    }
    output.publish({
      type: "turn.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-result",
      status: "completed",
    });
    await flushEventBus();
    await manager.start();
    await settle();

    const reasoning = received.filter((entry) => entry.startsWith("reasoning:"));
    expect(reasoning.length).toBeLessThanOrEqual(10);
    expect(received).toContain("reasoning:turn-11");
    expect(received).toContain("completed:turn-result");
    await manager.stop();
    await output.close();
  });

  it("drops a new process event when the recovery buffer holds only results", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: string[] = [];
    feishu.output.handle = (event) => {
      if (event.type === "turn.reasoning") {
        received.push(`reasoning:${event.turnId}`);
      }
      if (event.type === "turn.completed") {
        received.push(`completed:${event.turnId}`);
      }
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      maximumPendingCriticalOutput: 1,
    });
    const target = {
      surface: "feishu",
      accountId: "tenant-a",
      conversationId: "chat-1",
    };

    // 十条完成事件已经占满硬上限（告警阈值 1 的十倍），且都是必须保留的结果。
    for (let index = 0; index < 10; index += 1) {
      output.publish({
        type: "turn.completed",
        target,
        threadId: "thread-1",
        turnId: `turn-${index}`,
        status: "completed",
      });
    }
    output.publish({
      type: "turn.reasoning",
      target,
      threadId: "thread-1",
      turnId: "turn-reasoning",
      summary: "",
      elapsedMs: 1_000,
    });
    await flushEventBus();
    await manager.start();
    await settle();

    // 结果类事件不能被过程事件挤出缓冲，因此被丢弃的是新到达的过程事件。
    expect(received).toEqual(
      Array.from({ length: 10 }, (_value, index) => `completed:turn-${index}`),
    );
    await manager.stop();
    await output.close();
  });

  it("adds the current Git branch to completed Turns before delivery", async () => {
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

  it("isolates slow completion enrichment by conversation and preserves local order", async () => {
    const received: string[] = [];
    const feishu = surface("feishu", "tenant-a", []);
    const telegram = surface("telegram", "default", []);
    for (const adapter of [feishu, telegram]) {
      adapter.output.handle = (event) => { received.push(`${event.target.conversationId}:${event.type}`); };
    }
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu, telegram], output, {
      completionAccountStatus: async () => { await blocked; return undefined; },
    });
    await manager.start();
    const target = { surface: "feishu" as const, accountId: "tenant-a", conversationId: "slow" };
    output.publish({ type: "turn.completed", target, threadId: "thread", turnId: "turn", status: "completed", modelProvider: "clp-main" }, true);
    output.publish({ type: "warning", target, threadId: "thread", message: "after completion" }, true);
    for (const adapter of [feishu, telegram]) {
      output.publish({ type: "warning", target: { surface: adapter.surface, accountId: adapter.accountId, conversationId: adapter.surface }, threadId: "other", message: "independent" }, true);
    }
    await settle();
    expect(received).toEqual(["feishu:warning", "telegram:warning"]);
    release();
    await settle();
    expect(received.slice(2)).toEqual(["slow:turn.completed", "slow:warning"]);
    await output.close();
    await manager.stop();
  });

  it.each(["clp-main", "openai", undefined])("reads completion account data only for the exact third-party provider %s", async (provider) => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: OutputEvent[] = [];
    feishu.output.handle = (event) => { received.push(event); };
    const read = vi.fn(async (id: string) => ({ provider: id, balances: [], windows: [{ label: "7天", usedPercent: 9, resetsAt: null }] }));
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, { completionAccountStatus: read });
    await manager.start();
    output.publish({ type: "turn.completed", target: { surface: "feishu", accountId: "tenant-a", conversationId: "chat" }, threadId: "thread", turnId: "turn", status: "completed", ...(provider ? { modelProvider: provider } : {}) });
    await settle();
    if (provider === "clp-main") {
      expect(read).toHaveBeenCalledWith(provider, expect.any(AbortSignal));
      expect(received[0]).toMatchObject({ accountStatus: { provider, windows: [{ usedPercent: 9 }] } });
    } else {
      expect(read).not.toHaveBeenCalled();
      expect(received[0]).not.toHaveProperty("accountStatus");
    }
    await manager.stop();
    await output.close();
  });

  it.each(["failure", "mismatch", "timeout", "stop"])("isolates completion account %s and cancels pending queries", async (mode) => {
    vi.useFakeTimers();
    try {
      const feishu = surface("feishu", "tenant-a", []);
      const received: OutputEvent[] = [];
      feishu.output.handle = (event) => { received.push(event); };
      let signal: AbortSignal | undefined;
      const output = new EventBus<OutputEvent>(logger);
      const manager = createManager([feishu], output, {
        completionAccountStatus: async (_provider, currentSignal) => {
          signal = currentSignal;
          if (mode === "failure") throw new Error("fixture");
          if (mode === "mismatch") return { provider: "clp-other", balances: [], windows: [] };
          return new Promise((_, reject) => currentSignal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
        },
      });
      await manager.start();
      output.publish({ type: "turn.completed", target: { surface: "feishu", accountId: "tenant-a", conversationId: "chat" }, threadId: "thread", turnId: "turn", status: "completed", modelProvider: "clp-main" });
      await settle();
      if (mode === "timeout") {
        expect(received).toEqual([]);
        await vi.advanceTimersByTimeAsync(2_000);
        await settle();
      }
      if (mode !== "stop") {
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        expect(received).toHaveLength(1);
        expect(received[0]).not.toHaveProperty("accountStatus");
      }
      await manager.stop();
      expect(signal?.aborted).toBe(true);
      await output.close();
    } finally { vi.useRealTimers(); }
  });

  it("defers Turn completion enrichment until the buffered event is delivered", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const reads: string[] = [];
    const received: OutputEvent[] = [];
    feishu.output.handle = (event) => {
      received.push(event);
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      taskAggregate: (_threadId, turnId) => {
        reads.push(turnId);
        return undefined;
      },
    });

    // 渠道尚未启动：完成事件进入恢复缓冲，此时不读取指标库。
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
    await flushEventBus();
    expect(reads).toEqual([]);

    await manager.start();
    await flushEventBus();
    expect(reads).toEqual(["turn-1"]);
    expect(received).toEqual([
      expect.objectContaining({ type: "turn.completed" }),
    ]);
    await manager.stop();
    await output.close();
  });

  it.each([true, false])("preserves arrival order across failure and recovery (query finishes first: %s)", async (queryFirst) => {
    vi.useFakeTimers();
    const received: string[] = [];
    const feishu = surface("feishu", "tenant-a", []);
    feishu.output.handle = (event) => {
      received.push(event.type === "warning" ? event.message : event.type);
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      retryDelaysMs: [1000],
      completionAccountStatus: async () => { await blocked; return undefined; },
    });
    const target = { surface: "feishu", accountId: "tenant-a", conversationId: "chat" };
    await manager.start();
    output.publish({ type: "turn.completed", target, threadId: "thread", turnId: "turn", status: "completed", modelProvider: "clp-main" }, true);
    output.publish({ type: "warning", target, threadId: "thread", message: "queued before failure" }, true);
    await vi.advanceTimersByTimeAsync(0);
    manager.reportFatal("feishu", "tenant-a", new Error("fixture"));
    output.publish({ type: "warning", target, threadId: "thread", message: "arrived while offline" }, true);
    await vi.advanceTimersByTimeAsync(0);
    if (queryFirst) {
      release();
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(1000);
    if (!queryFirst) {
      expect(received).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(received).toEqual(["turn.completed", "queued before failure", "arrived while offline"]);
    await manager.stop();
    await output.close();
  });

  it("does not replace an offline snapshot with an older in-flight snapshot", async () => {
    vi.useFakeTimers();
    const received: OutputEvent[] = [];
    const feishu = surface("feishu", "tenant-a", []);
    feishu.output.handle = (event) => { received.push(event); };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      retryDelaysMs: [1000], completionAccountStatus: async () => { await blocked; return undefined; },
    });
    const target = { surface: "feishu", accountId: "tenant-a", conversationId: "chat" };
    await manager.start();
    output.publish({ type: "turn.completed", target, threadId: "thread", turnId: "turn", status: "completed", modelProvider: "clp-main" }, true);
    output.publish({ type: "turn.reasoning", target, threadId: "thread", turnId: "next", summary: "older", elapsedMs: 1000 }, true);
    await vi.advanceTimersByTimeAsync(0);
    manager.reportFatal("feishu", "tenant-a", new Error("fixture"));
    output.publish({ type: "turn.reasoning", target, threadId: "thread", turnId: "next", summary: "newer", elapsedMs: 2000 }, true);
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(received.map((event) => event.type === "turn.reasoning" ? event.summary : event.type)).toEqual(["turn.completed", "newer"]);
    await manager.stop();
    await output.close();
  });

  it("does not restart a Surface after shutdown while recovery is waiting for delivery", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const feishu = surface("feishu", "tenant-a", calls);
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      retryDelaysMs: [1000], completionAccountStatus: (_provider, signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
    });
    await manager.start();
    output.publish({ type: "turn.completed", target: { surface: "feishu", accountId: "tenant-a", conversationId: "chat" }, threadId: "thread", turnId: "turn", status: "completed", modelProvider: "clp-main" }, true);
    await vi.advanceTimersByTimeAsync(0);
    manager.reportFatal("feishu", "tenant-a", new Error("fixture"));
    await vi.advanceTimersByTimeAsync(1000);
    await manager.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual(["start:feishu", "stop:feishu"]);
    await output.close();
  });

  it("keeps buffered replay order while Turn completion enrichment is pending", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: string[] = [];
    feishu.output.handle = (event) => {
      received.push(event.type);
    };
    let releaseAggregate!: () => void;
    let markAggregateStarted!: () => void;
    const aggregateGate = new Promise<void>((resolve) => {
      releaseAggregate = resolve;
    });
    const aggregateStarted = new Promise<void>((resolve) => {
      markAggregateStarted = resolve;
    });
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      taskAggregate: async () => {
        markAggregateStarted();
        await aggregateGate;
        return undefined;
      },
    });
    const target = {
      surface: "feishu",
      accountId: "tenant-a",
      conversationId: "chat-1",
    };
    output.publish({
      type: "turn.completed",
      target,
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
    });
    output.publish({
      type: "thread.status",
      target,
      threadId: "thread-1",
      status: "idle",
    });
    await flushEventBus();

    await manager.start();
    await aggregateStarted;
    // 完成事件还在等指标库，后到达的状态事件必须排队，不能插到完成卡前面。
    expect(received).toEqual([]);
    releaseAggregate();
    await flushEventBus();

    expect(received).toEqual(["turn.completed", "thread.status"]);
    await manager.stop();
    await output.close();
  });

  it("waits for an asynchronous task aggregate before delivery", async () => {
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
      sessionAggregate: () => {
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
        };
      },
      sessionAggregate: (threadId) => {
        order.push(`session-${threadId}`);
        return {
          requestCount: 2,
          unsuccessfulRequestCount: 0,
          inputTokens: 1_000,
          cachedInputTokens: 800,
          outputTokens: 100,
          reasoningOutputTokens: 0,
        };
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
      "session-thread-1",
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
        sessionAggregate: expect.objectContaining({
          requestCount: 2,
          inputTokens: 1_000,
          cachedInputTokens: 800,
          outputTokens: 100,
        }),
      }),
    ]);

    await manager.stop();
    await output.close();
  });

  it("bounds completion metric reads so a stalled store cannot block routing", async () => {
    vi.useFakeTimers();
    try {
      const feishu = surface("feishu", "tenant-a", []);
      const received: OutputEvent[] = [];
      feishu.output.handle = (event) => {
        received.push(event);
      };
      const output = new EventBus<OutputEvent>(logger);
      const manager = createManager([feishu], output, {
        taskAggregate: () => new Promise(() => {}),
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
      await settle();
      expect(received).toEqual([]);

      await vi.advanceTimersByTimeAsync(250);
      await settle();
      expect(received).toEqual([
        expect.objectContaining({ type: "turn.completed" }),
      ]);
      expect(received[0]).not.toHaveProperty("taskAggregate");

      await manager.stop();
      await output.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["pending", "synchronous"])("skips later metric reads after a %s timeout and handles late rejection", async (mode) => {
    vi.useFakeTimers();
    const received: OutputEvent[] = [];
    let markDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => { markDelivered = resolve; });
    const feishu = surface("feishu", "tenant-a", []);
    feishu.output.handle = (event) => {
      received.push(event);
      if (event.type === "warning") markDelivered();
    };
    let rejectTiming!: (error: Error) => void;
    const taskAggregate = vi.fn(async () => undefined);
    const sessionAggregate = vi.fn(async () => undefined);
    const output = new EventBus<OutputEvent>(logger);
    const manager = createManager([feishu], output, {
      completionTiming: () => {
        if (mode === "synchronous") vi.setSystemTime(Date.now() + 250);
        return new Promise((_resolve, reject) => { rejectTiming = reject; });
      },
      taskAggregate,
      sessionAggregate,
    });
    await manager.start();
    const target = { surface: "feishu", accountId: "tenant-a", conversationId: "chat-1" };
    output.publish({
      type: "turn.completed", target, threadId: "thread-1", turnId: "turn-1",
      status: "completed", timing: { modelRequestCount: 7 },
    });
    output.publish({ type: "warning", target, threadId: "thread-1", message: "next output" });
    await settle();
    if (mode === "pending") await vi.advanceTimersByTimeAsync(250);
    await delivered;
    expect(taskAggregate).not.toHaveBeenCalled();
    expect(sessionAggregate).not.toHaveBeenCalled();
    expect(received).toEqual([
      expect.objectContaining({ type: "turn.completed", timing: { modelRequestCount: 7 } }),
      expect.objectContaining({ type: "warning" }),
    ]);
    // Vitest reports any unhandled rejection, including queries that outlive delivery.
    rejectTiming(new Error("metrics failed after delivery"));
    await vi.advanceTimersByTimeAsync(1);
    await manager.stop();
    await output.close();
  });

  it("delivers an unenriched completion card when enrichment itself fails", async () => {
    const feishu = surface("feishu", "tenant-a", []);
    const received: OutputEvent[] = [];
    const warnings: string[] = [];
    feishu.output.handle = (event) => {
      received.push(event);
    };
    const output = new EventBus<OutputEvent>(logger);
    const manager = new SurfaceManager(
      [feishu],
      output,
      {
        debug() {},
        info() {},
        warn: (_fields: Record<string, unknown>, message: string) => {
          warnings.push(message);
        },
        error() {},
      } as unknown as Logger,
      () => {
        throw new Error("git branch lookup failed");
      },
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
    await flushEventBus();

    expect(warnings).toContain("Turn 完成统计富化失败，改用未富化输出");
    expect(received).toEqual([
      expect.objectContaining({ type: "turn.completed", turnId: "turn-1" }),
    ]);
    expect(received[0]).not.toHaveProperty("gitBranch");
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

/**
 * 等待排队的输出路由与投递链结束。冻结定时器时只能推进微任务，真实定时器下排空一个宏
 * 任务，覆盖投递链里异步富化引入的额外跳转。
 */
async function settle(): Promise<void> {
  if (!vi.isFakeTimers()) {
    await flushEventBus();
    return;
  }
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

async function flushEventBus(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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
