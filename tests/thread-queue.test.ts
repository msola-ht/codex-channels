import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  JsonRpcClient,
  toThreadQueueItem,
} from "../src/codex-client/index.js";
import { BaseTransport } from "../src/codex-client/transport.js";

function submission(
  input: Record<string, unknown>[],
  id = "queued-1",
): Record<string, unknown> {
  return {
    id,
    input,
    clientUserMessageId: `gateway-client-${id}`,
  };
}

function textSubmission(id = "queued-1"): Record<string, unknown> {
  return submission([{ type: "text", text: "queued text", text_elements: [] }], id);
}

class QueueTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  readonly sent: Array<Record<string, unknown>> = [];
  listOverloadResponses = 0;
  failMethod: string | undefined;
  deleteResponse: unknown = { deleted: true };
  queuePages: Array<Record<string, unknown>> = [{
    data: [textSubmission()],
    nextCursor: null,
  }];

  async connect(): Promise<void> {}
  async close(): Promise<void> {}

  async send(raw: string): Promise<void> {
    const request = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(request);
    const id = request.id;
    const method = request.method;
    if (method === "initialize") {
      this.respond(id, {
        userAgent: "codex-cli 0.148.0",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "linux",
      });
      return;
    }
    if (method === "initialized") return;
    if (method === "thread/queue/list" && this.listOverloadResponses > 0) {
      this.listOverloadResponses -= 1;
      this.respondError(id);
      return;
    }
    if (typeof method === "string" && method === this.failMethod) {
      this.respondError(id);
      return;
    }
    switch (method) {
      case "thread/queue/add":
        this.respond(id, { queuedSubmission: textSubmission("queued-added") });
        return;
      case "thread/queue/list": {
        const params = request.params as { cursor?: string } | undefined;
        const page = params?.cursor === "cursor-1" ? this.queuePages[1] : this.queuePages[0];
        this.respond(id, page ?? { data: [], nextCursor: null });
        return;
      }
      case "thread/queue/update":
        this.respond(id, { queuedSubmission: textSubmission("queued-updated") });
        return;
      case "thread/queue/delete":
        this.respond(id, this.deleteResponse);
        return;
      case "thread/queue/reorder":
        this.respond(id, {});
        return;
      case "thread/queue/start":
        this.respond(id, {
          turn: {
            id: "turn-queue-started",
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
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

describe("Thread Queue Client", () => {
  it("exposes all six native RPCs and retries list but no write", async () => {
    const transport = new QueueTransport();
    transport.listOverloadResponses = 1;
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.addQueueItem("thread-1", "add text", "client-add"))
      .resolves.toMatchObject({ id: "queued-added", inputType: "text" });
    await expect(client.listQueue("thread-1", { limit: 25 }))
      .resolves.toMatchObject({ items: [{ id: "queued-1", inputType: "text" }] });
    await expect(client.updateQueueItem("thread-1", "queued-1", "updated"))
      .resolves.toMatchObject({ id: "queued-updated" });
    await expect(client.deleteQueueItem("thread-1", "queued-1"))
      .resolves.toEqual({ deleted: true });
    await expect(client.reorderQueue("thread-1", ["queued-1"]))
      .resolves.toBeUndefined();
    await expect(client.startQueueItem("thread-1", "queued-1"))
      .resolves.toEqual({ turnId: "turn-queue-started" });

    const queueMethods = transport.sent
      .map((request) => request.method)
      .filter((method) => typeof method === "string" && method.startsWith("thread/queue/"));
    expect(queueMethods).toEqual([
      "thread/queue/add",
      "thread/queue/list",
      "thread/queue/list",
      "thread/queue/update",
      "thread/queue/delete",
      "thread/queue/reorder",
      "thread/queue/start",
    ]);

    transport.failMethod = "thread/queue/add";
    await expect(client.addQueueItem("thread-1", "no retry", "client-fail"))
      .rejects.toThrow("Server overloaded");
    expect(transport.sent.filter((request) => request.method === "thread/queue/add"))
      .toHaveLength(2);
  });

  it("keeps Queue summaries platform-independent and does not expose paths", () => {
    const image = toThreadQueueItem({
      ...submission([{ type: "image", url: "data:image/png;base64,AA==" }], "image-1"),
    } as never);
    expect(image).toMatchObject({
      id: "image-1",
      inputType: "image",
      textPreview: null,
      editable: false,
    });
    expect(JSON.stringify(image)).not.toContain("/private/user/secret.png");

    const text = toThreadQueueItem({
      ...textSubmission("text-1"),
      input: [{
        type: "text",
        text: `\u0000${"x".repeat(300)}`,
        text_elements: [],
      }],
    } as never);
    expect(text.inputType).toBe("text");
    expect(text.textPreview).not.toContain("\u0000");
    expect(text.textPreview?.length).toBeLessThanOrEqual(160);
    expect(text.editable).toBe(true);

    const emoji = toThreadQueueItem({
      ...textSubmission("emoji-1"),
      input: [{
        type: "text",
        text: "😀".repeat(161),
        text_elements: [],
      }],
    } as never);
    expect(emoji.textPreview).toBe(`${"😀".repeat(159)}…`);
    expect([...(emoji.textPreview ?? "")]).toHaveLength(160);

    const emptyClientId = toThreadQueueItem({
      ...textSubmission("empty-client-id"),
      clientUserMessageId: "",
    } as never);
    expect(emptyClientId.clientUserMessageId).toBe("");
  });

  it("rejects a malformed Queue delete response", async () => {
    const transport = new QueueTransport();
    transport.deleteResponse = {};
    const client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "workspace-write",
    });
    await client.connect();

    await expect(client.deleteQueueItem("thread-1", "queued-1"))
      .rejects.toThrow("Codex Queue 删除响应缺少 deleted");
  });
});
