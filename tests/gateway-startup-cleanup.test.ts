import pino from "pino";
import { describe, expect, it } from "vitest";

import { GatewayApplication } from "../src/bootstrap/app.js";

describe("GatewayApplication startup cleanup", () => {
  it("closes every initialized component and preserves the startup error", async () => {
    const calls: string[] = [];
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
        config: { codexSocketPath: "/tmp/codex.sock" },
        logger: pino({ level: "silent" }),
        transport: { kind: "unix-websocket" },
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
          accountRateLimits: async () => ({
            rateLimits: { limitId: "codex", primary: null, secondary: null },
            rateLimitsByLimitId: {},
          }),
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
      "listen:notification",
      "listen:disconnect",
      "connect:codex",
      "start:surface",
      "remove:notification",
      "remove:disconnect",
      "close:surface",
      "close:inbound",
      "close:output",
      "close:codex",
      "close:bindings",
    ]);
  });

  it("does not start a Surface when stop is requested during startup", async () => {
    let resolveRateLimits!: (value: {
      rateLimits: { limitId: string; primary: null; secondary: null };
      rateLimitsByLimitId: Record<string, never>;
    }) => void;
    const rateLimits = new Promise<{
      rateLimits: { limitId: string; primary: null; secondary: null };
      rateLimitsByLimitId: Record<string, never>;
    }>((resolve) => {
      resolveRateLimits = resolve;
    });
    let surfaceStarts = 0;
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
      config: { codexSocketPath: "/tmp/codex.sock" },
      logger: pino({ level: "silent" }),
      transport: { kind: "unix-websocket" },
      stopping: false,
      codex: {
        onNotification: () => () => undefined,
        onDisconnect: () => () => undefined,
        connect: async () => ({
          userAgent: "test",
          platformFamily: "unix",
          platformOs: "linux",
        }),
        accountRateLimits: () => rateLimits,
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
        stop: async () => undefined,
      },
      bindings: {
        close: () => undefined,
      },
    });
    const gateway = application as unknown as GatewayApplication;

    const starting = gateway.start();
    await Promise.resolve();
    const stopping = gateway.stop();
    resolveRateLimits({
      rateLimits: { limitId: "codex", primary: null, secondary: null },
      rateLimitsByLimitId: {},
    });

    await expect(starting).rejects.toThrow("Gateway 正在停止");
    await expect(stopping).resolves.toBeUndefined();
    expect(surfaceStarts).toBe(0);
  });

  it("cancels and awaits the reconnect task during shutdown", async () => {
    let disconnect: ((error: Error) => void) | undefined;
    let reconnectAttempts = 0;
    const application = Object.create(
      GatewayApplication.prototype,
    ) as unknown as Record<string, unknown>;
    Object.assign(application, {
      config: { codexSocketPath: "/tmp/codex.sock" },
      logger: pino({ level: "silent" }),
      transport: { kind: "unix-websocket" },
      stopping: false,
      codex: {
        onNotification: () => () => undefined,
        onDisconnect: (handler: (error: Error) => void) => {
          disconnect = handler;
          return () => undefined;
        },
        connect: async () => ({
          userAgent: "test",
          platformFamily: "unix",
          platformOs: "linux",
        }),
        reconnect: async () => {
          reconnectAttempts += 1;
          throw new Error("offline");
        },
        accountRateLimits: async () => ({
          rateLimits: { limitId: "codex", primary: null, secondary: null },
          rateLimitsByLimitId: {},
        }),
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

    disconnect?.(new Error("connection lost"));
    await Promise.resolve();
    await Promise.resolve();

    await expect(gateway.stop()).resolves.toBeUndefined();
    expect(reconnectAttempts).toBe(1);
  });
});
