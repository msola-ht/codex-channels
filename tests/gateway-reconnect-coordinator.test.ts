import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatewayReconnectCoordinator, type GatewayReconnectOptions } from "../src/bootstrap/gateway-reconnect-coordinator.js";

import { CodexAppServerClient, JsonRpcClient, ProviderRoutingClient } from "../src/codex-client/index.js";
import { FakeTransport } from "./support/json-rpc-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const initialized = { userAgent: "fixture", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" };
function fixture() {
  const disconnected = new Map<string, ReadonlySet<string>>();
  const options = {
    codex: {
      knownProvider: () => "openai",
      reconnectProvider: vi.fn<GatewayReconnectOptions["codex"]["reconnectProvider"]>(async () => initialized),
      closeProvider: vi.fn(async () => undefined),
    },
    router: { allBindings: () => [{ threadId: "thread-1", sessionId: "thread-1", workspaceId: "workspace",
      target: { surface: "feishu", accountId: "default", conversationId: "chat" } }] },
    core: { connectionLost: vi.fn(), connectionRestored: vi.fn() },
    interactions: { cancelThreads: vi.fn() },
    bindings: {
      hasDisconnectedProviders: () => disconnected.size > 0,
      nextDisconnectedProvider: () => disconnected.keys().next().value,
      markProviderDisconnected: (provider: string, ids: ReadonlySet<string>) => { disconnected.set(provider, ids); },
      completeProviderReconnect: vi.fn((provider: string) => { disconnected.delete(provider); }),
      affectedThreadsForProvider: (provider: string) => disconnected.get(provider),
      restore: vi.fn(async (): Promise<void> => undefined),
      schedule: vi.fn(),
    },
    logger: pino({ level: "silent" }),
    isStopping: () => false,
    cancelQuestions: vi.fn(),
    intentionallyReleased: vi.fn(async () => false),
    connected: vi.fn(async () => undefined),
    requestStop: vi.fn(async () => undefined),
  } satisfies GatewayReconnectOptions;
  const coordinator = new GatewayReconnectCoordinator(options);
  return { coordinator, options, disconnected };
}

afterEach(() => vi.useRealTimers());

