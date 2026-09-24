import { describe, expect, it, vi } from "vitest";

import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { BaseTransport } from "../src/codex-client/transport.js";

class ConnectionErrorTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  readonly sent: Array<Record<string, unknown>> = [];
  disconnectAfterInitialized = false;
  failServerResponse = false;

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async send(message: string): Promise<void> {
    const request = JSON.parse(message) as { id?: number | string; method: string };
    if (this.failServerResponse && request.id === "server-1") throw new Error("send failed");
    this.sent.push(request);
    if (request.method === "initialize") {
      queueMicrotask(() => this.emitMessage(JSON.stringify({ id: request.id, result: { platformOs: "macos" } })));
    } else if (request.method === "initialized" && this.disconnectAfterInitialized) {
      queueMicrotask(() => this.emitClose(new Error("socket lost")));
    }
  }
  receive(message: Record<string, unknown>): void { this.emitMessage(JSON.stringify(message)); }
  disconnect(error?: Error): void { this.emitClose(error); }
}

describe("JsonRpcClient connection errors", () => {
  it("invalidates a reconnect waiting for old Transport cleanup and shares concurrent close", async () => {
    const transport = new ConnectionErrorTransport();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.spyOn(transport, "close").mockImplementationOnce(() => gate);
    const connect = vi.spyOn(transport, "connect");
    const client = new JsonRpcClient(transport);
    const reconnecting = client.reconnect();
    const rejected = expect(reconnecting).rejects.toThrow("初始化期间已断开");
    await expect(client.reconnect()).rejects.toThrow("当前状态不允许");
    const closing = client.close();
    expect(client.close()).toBe(closing);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    await rejected;
    expect(close).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    await client.connect();
    await client.close();
  });

  it.each(["transport", "initialize", "initialized"])("keeps a replacement connection intact after an obsolete %s finishes", async (stage) => {
    const transport = new ConnectionErrorTransport();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    if (stage === "transport") {
      vi.spyOn(transport, "connect").mockImplementationOnce(async () => { entered(); await gate; });
    } else {
      const send = transport.send.bind(transport);
      let paused = false;
      vi.spyOn(transport, "send").mockImplementation(async (message) => {
        const request = JSON.parse(message) as { method?: string };
        if (!paused && request.method === stage) { paused = true; entered(); await gate; }
        await send(message);
      });
    }
    const close = vi.spyOn(transport, "close");
    const client = new JsonRpcClient(transport);
    const connecting = client.connect();
    const rejected = expect(connecting).rejects.toThrow();
    await ready;
    await client.close();
    await client.connect();
    release();
    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
    // A stale catch must neither reset the new state nor close its Transport.
    await expect(client.connect()).rejects.toThrow("connected");
    const requests = transport.sent.filter((message) => message.method === "initialize");
    if (stage === "transport") expect(requests).toHaveLength(1);
    await client.close();
  });

  it("shares close failure and allows a later cleanup retry", async () => {
    const transport = new ConnectionErrorTransport();
    const close = vi.spyOn(transport, "close").mockRejectedValueOnce(new Error("close failed"));
    const client = new JsonRpcClient(transport);
    await client.connect();
    const closing = client.close();
    expect(client.close()).toBe(closing);
    await expect(closing).rejects.toThrow("close failed");
    await client.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("does not accept a connection that closes while initialization completes", async () => {
    const transport = new ConnectionErrorTransport();
    transport.disconnectAfterInitialized = true;
    const client = new JsonRpcClient(transport);

    await expect(client.connect()).rejects.toThrow("初始化期间已断开");
  });

  it("reports a server response send failure without attempting a second response", async () => {
    const transport = new ConnectionErrorTransport();
    const warnings: Array<Record<string, unknown>> = [];
    const client = new JsonRpcClient(transport, 60_000, { warn: (fields) => warnings.push(fields) });
    client.setServerRequestHandler(async () => ({ accepted: true }));
    await client.connect();
    transport.failServerResponse = true;

    transport.receive({ id: "server-1", method: "test/request", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnings).toContainEqual(expect.objectContaining({ reason: "response-send" }));
    expect(transport.sent.filter((message) => message.id === "server-1")).toHaveLength(0);
  });

  it("reinitializes a replacement connection after disconnect", async () => {
    const transport = new ConnectionErrorTransport();
    const client = new JsonRpcClient(transport);
    const disconnects: string[] = [];
    client.onDisconnect((error) => disconnects.push(error.message));
    await client.connect();

    transport.disconnect(new Error("socket lost"));
    const initialized = await client.reconnect();

    expect(initialized.platformOs).toBe("macos");
    expect(disconnects).toEqual(["socket lost"]);
    expect(transport.sent.filter((message) => message.method === "initialize")).toHaveLength(2);
    expect(transport.sent.filter((message) => message.method === "initialized")).toHaveLength(2);
  });
});
