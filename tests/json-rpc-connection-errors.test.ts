import { describe, expect, it } from "vitest";

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
