import { describe, expect, it } from "vitest";

import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { BaseTransport } from "../src/codex-client/transport.js";

class ServerRequestTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  readonly sent: Array<Record<string, unknown>> = [];
  failServerResponse = false;

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async send(message: string): Promise<void> {
    const request = JSON.parse(message) as { id?: string | number; method: string };
    if (this.failServerResponse && request.id === "server-1") {
      throw new Error("response send failed");
    }
    this.sent.push(request);
    if (request.method === "initialize") {
      queueMicrotask(() => this.emitMessage(JSON.stringify({
        id: request.id,
        result: { platformOs: "macos" },
      })));
    }
  }

  receive(message: Record<string, unknown>): void {
    this.emitMessage(JSON.stringify(message));
  }

  disconnect(error?: Error): void {
    this.emitClose(error);
  }
}

describe("JsonRpcClient server requests", () => {
  it("responds to server requests without treating them as notifications", async () => {
    const transport = new ServerRequestTransport();
    const client = new JsonRpcClient(transport);
    client.setServerRequestHandler(async (request) => ({ accepted: request.method === "test/request" }));
    await client.connect();

    transport.receive({ id: "server-1", method: "test/request", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)).toEqual({ id: "server-1", result: { accepted: true } });
  });

  it("does not respond to a server request after its connection disconnects", async () => {
    const transport = new ServerRequestTransport();
    const warnings: Array<Record<string, unknown>> = [];
    let resolveRequest: ((value: unknown) => void) | undefined;
    const client = new JsonRpcClient(transport, 60_000, {
      warn: (fields) => warnings.push(fields),
    });
    client.setServerRequestHandler(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));
    await client.connect();

    transport.receive({ id: "server-1", method: "test/request", params: {} });
    transport.disconnect(new Error("socket lost"));
    resolveRequest?.({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.some((message) => message.id === "server-1")).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({ reason: "stale-connection" }));
  });
});