describe("Gateway 重连协调", () => {
  it("coalesces duplicate disconnect inspection and recovers affected threads", async () => {
    const { coordinator, options } = fixture();
    const inspection = deferred<boolean>();
    options.intentionallyReleased.mockReturnValue(inspection.promise);
    coordinator.disconnected(new Error("lost"), "openai");
    coordinator.disconnected(new Error("duplicate"), "openai");
    expect(options.intentionallyReleased).toHaveBeenCalledTimes(1);
    inspection.resolve(false);
    await vi.waitFor(() => expect(options.core.connectionRestored).toHaveBeenCalledTimes(1));
    expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(1);
    expect(options.interactions.cancelThreads).toHaveBeenCalledWith(new Set(["thread-1"]));
    await coordinator.stop();
  });

  it.each(["connect", "restore"])("does not confirm stale recovery after another disconnect during %s", async (stage) => {
    const { coordinator, options } = fixture();
    const first = deferred<typeof initialized>();
    const restore = deferred<void>();
    const second = deferred<typeof initialized>();
    if (stage === "connect") options.codex.reconnectProvider.mockReturnValueOnce(first.promise);
    else options.bindings.restore.mockReturnValueOnce(restore.promise);
    options.codex.reconnectProvider.mockReturnValueOnce(stage === "connect" ? second.promise : Promise.resolve(initialized));
    if (stage === "restore") options.codex.reconnectProvider.mockReturnValueOnce(second.promise);
    coordinator.disconnected(new Error("first"), "openai");
    await vi.waitFor(() => expect(stage === "connect" ? options.codex.reconnectProvider : options.bindings.restore).toHaveBeenCalledTimes(1));
    coordinator.disconnected(new Error("second"), "openai");
    first.resolve(initialized);
    restore.resolve();
    await vi.waitFor(() => expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(2));
    expect(options.core.connectionRestored).not.toHaveBeenCalled();
    expect(options.bindings.completeProviderReconnect).not.toHaveBeenCalled();
    second.resolve(initialized);
    await vi.waitFor(() => expect(options.core.connectionRestored).toHaveBeenCalledTimes(1));
    await coordinator.stop();
  });

  it("waits for pending inspection when stopped without starting recovery", async () => {
    const { coordinator, options } = fixture();
    const inspection = deferred<boolean>();
    options.intentionallyReleased.mockReturnValue(inspection.promise);
    coordinator.disconnected(new Error("lost"), "openai");
    const stopped = vi.fn();
    const stop = coordinator.stop();
    expect(coordinator.stop()).toBe(stop);
    void stop.then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    inspection.resolve(false);
    await stop;
    expect(options.codex.reconnectProvider).not.toHaveBeenCalled();
    expect(options.core.connectionLost).not.toHaveBeenCalled();
  });

  it("waits for in-flight connection without restoring bindings after stop", async () => {
    const { coordinator, options } = fixture();
    const connection = deferred<typeof initialized>();
    options.codex.reconnectProvider.mockReturnValue(connection.promise);
    coordinator.disconnected(new Error("lost"), "openai");
    await vi.waitFor(() => expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(1));
    const stopped = vi.fn();
    const stop = coordinator.stop();
    void stop.then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    connection.resolve(initialized);
    await stop;
    expect(options.connected).not.toHaveBeenCalled();
    expect(options.bindings.restore).not.toHaveBeenCalled();
    expect(options.core.connectionRestored).not.toHaveBeenCalled();
  });

  it("serializes recovery of different Providers without dropping a queued disconnect", async () => {
    const { coordinator, options, disconnected } = fixture();
    const connection = deferred<typeof initialized>();
    options.codex.reconnectProvider.mockReturnValueOnce(connection.promise);
    coordinator.disconnected(new Error("first"), "openai");
    await vi.waitFor(() => expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(1));
    coordinator.disconnected(new Error("second"), "deepseek");
    await vi.waitFor(() => expect(disconnected.has("deepseek")).toBe(true));
    expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(1);
    connection.resolve(initialized);
    await vi.waitFor(() => expect(disconnected.size).toBe(0));
    expect(options.codex.reconnectProvider.mock.calls).toEqual([["openai"], ["deepseek"]]);
    await coordinator.stop();
  });

  it("clears pending recovery when the Provider is intentionally released during reconnect", async () => {
    const { coordinator, options, disconnected } = fixture();
    const connection = deferred<typeof initialized>();
    options.codex.reconnectProvider.mockReturnValueOnce(connection.promise);
    coordinator.disconnected(new Error("first"), "openai");
    await vi.waitFor(() => expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(1));
    options.intentionallyReleased.mockResolvedValue(true);
    coordinator.disconnected(new Error("released"), "openai");
    await vi.waitFor(() => expect(options.codex.closeProvider).toHaveBeenCalledWith("openai"));
    connection.resolve(initialized);
    await coordinator.stop();
    expect(disconnected.size).toBe(0);
    expect(options.bindings.restore).not.toHaveBeenCalled();
    expect(options.core.connectionRestored).not.toHaveBeenCalled();
  });

  it("cancels retry delay and does not recover after shutdown", async () => {
    vi.useFakeTimers();
    const { coordinator, options } = fixture();
    options.codex.reconnectProvider.mockRejectedValue(new Error("offline"));
    coordinator.disconnected(new Error("lost"), "openai");
    await vi.advanceTimersByTimeAsync(0);
    expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(1);
    await coordinator.stop();
    await vi.runAllTimersAsync();
    expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(1);
    expect(options.requestStop).not.toHaveBeenCalled();
  });

  it.each(["connected", "restore"])("retries %s failure without reconnecting an already connected Client", async (stage) => {
    vi.useFakeTimers();
    const { options } = fixture();
    const transport = new FakeTransport();
    const routing = new ProviderRoutingClient("openai", new Map([
      ["openai", new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" })],
    ]));
    await routing.connect();
    await routing.startThread("/tmp/project");
    const reconnect = vi.spyOn(routing, "reconnectProvider");
    const operation = stage === "connected" ? options.connected : options.bindings.restore;
    operation.mockRejectedValueOnce(new Error("temporary recovery failure"));
    const coordinator = new GatewayReconnectCoordinator({ ...options, codex: routing });
    const remove = routing.onDisconnect((error, provider) => coordinator.disconnected(error, provider));
    try {
      transport.disconnect(new Error("lost"));
      await vi.runAllTimersAsync();
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledTimes(2);
      expect(options.core.connectionRestored).toHaveBeenCalledTimes(1);
      expect(options.requestStop).not.toHaveBeenCalled();
    } finally {
      remove();
      await coordinator.stop();
      await routing.close();
    }
  });

  it("bounds restoration retries without repeating a successful handshake", async () => {
    vi.useFakeTimers();
    const { coordinator, options } = fixture();
    options.bindings.restore.mockRejectedValue(new Error("persistent recovery failure"));
    coordinator.disconnected(new Error("lost"), "openai");
    await vi.runAllTimersAsync();
    expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(1);
    expect(options.connected).toHaveBeenCalledTimes(1);
    expect(options.bindings.restore).toHaveBeenCalledTimes(12);
    expect(options.requestStop).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });

  it("retains the retry budget across disconnects during failed reconnects", async () => {
    vi.useFakeTimers();
    const { coordinator, options } = fixture();
    options.codex.reconnectProvider.mockImplementation(async () => {
      coordinator.disconnected(new Error("lost again"), "openai");
      throw new Error("offline");
    });
    coordinator.disconnected(new Error("lost"), "openai");
    await vi.runAllTimersAsync();
    expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(12);
    expect(options.requestStop).toHaveBeenCalledTimes(1);
    coordinator.disconnected(new Error("after exhaustion"), "openai");
    await vi.runAllTimersAsync();
    expect(options.codex.reconnectProvider).toHaveBeenCalledTimes(12);
    await coordinator.stop();
  });
});
