import { describe, expect, it } from "vitest";

import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { BaseTransport } from "../src/codex-client/transport.js";

class OverloadTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  readonly sent: Array<Record<string, unknown>> = [];
  overloadResponses = 0;
  private usageAttempts = 0;

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async send(message: string): Promise<void> {
    const request = JSON.parse(message) as { id?: number; method: string };
    this.sent.push(request);
    if (request.method === "initialize") {
      queueMicrotask(() => this.emitMessage(JSON.stringify({
        id: request.id,
        result: { platformOs: "macos" },
      })));
    } else if (request.method === "account/usage/read") {
      this.usageAttempts += 1;
      if (this.usageAttempts <= 2) {
        this.overloadResponses += 1;
        queueMicrotask(() => this.emitMessage(JSON.stringify({
          id: request.id,
          error: { code: -32000, message: "Client overloaded; request rejected." },
        })));
      } else {
        queueMicrotask(() => this.emitMessage(JSON.stringify({ id: request.id, result: { ok: true } })));
      }
    }
  }

  receive(message: Record<string, unknown>): void {
    this.emitMessage(JSON.stringify(message));
  }
}

describe("JsonRpcClient overload handling", () => {
  it("rejects excess concurrent server requests with a bounded overload response", async () => {
    const transport = new OverloadTransport();
    let resolveFirst: ((value: unknown) => void) | undefined;
    const client = new JsonRpcClient(transport, 60_000, undefined, 1);
    client.setServerRequestHandler((request) => request.id === "server-1"
      ? new Promise((resolve) => { resolveFirst = resolve; })
      : Promise.resolve({ accepted: true }));
    await client.connect();

    transport.receive({ id: "server-1", method: "test/request", params: {} });
    transport.receive({ id: "server-2", method: "test/request", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.find((message) => message.id === "server-2")).toEqual({
      id: "server-2",
      error: { code: -32000, message: "Client overloaded; request rejected." },
    });
    resolveFirst?.({ accepted: true });
  });

});
