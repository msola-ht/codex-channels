import { describe, expect, it, vi } from "vitest";

import { BaseTransport } from "../src/codex-client/transport.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";

class TimingTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  readonly sent: Array<Record<string, unknown>> = [];

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
    }
  }

  receive(message: Record<string, unknown>): void {
    this.emitMessage(JSON.stringify(message));
  }
}

describe("JsonRpcClient timing", () => {
  it("logs sanitized request timing at debug level", async () => {
    const transport = new TimingTransport();
    const debug = vi.fn();
    const client = new JsonRpcClient(transport, 60_000, { warn: vi.fn(), debug });

    await client.connect();

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "initialize",
        requestId: 1,
        durationMs: expect.any(Number),
        outcome: "success",
      }),
      "Codex JSON-RPC 请求完成",
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain("clientInfo");
  });

  it("initializes once and routes notifications", async () => {
    const transport = new TimingTransport();
    const client = new JsonRpcClient(transport);
    const methods: string[] = [];
    const receivedTimes: Array<number | undefined> = [];
    client.onNotification((notification) => {
      methods.push(notification.method);
      receivedTimes.push(notification.receivedAtMs);
    });

    const initialized = await client.connect();
    transport.receive({ method: "warning", params: { message: "test" } });

    expect(initialized.platformOs).toBe("macos");
    expect(transport.sent.map((message) => message.method)).toEqual(["initialize", "initialized"]);
    expect(transport.sent[1]).toEqual({ method: "initialized" });
    expect(transport.sent[0]).toMatchObject({
      params: {
        clientInfo: { name: "codex_connect", title: "Codex Connect Gateway" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: null,
          extensions: { "openai/form": {} },
        },
      },
    });
    expect(methods).toEqual(["warning"]);
    expect(receivedTimes).toEqual([expect.any(Number)]);
  });
});
