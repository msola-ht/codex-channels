import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AccountRateLimits } from "../src/application/index.js";
import { GatewayApplication } from "../src/bootstrap/app.js";

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
      "close:surface",
      "close:model-pricing",
      "close:inbound",
      "close:output",
      "close:codex",
      "close:bindings",
    ]);
  });

  it("does not start a Surface when stop is requested during startup", async () => {
    let resolveRateLimits!: (value: AccountRateLimits) => void;
    const rateLimits = new Promise<AccountRateLimits>((resolve) => {
      resolveRateLimits = resolve;
    });
    const closes = {
      bindings: 0,
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
});
