import { describe, expect, it } from "vitest";
import { FileChangeApprovalContext } from "../src/codex-client/file-change-approval-context.js";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { FakeTransport } from "./support/json-rpc-fixtures.js";

class NotificationTransport extends FakeTransport {
  notify(notification: ReturnType<typeof started>): void {
    this.emitMessage(JSON.stringify(notification));
  }
}

const change = { path: "/workspace/a.ts", kind: { type: "update", move_path: null }, diff: "secret diff" };
function started(threadId = "thread", turnId = "turn", itemId = "item", changes: unknown = [change]) {
  return { method: "item/started", params: { threadId, turnId,
    item: { type: "fileChange", id: itemId, status: "inProgress", changes } } };
}

describe("file approval context", () => {
  it("correlates the exact thread, turn and item and retains paths only", () => {
    const context = new FileChangeApprovalContext();
    context.observe(started());
    expect(context.get("thread", "turn", "item")).toEqual([{ path: change.path, kind: "update" }]);
    expect(context.get("other", "turn", "item")).toBeUndefined();
    expect(context.get("thread", "other", "item")).toBeUndefined();
    expect(context.get("thread", "turn", "other")).toBeUndefined();
    const copy = context.get("thread", "turn", "item")!;
    copy[0]!.path = "changed";
    expect(context.get("thread", "turn", "item")![0]!.path).toBe(change.path);
  });

  it("preserves add/delete/move and rejects partial or excessive lists", () => {
    const context = new FileChangeApprovalContext();
    context.observe(started("thread", "turn", "item", [
      { path: "new", kind: { type: "add" } },
      { path: "old", kind: { type: "delete" } },
      { path: "from", kind: { type: "update", move_path: "to" } },
    ]));
    expect(context.get("thread", "turn", "item")).toEqual([
      { path: "new", kind: "add" }, { path: "old", kind: "delete" },
      { path: "from", kind: "update", movePath: "to" },
    ]);
    for (const invalid of [[change, { path: "bad", kind: { type: "unknown" } }],
      [change, { path: "bad", kind: { type: "update" } }], [], Array(101).fill(change),
      [{ path: "x".repeat(12_001), kind: { type: "add" } }]]) {
      context.observe(started("thread", "turn", "item", invalid));
      expect(context.get("thread", "turn", "item")).toBeNull();
    }
  });

  it.each(["item/completed", "turn/completed", "thread/closed", "thread/archived", "thread/deleted", "thread/reverted"])(
    "clears matching context on %s without affecting other threads", method => {
      const context = new FileChangeApprovalContext();
      context.observe(started());
      context.observe(started("other"));
      context.observe({ method, params: { threadId: "thread", turnId: "turn", turn: { id: "turn" }, item: { id: "item" } } });
      expect(context.get("thread", "turn", "item")).toBeUndefined();
      expect(context.get("other", "turn", "item")).toBeDefined();
    },
  );

  it("does not substitute another item for missing or not-yet-observed context", () => {
    const context = new FileChangeApprovalContext();
    context.observe(started("thread", "turn", "other"));
    expect(context.get("thread", "turn", "item")).toBeUndefined();
    context.observe(started());
    expect(context.get("thread", "turn", "item")).toBeDefined();
    for (let i = 0; i < 128; i++) context.observe(started("thread", "turn", String(i)));
    expect(context.get("thread", "turn", "item")).toBeUndefined();
    context.clear();
    expect(context.get("thread", "turn", "127")).toBeUndefined();
  });

  it("wires the real Client cache before request dispatch and clears it on disconnect", async () => {
    const transport = new NotificationTransport();
    const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "workspace-write" });
    const request = { type: "file" as const, requestId: 1, threadId: "thread", turnId: "turn", itemId: "item", reason: null };
    await client.connect();
    try {
      transport.notify(started());
      expect(client.fileApprovalChanges(request)).toEqual([{ path: change.path, kind: "update" }]);
      transport.disconnect();
      expect(client.fileApprovalChanges(request)).toBeUndefined();
    } finally { await client.close(); }
  });
});
