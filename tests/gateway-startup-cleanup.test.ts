import pino from "pino";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AccountRateLimits } from "../src/application/index.js";
import { GatewayApplication } from "../src/bootstrap/app.js";
import {
  inspectThreadWriterLock,
  terminateThreadWriterHolder,
} from "../runtime/thread-writer-lock.mjs";
import {
  AppServerSupervisorOwner,
  releaseAppServerProvider,
} from "../runtime/app-server-supervisor.mjs";

const unixSocketTmpdir = process.platform === "darwin" ? "/tmp" : tmpdir();

vi.mock("../runtime/thread-writer-lock.mjs", () => ({
  inspectThreadWriterLock: vi.fn(),
  terminateThreadWriterHolder: vi.fn(),
}));

function emptyRateLimits(): AccountRateLimits {
  return {
    limits: [{
      limitId: "codex",
      limitName: null,
      primary: null,
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    }],
    resetCreditsAvailable: null,
  };
}

interface RestoreTestTarget {
  surface: "feishu";
  accountId: string;
  conversationId: string;
}

interface RestoreTestBinding {
  target: RestoreTestTarget;
  workspaceId: string;
  threadId: string;
  sessionId: string;
}

interface RestoredTestThread {
  id: string;
  status: { type: "idle" };
  activeTurnId: null;
}

function createRestoreApplication(options: {
  target: RestoreTestTarget;
  binding: RestoreTestBinding;
  published: unknown[];
  restoreSubscriptions: (
    shouldRestore: (
      candidateTarget: RestoreTestTarget,
      candidateBinding: RestoreTestBinding,
    ) => boolean,
    onRestored: (
      candidateBinding: RestoreTestBinding,
      thread: RestoredTestThread,
    ) => void,
  ) => Promise<unknown[]>;
  overrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    binding,
    published,
    restoreSubscriptions,
    overrides = {},
  } = options;
  return {
    config: { codexSocketPath: "/tmp/codex.sock" },
    logger: pino({ level: "silent" }),
    transport: { kind: "unix-websocket" },
    primaryProvider: "openai",
    probeOpenAiConnectivity: async () => "reachable" as const,
    providerMetrics: {
      start: async () => undefined,
      close: async () => undefined,
    },
    modelPricing: {
      start: () => undefined,
      close: () => undefined,
    },
    modelPricingNeedsExchangeRate: false,
    exchangeRate: {
      start: () => undefined,
      close: () => undefined,
    },
    metricsSync: {
      close: async () => undefined,
    },
    stopping: false,
    disconnectedProviders: new Set<string>(),
    disconnectedBindingsByProvider: new Map<string, Set<string>>(),
    pendingBindingRestores: new Map(),
    restoringThreadIds: new Set<string>(),
    bindingRestoreAttempt: 0,
    codex: {
      onNotification: () => () => undefined,
      onDisconnect: () => () => undefined,
      connect: async () => ({
        userAgent: "test",
        platformFamily: "unix",
        platformOs: "linux",
      }),
      knownProvider: () => "openai",
      accountRateLimits: async () => emptyRateLimits(),
      close: async () => undefined,
    },
    inbound: {
      publish: () => undefined,
      close: async () => undefined,
    },
    output: {
      publish: (event: unknown) => published.push(event),
      close: async () => undefined,
    },
    interactions: {
      cancelAll: () => undefined,
    },
    core: {
      rememberRateLimits: () => undefined,
      connectionLost: () => undefined,
      connectionRestored: () => undefined,
    },
    router: {
      restoreSubscriptions,
      allBindings: () => [binding],
      isBackgroundThread: () => false,
    },
    surfaces: [{ surface: "feishu", accountId: "default" }],
    surfaceManager: {
      start: async () => undefined,
      stop: async () => undefined,
    },
    channelImageSpool: {
      start: async () => undefined,
      stop: async () => undefined,
    },
    bindings: {
      close: () => undefined,
    },
    ...overrides,
  };
}

