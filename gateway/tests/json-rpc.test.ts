import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { BaseTransport } from "../src/codex-client/transport.js";

class FakeTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  readonly sent: Array<Record<string, unknown>> = [];
  overloadResponses = 0;

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async send(message: string): Promise<void> {
    const decoded = JSON.parse(message) as Record<string, unknown>;
    this.sent.push(decoded);
    if (decoded.method === "initialize") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              userAgent: "test",
              codexHome: "/tmp",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        ),
      );
    } else if (decoded.method === "read/test") {
      this.overloadResponses += 1;
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify(
            this.overloadResponses === 1
              ? { id: decoded.id, error: { code: -32001, message: "Server overloaded; retry later." } }
              : { id: decoded.id, result: { ok: true } },
          ),
        ),
      );
    } else if (decoded.method === "thread/list") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: { data: [], nextCursor: null },
          }),
        ),
      );
    } else if (decoded.method === "thread/start") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: { thread: { id: "thread-1" }, model: "gpt-default", reasoningEffort: "medium" },
          }),
        ),
      );
    } else if (decoded.method === "account/rateLimits/read") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              rateLimits: {
                limitId: "codex",
                limitName: null,
                primary: null,
                secondary: null,
                credits: null,
                individualLimit: null,
                spendControlReached: null,
                planType: "pro",
                rateLimitReachedType: null,
              },
              rateLimitsByLimitId: null,
              rateLimitResetCredits: null,
            },
          }),
        ),
      );
    } else if (decoded.method === "turn/start") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({
            id: decoded.id,
            result: {
              turn: {
                id: "turn-1",
                items: [],
                itemsView: "full",
                status: "inProgress",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
              },
            },
          }),
        ),
      );
    } else if (decoded.method === "turn/steer") {
      queueMicrotask(() =>
        this.emitMessage(
          JSON.stringify({ id: decoded.id, result: { turnId: "turn-1" } }),
        ),
      );
    }
  }

  receive(message: Record<string, unknown>): void {
    this.emitMessage(JSON.stringify(message));
  }

  disconnect(error?: Error): void {
    this.emitClose(error);
  }
}

describe("JsonRpcClient", () => {
  it("initializes once and routes notifications", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);
    const methods: string[] = [];
    client.onNotification((notification) => methods.push(notification.method));

    const initialized = await client.connect();
    transport.receive({ method: "warning", params: { message: "test" } });

    expect(initialized.platformOs).toBe("macos");
    expect(transport.sent.map((message) => message.method)).toEqual(["initialize", "initialized"]);
    expect(methods).toEqual(["warning"]);
  });

  it("responds to server requests without treating them as notifications", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);
    client.setServerRequestHandler(async (request) => ({ accepted: request.method === "test/request" }));
    await client.connect();

    transport.receive({ id: "server-1", method: "test/request", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)).toEqual({ id: "server-1", result: { accepted: true } });
  });

  it("reinitializes a replacement connection after disconnect", async () => {
    const transport = new FakeTransport();
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

  it("retries overload only when the caller marks a request safe", async () => {
    const transport = new FakeTransport();
    const client = new JsonRpcClient(transport);
    await client.connect();

    const result = await client.request<{ ok: boolean }>(
      "read/test",
      {},
      { retryOverload: true, attempts: 2 },
    );

    expect(result).toEqual({ ok: true });
    expect(transport.overloadResponses).toBe(2);
  });

  it("lists CLI, Remote TUI, and App Server thread sources explicitly", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.listThreads("/tmp/project");

    const request = transport.sent.find((message) => message.method === "thread/list");
    expect(request?.params).toMatchObject({
      cwd: "/tmp/project",
      sourceKinds: ["cli", "vscode", "appServer"],
      useStateDbOnly: true,
    });
  });

  it("reads account rate limits through the stable App Server method", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
    });
    await client.connect();

    const result = await client.accountRateLimits();

    expect(result.rateLimits.planType).toBe("pro");
    expect(transport.sent.some((message) => message.method === "account/rateLimits/read")).toBe(true);
  });

  it("tags Gateway user input with a client message id", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
    });
    await client.connect();

    await client.startTurn(
      "thread-1",
      "测试输入",
      "codex_tg_gateway:request-1",
      "/tmp/project",
      { model: "gpt-selected", effort: "high" },
    );
    await client.steerTurn("thread-1", "turn-1", "补充输入", "codex_tg_gateway:request-2");

    expect(transport.sent.find((message) => message.method === "turn/start")?.params)
      .toMatchObject({
        clientUserMessageId: "codex_tg_gateway:request-1",
        cwd: "/tmp/project",
        model: "gpt-selected",
        effort: "high",
      });
    expect(transport.sent.find((message) => message.method === "turn/steer")?.params)
      .toMatchObject({ clientUserMessageId: "codex_tg_gateway:request-2" });
  });

  it("uses CODEX_MODEL only when starting a new thread", async () => {
    const transport = new FakeTransport();
    const rpc = new JsonRpcClient(transport);
    const client = new CodexAppServerClient(rpc, {
      sandbox: "workspace-write",
      model: "gpt-configured",
    });
    await client.connect();

    await client.startThread("/tmp/project");
    await client.startTurn("thread-1", "测试输入", "request-1", "/tmp/project");

    expect(transport.sent.find((message) => message.method === "thread/start")?.params)
      .toMatchObject({ model: "gpt-configured" });
    expect(transport.sent.find((message) => message.method === "turn/start")?.params)
      .not.toHaveProperty("model");
  });
});
