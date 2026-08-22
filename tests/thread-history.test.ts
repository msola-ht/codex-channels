import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  JsonRpcClient,
  toThreadRevertResult,
  toThreadTurnsPage,
} from "../src/codex-client/index.js";
import { BaseTransport } from "../src/codex-client/transport.js";

function appServerThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "thread-1",
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "测试 Thread",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp/project",
    cliVersion: "0.148.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function turn(id: string, input: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id,
    items: [{
      type: "userMessage",
      id: `item-${id}`,
      clientId: `client-${id}`,
      content: input,
    }],
    itemsView: "summary",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1_000,
  };
}

class HistoryTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  readonly sent: Array<Record<string, unknown>> = [];
  failRevert = false;

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async send(raw: string): Promise<void> {
    const request = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(request);
    const id = request.id;
    switch (request.method) {
      case "initialize":
        this.respond(id, {
          userAgent: "codex-cli 0.148.0",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      case "initialized":
        return;
      case "thread/turns/list":
        this.respond(id, {
          data: [turn("turn-1", [{ type: "text", text: "a ".repeat(100), text_elements: [] }])],
          nextCursor: "turn-cursor-1",
          backwardsCursor: "turn-backwards-1",
        });
        return;
      case "thread/revert":
        if (this.failRevert) {
          this.respondError(id);
          return;
        }
        this.respond(id, {
          thread: appServerThread(),
          turnsBackwardsCursor: "turn-backwards-after-revert",
          itemsBackwardsCursor: "item-backwards-after-revert",
        });
        return;
      default:
        this.respond(id, {});
    }
  }

  private respond(id: unknown, result: unknown): void {
    queueMicrotask(() => this.emitMessage(JSON.stringify({ id, result })));
  }

  private respondError(id: unknown): void {
    queueMicrotask(() => this.emitMessage(JSON.stringify({
      id,
      error: { code: -32001, message: "Server overloaded; retry later." },
    })));
  }
}

describe("Thread history Client boundary", () => {
  it("uses paginated summary turns and never retries the Revert write", async () => {
    const transport = new HistoryTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.listThreadTurns("thread-1", { limit: 25 })).resolves.toMatchObject({
      turns: [{
        id: "turn-1",
        inputType: "text",
        textPreview: expect.stringContaining("a a"),
      }],
      nextCursor: "turn-cursor-1",
    });
    const listRequest = transport.sent.find((request) => request.method === "thread/turns/list");
    expect(listRequest?.params).toEqual({
      threadId: "thread-1",
      limit: 25,
      sortDirection: "desc",
      itemsView: "summary",
    });

    await expect(client.revertThread("thread-1", "turn-1")).resolves.toMatchObject({
      thread: { id: "thread-1", historyMode: "paginated" },
    });
    transport.failRevert = true;
    await expect(client.revertThread("thread-1", "turn-1")).rejects.toThrow("Server overloaded");
    expect(transport.sent.filter((request) => request.method === "thread/revert")).toHaveLength(2);
  });

  it("hashes no input into history summaries and rejects a Revert response carrying turns", () => {
    const page = toThreadTurnsPage({
      data: [turn("turn-image", [{ type: "localImage", path: "/private/secret/image.png" }])],
      nextCursor: null,
      backwardsCursor: "backwards",
    } as never);
    expect(page.turns[0]).toMatchObject({
      id: "turn-image",
      inputType: "image",
      textPreview: null,
    });
    expect(JSON.stringify(page)).not.toContain("/private/secret/image.png");

    expect(() => toThreadRevertResult({
      thread: appServerThread({ turns: [turn("turn-retained", [])] }),
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    } as never)).toThrow("不应携带 turns");
  });

  it("rejects malformed summary pages instead of exposing ambiguous selectors", () => {
    expect(() => toThreadTurnsPage({
      data: [turn("duplicate", [{ type: "text", text: "one" }]), turn("duplicate", [{
        type: "text",
        text: "two",
      }])],
      nextCursor: null,
      backwardsCursor: null,
    } as never)).toThrow("重复 Turn ID");

    expect(() => toThreadTurnsPage({
      data: [],
      nextCursor: "unexpected",
      backwardsCursor: null,
    } as never)).toThrow("空页面");

    expect(() => toThreadTurnsPage({
      data: [{ ...turn("full-view", [{ type: "text", text: "secret" }]), itemsView: "full" }],
      nextCursor: null,
      backwardsCursor: null,
    } as never)).toThrow("summary 视图");
  });
});