describe("GatewayApplication startup cleanup", () => {
  it("delegates a Surface fatal error without stopping the Gateway", () => {
    const reportFatal = vi.fn();
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
      stopping: false,
      surfaceManager: { reportFatal },
    });
    const handleSurfaceFatal = Reflect.get(
      GatewayApplication.prototype,
      "handleSurfaceFatal",
    ) as (
      this: GatewayApplication,
      surface: string,
      accountId: string,
      error: Error,
    ) => void;
    const error = new Error("offline");

    handleSurfaceFatal.call(
      application as unknown as GatewayApplication,
      "telegram",
      "default",
      error,
    );

    expect(reportFatal).toHaveBeenCalledWith("telegram", "default", error);
  });

  it("closes every initialized component and preserves the startup error", async () => {
    const calls: string[] = [];
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
        activeCostProviders: [],
        config: { codexSocketPath: "/tmp/codex.sock" },
        logger: pino({ level: "silent" }),
        transport: { kind: "unix-websocket" },
        providerMetrics: {
          start: async () => undefined,
          close: async () => undefined,
        },
        modelPricing: {
          start: () => calls.push("start:model-pricing"),
          close: () => calls.push("close:model-pricing"),
        },
        exchangeRate: {
          start: () => undefined,
          close: () => undefined,
        },
        metricsSync: {
          close: async () => undefined,
        },
        stopping: false,
        reconnecting: undefined,
        codex: {
          onNotification: () => {
            calls.push("listen:notification");
            return () => calls.push("remove:notification");
          },
          onDisconnect: () => {
            calls.push("listen:disconnect");
            return () => calls.push("remove:disconnect");
          },
          connect: async () => {
            calls.push("connect:codex");
            return {
              userAgent: "test",
              platformFamily: "unix",
              platformOs: "linux",
            };
          },
          accountRateLimits: async () => emptyRateLimits(),
          close: async () => {
            calls.push("close:codex");
            throw new Error("codex close failed");
          },
        },
        inbound: {
          publish: () => undefined,
          close: async () => {
            calls.push("close:inbound");
          },
        },
        output: {
          close: async () => {
            calls.push("close:output");
          },
        },
        interactions: {
          cancelAll: () => undefined,
        },
        core: {
          rememberRateLimits: () => undefined,
          connectionLost: () => undefined,
        },
        router: {
          restoreSubscriptions: async () => [],
          allBindings: () => [],
        },
        surfaces: [],
        surfaceManager: {
          start: async () => {
            calls.push("start:surface");
            throw new Error("surface start failed");
          },
          stop: async () => {
            calls.push("close:surface");
          },
        },
        channelImageSpool: {
          start: async () => {
            calls.push("start:channel-image-spool");
          },
          stop: async () => {
            calls.push("close:channel-image-spool");
          },
        },
        bindings: {
          close: () => {
            calls.push("close:bindings");
          },
        },
      });

    await expect(
      (application as unknown as GatewayApplication).start(),
    ).rejects.toThrow("surface start failed");

    expect(calls).toEqual([
      "start:model-pricing",
      "listen:notification",
      "listen:disconnect",
      "connect:codex",
      "start:surface",
      "remove:notification",
      "remove:disconnect",
      "close:channel-image-spool",
      "close:surface",
      "close:model-pricing",
      "close:inbound",
      "close:output",
      "close:codex",
      "close:bindings",
    ]);
  });

  it("starts while a bound Thread has another writer and reports automatic recovery", async () => {
    vi.useFakeTimers();
    const target = {
      surface: "feishu" as const,
      accountId: "default",
      conversationId: "chat-1",
    };
    const binding = {
      target,
      workspaceId: "main",
      threadId: "thread-occupied",
      sessionId: "thread-occupied",
    };
    const published: unknown[] = [];
    let restoreCalls = 0;
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, createRestoreApplication({
      target,
      binding,
      published,
      restoreSubscriptions: async (
        shouldRestore,
        onRestored,
      ) => {
        if (!shouldRestore(target, binding)) {
          return [];
        }
        restoreCalls += 1;
        if (restoreCalls === 1) {
          return [{
            binding,
            error: new Error("thread thread-occupied already has an active writer"),
            bindingRemoved: false,
            reason: "active-writer" as const,
          }];
        }
        if (restoreCalls === 2) {
          return [{
            binding,
            error: new Error("temporary reconnect failure"),
            bindingRemoved: false,
            reason: "other" as const,
          }];
        }
        onRestored(binding, {
          id: binding.threadId,
          status: { type: "idle" },
          activeTurnId: null,
        });
        return [];
      },
    }));
    const gateway = application as unknown as GatewayApplication;

    try {
      await expect(gateway.start()).resolves.toBeUndefined();
      expect(published).toContainEqual(expect.objectContaining({
        type: "thread.availability",
        availability: "occupied",
        threadId: binding.threadId,
      }));

      await vi.runOnlyPendingTimersAsync();

      expect(restoreCalls).toBe(2);
      expect(published.filter((event) =>
        typeof event === "object"
        && event !== null
        && "availability" in event
        && event.availability === "occupied"
      )).toHaveLength(1);

      await vi.runOnlyPendingTimersAsync();

      expect(restoreCalls).toBe(3);
      expect(published).toContainEqual(expect.objectContaining({
        type: "thread.availability",
        availability: "available",
        threadId: binding.threadId,
      }));
    } finally {
      await gateway.stop();
      vi.useRealTimers();
    }
  });

  it("escalates repeated unknown restore failures to an occupied notification", async () => {
    vi.useFakeTimers();
    const target = {
      surface: "feishu" as const,
      accountId: "default",
      conversationId: "chat-escalated",
    };
    const binding = {
      target,
      workspaceId: "main",
      threadId: "thread-escalated",
      sessionId: "thread-escalated",
    };
    const published: unknown[] = [];
    let restoreCalls = 0;
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, createRestoreApplication({
      target,
      binding,
      published,
      restoreSubscriptions: async (
        shouldRestore,
        onRestored,
      ) => {
        if (!shouldRestore(target, binding)) {
          return [];
        }
        restoreCalls += 1;
        if (restoreCalls <= 3) {
          return [{
            binding,
            error: new Error("temporary reconnect failure"),
            bindingRemoved: false,
            reason: "other" as const,
          }];
        }
        onRestored(binding, {
          id: binding.threadId,
          status: { type: "idle" },
          activeTurnId: null,
        });
        return [];
      },
    }));
    const gateway = application as unknown as GatewayApplication;
    const occupied = () => published.filter((event) =>
      typeof event === "object"
      && event !== null
      && "availability" in event
      && event.availability === "occupied"
    );

    try {
      await expect(gateway.start()).resolves.toBeUndefined();
      expect(restoreCalls).toBe(1);
      expect(occupied()).toHaveLength(0);

      await vi.runOnlyPendingTimersAsync();
      expect(restoreCalls).toBe(2);
      expect(occupied()).toHaveLength(0);

      await vi.runOnlyPendingTimersAsync();
      expect(restoreCalls).toBe(3);
      expect(occupied()).toHaveLength(1);
      expect(published).toContainEqual(expect.objectContaining({
        type: "thread.availability",
        availability: "occupied",
        threadId: binding.threadId,
      }));

      await vi.runOnlyPendingTimersAsync();
      expect(restoreCalls).toBe(4);
      expect(published).toContainEqual(expect.objectContaining({
        type: "thread.availability",
        availability: "available",
        threadId: binding.threadId,
      }));
    } finally {
      await gateway.stop();
      vi.useRealTimers();
    }
  });

  it("releases an occupied Thread only after /release force confirms the holder", async () => {
    const target = {
      surface: "feishu" as const,
      accountId: "default",
      conversationId: "chat-release",
    };
    const binding = {
      target,
      workspaceId: "main",
      threadId: "thread-release",
      sessionId: "thread-release",
    };
    const published: unknown[] = [];
    let restoreCalls = 0;
    vi.mocked(inspectThreadWriterLock).mockClear();
    vi.mocked(terminateThreadWriterHolder).mockClear();
    vi.mocked(inspectThreadWriterLock).mockReturnValue({
      held: true,
      holder: {
        pid: 4242,
        command: "codex app-server --listen unix:///tmp/codex.sock",
      },
    });
    vi.mocked(terminateThreadWriterHolder).mockResolvedValue(true);
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, createRestoreApplication({
      target,
      binding,
      published,
      restoreSubscriptions: async () => {
        restoreCalls += 1;
        return [];
      },
      overrides: {
        router: {
          current: () => binding,
          restoreSubscriptions: async () => {
            restoreCalls += 1;
            return [];
          },
          allBindings: () => [binding],
          isBackgroundThread: () => false,
        },
        pendingBindingRestores: new Map([
          ["thread-release", {
            binding,
            occupiedNotified: true,
            failureCount: 2,
          }],
        ]),
        bindingRestoreAttempt: 1,
      },
    }));
    const releaseThread = Reflect.get(
      GatewayApplication.prototype,
      "releaseThread",
    ) as (
      this: GatewayApplication,
      target: unknown,
      force?: boolean,
    ) => Promise<unknown>;

    const held = await releaseThread.call(
      application as unknown as GatewayApplication,
      target,
      false,
    );
    expect(held).toEqual({
      status: "held",
      threadId: binding.threadId,
      holder: {
        pid: 4242,
        command: "codex app-server --listen unix:///tmp/codex.sock",
      },
      releasable: true,
      stuck: true,
    });
    expect(vi.mocked(terminateThreadWriterHolder)).not.toHaveBeenCalled();
    expect(restoreCalls).toBe(0);

    const released = await releaseThread.call(
      application as unknown as GatewayApplication,
      target,
      true,
    );
    expect(released).toEqual({
      status: "released",
      threadId: binding.threadId,
      holder: {
        pid: 4242,
        command: "codex app-server --listen unix:///tmp/codex.sock",
      },
    });
    expect(vi.mocked(terminateThreadWriterHolder)).toHaveBeenCalledWith(4242);
    expect(restoreCalls).toBe(1);
  });

  it("reports unbound, free, unidentifiable and non-releasable occupancy states", async () => {
    const target = {
      surface: "feishu" as const,
      accountId: "default",
      conversationId: "chat-release-states",
    };
    const binding = {
      target,
      workspaceId: "main",
      threadId: "thread-release-states",
      sessionId: "thread-release-states",
    };
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, createRestoreApplication({
      target,
      binding,
      published: [],
      restoreSubscriptions: async () => [],
      overrides: {
        router: {
          current: (candidate: { conversationId: string }) =>
            candidate.conversationId === target.conversationId ? binding : undefined,
          restoreSubscriptions: async () => [],
          allBindings: () => [binding],
          isBackgroundThread: () => false,
        },
      },
    }));
    const releaseThread = Reflect.get(
      GatewayApplication.prototype,
      "releaseThread",
    ) as (
      this: GatewayApplication,
      target: unknown,
      force?: boolean,
    ) => Promise<unknown>;

    const unbound = await releaseThread.call(
      application as unknown as GatewayApplication,
      { ...target, conversationId: "chat-other" },
      true,
    );
    expect(unbound).toEqual({ status: "unbound" });

    vi.mocked(inspectThreadWriterLock).mockReturnValue({ held: false });
    const free = await releaseThread.call(
      application as unknown as GatewayApplication,
      target,
      true,
    );
    expect(free).toEqual({ status: "free", threadId: binding.threadId });

    vi.mocked(inspectThreadWriterLock).mockReturnValue({ held: true, holder: null });
    const unidentifiable = await releaseThread.call(
      application as unknown as GatewayApplication,
      target,
      true,
    );
    expect(unidentifiable).toEqual({
      status: "unidentifiable",
      threadId: binding.threadId,
    });

    vi.mocked(terminateThreadWriterHolder).mockClear();
    vi.mocked(inspectThreadWriterLock).mockReturnValue({
      held: true,
      holder: { pid: 555, command: "other-daemon --worker" },
    });
    const held = await releaseThread.call(
      application as unknown as GatewayApplication,
      target,
      true,
    );
    expect(held).toEqual({
      status: "held",
      threadId: binding.threadId,
      holder: { pid: 555, command: "other-daemon --worker" },
      releasable: false,
      stuck: false,
    });
    expect(vi.mocked(terminateThreadWriterHolder)).not.toHaveBeenCalled();

    vi.mocked(inspectThreadWriterLock).mockReturnValue({
      held: true,
      holder: { pid: 556, command: "node /tmp/codex-helper.js --worker" },
    });
    const misleadingCommand = await releaseThread.call(
      application as unknown as GatewayApplication,
      target,
      true,
    );
    expect(misleadingCommand).toEqual({
      status: "held",
      threadId: binding.threadId,
      holder: { pid: 556, command: "node /tmp/codex-helper.js --worker" },
      releasable: false,
      stuck: false,
    });
    expect(vi.mocked(terminateThreadWriterHolder)).not.toHaveBeenCalled();

    vi.mocked(inspectThreadWriterLock)
      .mockReturnValueOnce({
        held: true,
        holder: { pid: 557, command: "codex app-server" },
      })
      .mockReturnValueOnce({
        held: true,
        holder: { pid: 557, command: "other-daemon --worker" },
      });
    const changedCommand = await releaseThread.call(
      application as unknown as GatewayApplication,
      target,
      true,
    );
    expect(changedCommand).toEqual({
      status: "held",
      threadId: binding.threadId,
      holder: { pid: 557, command: "other-daemon --worker" },
      releasable: false,
      stuck: false,
    });
    expect(vi.mocked(terminateThreadWriterHolder)).not.toHaveBeenCalled();
  });

  it("does not start a Surface when stop is requested during startup", async () => {
    let resolveRateLimits!: (value: AccountRateLimits) => void;
    const rateLimits = new Promise<AccountRateLimits>((resolve) => {
      resolveRateLimits = resolve;
    });
    const closes = {
      bindings: 0,
      channelImageSpool: 0,
      codex: 0,
      inbound: 0,
      output: 0,
      surface: 0,
    };
    let surfaceStarts = 0;
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
      activeCostProviders: [],
      config: { codexSocketPath: "/tmp/codex.sock" },
      logger: pino({ level: "silent" }),
      transport: { kind: "unix-websocket" },
      providerMetrics: {
        start: async () => undefined,
        close: async () => undefined,
      },
      modelPricing: {
        start: () => undefined,
        close: () => undefined,
      },
      exchangeRate: {
        start: () => undefined,
        close: () => undefined,
      },
      metricsSync: {
        close: async () => undefined,
      },
      stopping: false,
      disconnectedProviders: new Set<string>(),
      disconnectedBindingsByProvider: new Map<string, Set<string>>(),
      pendingBindingRestores: new Map(),
      restoringThreadIds: new Set<string>(),
      bindingRestoreAttempt: 0,
      codex: {
        onNotification: () => () => undefined,
        onDisconnect: () => () => undefined,
        connect: async () => ({
          userAgent: "test",
          platformFamily: "unix",
          platformOs: "linux",
        }),
        accountRateLimits: () => rateLimits,
        close: async () => {
          closes.codex += 1;
        },
      },
      inbound: {
        publish: () => undefined,
        close: async () => {
          closes.inbound += 1;
        },
      },
      output: {
        close: async () => {
          closes.output += 1;
        },
      },
      interactions: {
        cancelAll: () => undefined,
      },
      core: {
        rememberRateLimits: () => undefined,
        connectionLost: () => undefined,
        connectionRestored: () => undefined,
      },
      router: {
        restoreSubscriptions: async () => [],
        allBindings: () => [],
      },
      surfaces: [],
      surfaceManager: {
        start: async () => {
          surfaceStarts += 1;
        },
        stop: async () => {
          closes.surface += 1;
        },
      },
      channelImageSpool: {
        start: async () => undefined,
        stop: async () => {
          closes.channelImageSpool += 1;
        },
      },
      bindings: {
        close: () => {
          closes.bindings += 1;
        },
      },
    });
    const gateway = application as unknown as GatewayApplication;

    const starting = gateway.start();
    await Promise.resolve();
    const stopping = gateway.stop();
    resolveRateLimits(emptyRateLimits());

    await expect(starting).rejects.toThrow("Gateway 正在停止");
    await expect(stopping).resolves.toBeUndefined();
    expect(surfaceStarts).toBe(0);
    expect(closes).toEqual({
      bindings: 1,
      channelImageSpool: 1,
      codex: 2,
      inbound: 1,
      output: 1,
      surface: 1,
    });
  });

  it("cancels and awaits the reconnect task during shutdown", async () => {
    let disconnect: ((error: Error, provider: string) => void) | undefined;
    let reconnectAttempts = 0;
    let cancelAllCalls = 0;
    const cancelledThreadSets: ReadonlySet<string>[] = [];
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
      activeCostProviders: [],
      config: { codexSocketPath: "/tmp/codex.sock" },
      logger: pino({ level: "silent" }),
      transport: { kind: "unix-websocket" },
      providerMetrics: {
        start: async () => undefined,
        close: async () => undefined,
      },
      modelPricing: {
        start: () => undefined,
        close: () => undefined,
      },
      exchangeRate: {
        start: () => undefined,
        close: () => undefined,
      },
      metricsSync: {
        close: async () => undefined,
      },
      stopping: false,
      disconnectedProviders: new Set<string>(),
      disconnectedBindingsByProvider: new Map<string, Set<string>>(),
      pendingBindingRestores: new Map(),
      restoringThreadIds: new Set<string>(),
      bindingRestoreAttempt: 0,
      codex: {
        onNotification: () => () => undefined,
        onDisconnect: (handler: (error: Error, provider: string) => void) => {
          disconnect = handler;
          return () => undefined;
        },
        connect: async () => ({
          userAgent: "test",
          platformFamily: "unix",
          platformOs: "linux",
        }),
        reconnectProvider: async () => {
          reconnectAttempts += 1;
          throw new Error("offline");
        },
        knownProvider: () => "openai",
        closeProvider: async () => undefined,
        accountRateLimits: async () => emptyRateLimits(),
        close: async () => undefined,
      },
      inbound: {
        publish: () => undefined,
        close: async () => undefined,
      },
      output: {
        close: async () => undefined,
      },
      interactions: {
        cancelAll: () => {
          cancelAllCalls += 1;
        },
        cancelThreads: (threadIds: ReadonlySet<string>) => {
          cancelledThreadSets.push(threadIds);
        },
      },
      core: {
        rememberRateLimits: () => undefined,
        connectionLost: () => undefined,
        connectionRestored: () => undefined,
      },
      router: {
        restoreSubscriptions: async () => [],
        allBindings: () => [],
      },
      surfaces: [],
      surfaceManager: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      channelImageSpool: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      bindings: {
        close: () => undefined,
      },
    });
    const gateway = application as unknown as GatewayApplication;
    await gateway.start();

    disconnect?.(new Error("connection lost"), "openai");
    await Promise.resolve();
    await Promise.resolve();

    await expect(gateway.stop()).resolves.toBeUndefined();
    expect(reconnectAttempts).toBe(1);
    expect(cancelAllCalls).toBe(0);
    expect(cancelledThreadSets).toEqual([new Set()]);
  });

  it("does not reconnect a Provider intentionally released by the supervisor", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-gateway-release-"));
    const socketPath = join(runtimeDir, "codex-app-server.sock");
    const owner = new AppServerSupervisorOwner(socketPath, {
      primaryProvider: "openai",
      managedProviders: ["opencode-go-b"],
      socketPaths: [socketPath, join(runtimeDir, "codex-app-server-opencode-go-b.sock")],
    }, {
      releaseProvider: async () => true,
    });
    await owner.start();
    let disconnect: ((error: Error, provider: string) => void) | undefined;
    const reconnectProvider = vi.fn(async () => ({
      userAgent: "test",
      platformFamily: "unix" as const,
      platformOs: "linux" as const,
    }));
    const closeProvider = vi.fn(async () => undefined);
    const connectionLost = vi.fn();
    const target = {
      surface: "feishu" as const,
      accountId: "default",
      conversationId: "conversation-1",
    };
    const binding = {
      target,
      workspaceId: "workspace-1",
      threadId: "thread-1",
      sessionId: "session-1",
    };
    const application = Object.create(GatewayApplication.prototype);
    Object.assign(application, createRestoreApplication({
      target,
      binding,
      published: [],
      restoreSubscriptions: async () => [],
      overrides: {
        config: { codexSocketPath: socketPath },
        codex: {
          onNotification: () => () => undefined,
          onDisconnect: (handler: (error: Error, provider: string) => void) => {
            disconnect = handler;
            return () => undefined;
          },
          connect: async () => ({
            userAgent: "test",
            platformFamily: "unix" as const,
            platformOs: "linux" as const,
          }),
          reconnectProvider,
          knownProvider: () => "opencode-go-b",
          closeProvider,
          accountRateLimits: async () => emptyRateLimits(),
          close: async () => undefined,
        },
        interactions: {
          cancelAll: () => undefined,
          cancelThreads: () => undefined,
        },
        core: {
          rememberRateLimits: () => undefined,
          connectionLost,
          connectionRestored: () => undefined,
        },
      },
    }));
    const gateway = application as GatewayApplication;

    try {
      await gateway.start();
      await releaseAppServerProvider(socketPath, "opencode-go-b");
      disconnect?.(new Error("connection closed"), "opencode-go-b");

      await vi.waitFor(() => expect(closeProvider).toHaveBeenCalledWith("opencode-go-b"));
      expect(reconnectProvider).not.toHaveBeenCalled();
      expect(connectionLost).toHaveBeenCalledWith(
        expect.stringContaining("主动停止"),
        new Set(["thread-1"]),
      );
    } finally {
      await gateway.stop();
      await owner.close();
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("notifies affected threads after a Provider reconnects", async () => {
    let disconnect: ((error: Error, provider: string) => void) | undefined;
    const restoredNotices: Array<{
      message: string;
      threadIds: ReadonlySet<string>;
    }> = [];
    const application = Object.create(GatewayApplication.prototype);
    Object.assign(application, {
      activeCostProviders: [],
      config: { codexSocketPath: "/tmp/codex.sock" },
      logger: pino({ level: "silent" }),
      transport: { kind: "unix-websocket" },
      providerMetrics: {
        start: async () => undefined,
        close: async () => undefined,
      },
      modelPricing: {
        start: () => undefined,
        close: () => undefined,
      },
      exchangeRate: {
        start: () => undefined,
        close: () => undefined,
      },
      metricsSync: {
        close: async () => undefined,
      },
      stopping: false,
      disconnectedProviders: new Set<string>(),
      disconnectedBindingsByProvider: new Map<string, Set<string>>(),
      pendingBindingRestores: new Map(),
      restoringThreadIds: new Set<string>(),
      bindingRestoreAttempt: 0,
      codex: {
        onNotification: () => () => undefined,
        onDisconnect: (handler: (error: Error, provider: string) => void) => {
          disconnect = handler;
          return () => undefined;
        },
        connect: async () => ({
          userAgent: "test",
          platformFamily: "unix",
          platformOs: "linux",
        }),
        reconnectProvider: async () => ({
          userAgent: "test",
          platformFamily: "unix",
          platformOs: "linux",
        }),
        knownProvider: () => "openai",
        closeProvider: async () => undefined,
        accountRateLimits: async () => emptyRateLimits(),
        close: async () => undefined,
      },
      inbound: {
        publish: () => undefined,
        close: async () => undefined,
      },
      output: {
        close: async () => undefined,
      },
      interactions: {
        cancelAll: () => undefined,
        cancelThreads: () => undefined,
      },
      core: {
        rememberRateLimits: () => undefined,
        connectionLost: () => undefined,
        connectionRestored: (message: string, threadIds: ReadonlySet<string>) => {
          restoredNotices.push({ message, threadIds });
        },
      },
      router: {
        restoreSubscriptions: async () => [],
        allBindings: () => [{
          target: {
            surface: "feishu",
            accountId: "default",
            conversationId: "conversation-1",
          },
          threadId: "thread-1",
        }],
      },
      surfaces: [{ surface: "feishu", accountId: "default" }],
      surfaceManager: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      channelImageSpool: {
        start: async () => undefined,
        stop: async () => undefined,
      },
      bindings: {
        close: () => undefined,
      },
    });
    const gateway = application as unknown as GatewayApplication;
    await gateway.start();

    disconnect?.(new Error("connection lost"), "openai");
    await vi.waitFor(() => {
      expect(restoredNotices).toEqual([{
        message: "openai App Server 已重新连接",
        threadIds: new Set(["thread-1"]),
      }]);
    });

    await expect(gateway.stop()).resolves.toBeUndefined();
  });
});
