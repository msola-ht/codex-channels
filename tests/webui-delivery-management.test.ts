import { deliveryControlSocketPath } from "../runtime/delivery-control.mjs";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { PrivateIpcServer } from "../runtime/private-ipc.mjs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteDeliveryJournal } from "../src/delivery/sqlite-journal.js";
import { PersistentSurfaceOutput } from "../src/bootstrap/persistent-surface-output.js";
import type { OutputEvent } from "../src/conversation-core/index.js";
import { cleanupWebuiTestFixtures, createWebuiTestFixture, startWebuiTestServer, type WebuiTestServer } from "./webui-server-test-fixture.js";
import type { DeliveryQueueSnapshot } from "../scripts/webui-api.js";

const directories: string[] = [], servers: WebuiTestServer[] = [];
afterEach(async () => cleanupWebuiTestFixtures(servers, directories));
async function fixture() {
  const f = createWebuiTestFixture(directories);
  const directory = join(f.home, "data", "delivery-outbox");
  const writer = new SqliteDeliveryJournal(directory);
  writer.execute({ type: "submit", value: { id: "record", account: '["feishu","main"]', conversation: '["feishu","main","chat"]', payload: "SECRET BODY" } });
  writer.execute({ type: "state", id: "record", from: "pending", to: "sending" });
  writer.execute({ type: "checkpoint", id: "record", value: { operation: "SECRET OPERATION", state: "confirmed", messageId: "SECRET MESSAGE" } });
  writer.execute({ type: "state", id: "record", from: "sending", to: "uncertain" });
  writer.close();
  const managementOrigin = "http://127.0.0.1:0";
  const { origin } = await startWebuiTestServer(servers, f.environment, undefined, { managementOrigin, token: "test-token" });
  const headers = { origin: managementOrigin, authorization: "Bearer test-token", "content-type": "application/json" };
  const url = `${origin}/api/v1/management/delivery`;
  const snapshot = async () => await (await fetch(`${url}/queue`, { headers })).json() as DeliveryQueueSnapshot;
  const post = (path: string, value: unknown) => fetch(`${url}/${path}`, { method: "POST", headers, body: JSON.stringify(value) });
  const content = (id: string, revision: string) => fetch(`${url}/content?${new URLSearchParams({ id, revision })}`, { headers });
  return { directory, home: f.home, url, headers, snapshot, post, content };
}
it("authenticates SSE and streams real queue changes without exposing payloads", async () => {
  const f = await fixture();
  const writer = new SqliteDeliveryJournal(f.directory);
  writer.execute({ type: "resolve", id: "record", action: "confirm" });
  writer.close();
  const output = new PersistentSurfaceOutput({ directory: f.directory, workerUrl: new URL("../dist/delivery/worker.js", import.meta.url),
    accounts: () => ['["feishu","main"]'], owner: () => "owner", authorized: () => false,
    deliver: async () => {}, fault: () => {},
  });
  await output.start();
  const abort = new AbortController();
  try {
    expect((await fetch(`${f.url}/events`)).status).toBe(401);
    expect((await fetch(`${f.url}/events?token=secret`, { headers: f.headers })).status).toBe(400);
    expect((await fetch(`${f.url}/events`, { headers: { ...f.headers, origin: "https://evil.invalid" } })).status).toBe(403);
    const response = await fetch(`${f.url}/events`, { headers: f.headers, signal: abort.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const reader = response.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toBe('data: {"type":"changed"}\n\n');
    output.accept({ type: "text.completed", target: { surface: "feishu", accountId: "main", conversationId: "chat" },
      threadId: "t", turnId: "u", itemId: "item", text: "SECRET BODY" });
    expect(await read()).toBe('data: {"type":"changed"}\n\n');
    await vi.waitFor(async () => expect((await f.snapshot()).records[0]?.state).toBe("blocked"));
    const row = (await f.snapshot()).records[0]!;
    const input = { action: "ignore", entries: [{ id: row.id, revision: row.revision }] };
    const preview = await (await f.post("batch-preview", input)).json() as { confirmationToken: string };
    expect((await f.post("batch-apply", { ...input, confirmationToken: preview.confirmationToken })).status).toBe(200);
    expect(await read()).toBe('data: {"type":"changed"}\n\n');
    expect((await f.snapshot()).records).toEqual([]);
    await output.close();
    expect(await read()).toBe('data: {"type":"unavailable"}\n\n');
    expect((await reader.read()).done).toBe(true);
  } finally { abort.abort(); await output.close(); }
});
it("authenticates reads, validates filters, and returns only safe metadata", async () => {
  const f = await fixture();
  expect((await fetch(`${f.url}/queue`)).status).toBe(401);
  for (const query of ["before=-1", "before=1&before=2", "after=1", "state=failed", "payload=true"]) {
    expect((await fetch(`${f.url}/queue?${query}`, { headers: f.headers })).status).toBe(400);
  }
  const snapshot = await f.snapshot();
  expect(snapshot.records[0]).toMatchObject({ id: "record", state: "uncertain", confirmed: 1 });
  expect(JSON.stringify(snapshot)).not.toContain("SECRET");
});
it("paginates newest first without duplicating records when new deliveries arrive", async () => {
  const f = await fixture();
  const writer = new SqliteDeliveryJournal(f.directory);
  try {
    for (let index = 0; index < 52; index++) writer.execute({ type: "submit", value: {
      id: `new-${index}`, account: "a", conversation: "c", payload: "text",
    } });
    const first = await f.snapshot();
    expect(first.records.map(row => row.id)).toEqual(Array.from({ length: 50 }, (_, i) => `new-${51 - i}`));
    writer.execute({ type: "submit", value: { id: "latest", account: "a", conversation: "c", payload: "text" } });
    const second = await (await fetch(`${f.url}/queue?before=${first.nextCursor}`, { headers: f.headers })).json() as DeliveryQueueSnapshot;
    expect(second.records.map(row => row.id)).toEqual(["new-1", "new-0", "record"]);
    expect(second.nextCursor).toBeNull();
    expect((await f.snapshot()).records[0]?.id).toBe("latest");
  } finally { writer.close(); }
});
it("requires origin, a matching one-use confirmation, and exclusive offline access before retry", async () => {
  const f = await fixture();
  const row = (await f.snapshot()).records[0]!;
  const input = { id: row.id, revision: row.revision };
  expect((await fetch(`${f.url}/preview`, { method: "POST", headers: { ...f.headers, origin: "https://evil.invalid" }, body: JSON.stringify(input) })).status).toBe(403);
  expect((await f.post("retry", input)).status).toBe(409);
  const preview = await (await f.post("preview", input)).json() as { confirmationToken: string };
  const writer = new SqliteDeliveryJournal(f.directory);
  try {
    expect((await f.snapshot()).records[0]?.state).toBe("uncertain");
    const blocked = await f.post("retry", { ...input, ...preview });
    // The envelope must not contain the preview record itself.
    expect(blocked.status).toBe(400);
    const busy = await f.post("retry", { ...input, confirmationToken: preview.confirmationToken });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: { code: "delivery_busy" } });
    expect(writer.execute({ type: "read", id: "record" })).toMatchObject({ state: "uncertain" });
  } finally { writer.close(); }
  expect((await f.post("retry", { ...input, confirmationToken: preview.confirmationToken })).status).toBe(409);
});
it("requeues only after confirmation and rejects replay without resending", async () => {
  const f = await fixture();
  const row = (await f.snapshot()).records[0]!;
  const input = { id: row.id, revision: row.revision };
  const next = await (await f.post("preview", input)).json() as { confirmationToken: string };
  const body = { ...input, confirmationToken: next.confirmationToken };
  expect((await f.post("retry", body)).status).toBe(200);
  expect((await f.snapshot()).records[0]).toMatchObject({ state: "pending", checkpoints: 0, attempt: 1 });
  expect((await f.post("retry", body)).status).toBe(409);
});
it("rejects stale previews without requeueing a changed record", async () => {
  const f = await fixture();
  const row = (await f.snapshot()).records[0]!;
  const input = { id: row.id, revision: row.revision };
  const preview = await (await f.post("preview", input)).json() as { confirmationToken: string };
  const writer = new SqliteDeliveryJournal(f.directory);
  writer.execute({ type: "state", id: row.id, from: "uncertain", to: "blocked" }); writer.close();
  expect((await f.post("retry", { ...input, confirmationToken: preview.confirmationToken })).status).toBe(409);
  expect((await f.snapshot()).records[0]?.state).toBe("blocked");
});

it("retries only the selected record without recovering other sends or deleting render files", async () => {
  const f = await fixture();
  const writer = new SqliteDeliveryJournal(f.directory);
  writer.execute({ type: "submit", value: { id: "other", account: "account", conversation: "other", payload: "OTHER BODY" } });
  writer.execute({ type: "state", id: "other", from: "pending", to: "sending" });
  writer.close();
  const image = join(f.directory, "image-ABC123");
  mkdirSync(image, { mode: 0o700 }); writeFileSync(join(image, "result.png"), "snapshot", { mode: 0o600 });
  const row = (await f.snapshot()).records.find(row => row.id === "record")!;
  const input = { id: row.id, revision: row.revision };
  const preview = await (await f.post("preview", input)).json() as { confirmationToken: string };
  expect((await f.post("retry", { ...input, confirmationToken: preview.confirmationToken })).status).toBe(200);
  expect((await f.snapshot()).records.find(row => row.id === "other")?.state).toBe("sending");
  expect(existsSync(join(image, "result.png"))).toBe(true);
});

it("rejects retry before opening the writer when audit storage is unavailable", async () => {
  const f = await fixture();
  const row = (await f.snapshot()).records[0]!;
  const input = { id: row.id, revision: row.revision };
  const preview = await (await f.post("preview", input)).json() as { confirmationToken: string };
  mkdirSync(join(f.home, "management-audit.jsonl"));
  const response = await f.post("retry", { ...input, confirmationToken: preview.confirmationToken });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "management_audit_unavailable" } });
  expect((await f.snapshot()).records[0]).toEqual(row);
});

it.each(["checkpoint", "payload-identity"])("invalidates confirmation when %s changes without changing displayed counters", async (change) => {
  const f = await fixture();
  const row = (await f.snapshot()).records[0]!;
  const input = { id: row.id, revision: row.revision };
  const preview = await (await f.post("preview", input)).json() as { confirmationToken: string };
  const db = new DatabaseSync(join(f.directory, "outbox.sqlite3"));
  if (change === "checkpoint") db.prepare("UPDATE deliveries SET progress=? WHERE id=?").run(JSON.stringify([{ operation: "OTHER", state: "confirmed", messageId: "OTHER" }]), row.id);
  else db.prepare("UPDATE deliveries SET tag=? WHERE id=?").run(Buffer.alloc(16, 0x41), row.id);
  db.close();
  const current = (await f.snapshot()).records[0]!;
  expect(current.revision).not.toBe(row.revision);
  expect({ ...current, revision: row.revision }).toEqual(row);
  expect((await f.post("retry", { ...input, confirmationToken: preview.confirmationToken })).status).toBe(409);
  expect((await f.snapshot()).records[0]?.state).toBe("uncertain");
});

it.each([false, true])("rechecks authorization and preserves conversation order after HTTP retry (authorized=%s)", async (authorized) => {
  const f = await fixture();
  const target = { surface: "feishu" as const, accountId: "main", conversationId: "chat" };
  const makeEvent = (text: string): OutputEvent => ({ type: "text.completed", target, threadId: "thread", turnId: "turn", itemId: text, phase: "final_answer", text });
  const writer = new SqliteDeliveryJournal(f.directory);
  writer.execute({ type: "resolve", id: "record", action: "confirm" });
  for (const id of ["first", "second"]) writer.execute({ type: "submit", value: {
    id, account: '["feishu","main"]', conversation: '["feishu","main","chat"]',
    payload: JSON.stringify({ version: 1, owner: "original-owner", event: makeEvent(id) }),
  } });
  writer.execute({ type: "state", id: "first", from: "pending", to: "uncertain" }); writer.close();
  const row = (await f.snapshot()).records.find(entry => entry.id === "first")!;
  const input = { id: row.id, revision: row.revision };
  const preview = await (await f.post("preview", input)).json() as { confirmationToken: string };
  expect((await f.post("retry", { ...input, confirmationToken: preview.confirmationToken })).status).toBe(200);
  const sent: string[] = [], faults: string[] = [];
  const output = new PersistentSurfaceOutput({ directory: f.directory, workerUrl: new URL("../dist/delivery/worker.js", import.meta.url),
    accounts: () => ['["feishu","main"]'], owner: () => "original-owner",
    authorized: (_event, owner) => authorized && owner === "original-owner",
    deliver: async (event, _signal, checkpoint) => {
      if (event.type !== "text.completed") throw new Error("Unexpected fixture event");
      sent.push(event.text);
      await checkpoint({ operation: "send", state: "confirmed", messageId: event.itemId });
    }, fault: code => { faults.push(code); },
  });
  try {
    await output.start();
    if (authorized) {
      await output.waitForIdle(target, AbortSignal.timeout(3000));
      expect(sent).toEqual(["first", "second"]);
      expect((await f.snapshot()).summary?.records).toBe(0);
    } else {
      await vi.waitFor(() => expect(faults).toContain("authorization-changed"));
      expect(sent).toEqual([]);
      expect((await f.snapshot()).records.map(row => row.state)).toEqual(["pending", "blocked"]);
    }
  } finally { await output.close(); }
});

it("binds batch actions to confirmation and atomically retries or ignores selected records", async () => {
  const f = await fixture();
  const writer = new SqliteDeliveryJournal(f.directory);
  writer.execute({ type: "submit", value: { id: "second", account: "a", conversation: "c", payload: "body" } });
  writer.execute({ type: "state", id: "second", from: "pending", to: "blocked" });
  writer.close();
  const entries = (await f.snapshot()).records.map(({ id, revision }) => ({ id, revision }));
  const input = { action: "ignore", entries };
  const preview = await (await f.post("batch-preview", input)).json() as { confirmationToken: string };
  expect((await f.post("batch-apply", { ...input, action: "retry", confirmationToken: preview.confirmationToken })).status).toBe(409);
  const fresh = await (await f.post("batch-preview", input)).json() as { confirmationToken: string };
  const result = await f.post("batch-apply", { ...input, confirmationToken: fresh.confirmationToken });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ result: "ignored", count: 2, auditStatus: "recorded", cleanupStatus: "closed" });
  expect((await f.snapshot()).records).toHaveLength(0);
  expect((await f.post("batch-apply", { ...input, confirmationToken: fresh.confirmationToken })).status).toBe(409);
});

it("rejects a stale batch without changing other records and retries a valid batch", async () => {
  const f = await fixture();
  const row = (await f.snapshot()).records[0]!;
  const input = { action: "retry", entries: [{ id: row.id, revision: row.revision }] };
  const preview = await (await f.post("batch-preview", input)).json() as { confirmationToken: string };
  const writer = new SqliteDeliveryJournal(f.directory);
  writer.execute({ type: "state", id: "record", from: "uncertain", to: "blocked" }); writer.close();
  expect((await f.post("batch-apply", { ...input, confirmationToken: preview.confirmationToken })).status).toBe(409);
  const current = (await f.snapshot()).records[0]!;
  const changed = { action: "retry", entries: [{ id: current.id, revision: current.revision }] };
  const next = await (await f.post("batch-preview", changed)).json() as { confirmationToken: string };
  expect((await f.post("batch-apply", { ...changed, confirmationToken: next.confirmationToken })).status).toBe(200);
  expect((await f.snapshot()).records[0]).toMatchObject({ state: "pending", checkpoints: 0 });
});

it("loads authenticated content on demand without exposing owner or raw payload and rejects stale revisions", async () => {
  const f = await fixture();
  const writer = new SqliteDeliveryJournal(f.directory);
  writer.execute({ type: "submit", value: { id: "text", account: "a", conversation: "c", payload: JSON.stringify({ version: 1, owner: "PRIVATE OWNER", event: {
    type: "text.completed", target: { surface: "telegram", accountId: "main", conversationId: "chat" }, threadId: "original-thread", turnId: "original-turn", itemId: "item", text: "A real message <script>not executed</script>",
  } }) } });
  const row = (await f.snapshot()).records.find(row => row.id === "text")!;
  try {
    const response = await f.content(row.id, row.revision);
    expect(response.status).toBe(200);
    const content = await response.json();
    expect(content).toMatchObject({ text: "A real message <script>not executed</script>", threadId: "original-thread", turnId: "original-turn", truncated: false });
    expect(JSON.stringify(content)).not.toContain("PRIVATE OWNER");
    expect((await fetch(`${f.url}/content?${new URLSearchParams({ id: row.id, revision: row.revision })}`, { headers: { origin: f.headers.origin } })).status).toBe(401);
    writer.execute({ type: "state", id: row.id, from: "pending", to: "blocked" });
    expect((await f.content(row.id, row.revision)).status).toBe(409);
  } finally { writer.close(); }
});

it("rejects duplicate batch entries and missing confirmations", async () => {
  const f = await fixture();
  const row = (await f.snapshot()).records[0]!;
  const entry = { id: row.id, revision: row.revision };
  expect((await f.post("batch-preview", { action: "ignore", entries: [entry, entry] })).status).toBe(400);
  expect((await f.post("batch-apply", { action: "ignore", entries: [entry] })).status).toBe(409);
});

// Includes 150 durable submissions and six full-page reads under shared CI I/O.
it("reads three full pages of summaries without consuming write quotas or exhausting read limits", async () => {
  const f = await fixture();
  const writer = new SqliteDeliveryJournal(f.directory);
  try {
    for (let i = 0; i < 150; i++) writer.execute({ type: "submit", value: {
      id: `summary-${i}`, account: "a", conversation: "c", payload: JSON.stringify({ version: 1, owner: "PRIVATE OWNER", event: {
        type: "text.completed", target: { surface: "telegram", accountId: "a", conversationId: "c" }, threadId: "t", turnId: "u", itemId: "i", text: "x".repeat(500),
      } }),
    } });
    let before = 0;
    for (let page = 0; page < 3; page++) {
      const snapshot = await (await fetch(`${f.url}/queue?before=${before}`, { headers: f.headers })).json() as DeliveryQueueSnapshot;
      const entries = snapshot.records.map(({ id, revision }) => ({ id, revision }));
      // Six reads also prove these do not consume the five-operation high-risk budget.
      for (let repeat = 0; repeat < 2; repeat++) {
        const response = await f.post("content-batch", { entries });
        expect(response.status).toBe(200);
        const body = await response.json() as { records: Array<{ content: { text: string; truncated: boolean } }> };
        expect(body.records).toHaveLength(50);
        expect(body.records.every(row => row.content.text.length === 160 && row.content.truncated)).toBe(true);
        expect(JSON.stringify(body)).not.toContain("PRIVATE OWNER");
      }
      before = snapshot.nextCursor!;
    }
    const row = (await f.snapshot()).records[0]!;
    const good = (await f.snapshot()).records[1]!;
    const entries = [{ id: row.id, revision: row.revision }];
    expect((await f.post("content-batch", { entries: [] })).status).toBe(400);
    expect((await f.post("content-batch", { entries: [...entries, ...entries] })).status).toBe(400);
    expect((await f.post("content-batch", { entries: Array.from({ length: 51 }, (_, i) => ({ id: String(i), revision: row.revision })) })).status).toBe(400);
    expect((await fetch(`${f.url}/content-batch`, { method: "POST", headers: { ...f.headers, origin: "https://evil.invalid" }, body: JSON.stringify({ entries }) })).status).toBe(403);
    expect((await fetch(`${f.url}/content-batch`, { method: "POST", headers: { origin: f.headers.origin, "content-type": "application/json" }, body: JSON.stringify({ entries }) })).status).toBe(401);
    writer.execute({ type: "state", id: row.id, from: "pending", to: "blocked" });
    const result = await (await f.post("content-batch", { entries: [...entries, { id: good.id, revision: good.revision }] })).json() as { records: Array<{ content: unknown }> };
    expect(result.records[0]?.content).toBeNull();
    expect(result.records[1]?.content).toMatchObject({ text: "x".repeat(160) });
  } finally { writer.close(); }
}, process.platform === "win32" ? 120_000 : 30_000);

it.each([{ action: "retry", authorized: true }, { action: "ignore", authorized: true }, { action: "retry", authorized: false }] as const)("processes $action through the live Gateway writer (authorized=$authorized)", async ({ action, authorized }) => {
  const f = await fixture();
  const writer = new SqliteDeliveryJournal(f.directory);
  writer.execute({ type: "resolve", id: "record", action: "confirm" });
  const target = { surface: "feishu" as const, accountId: "main", conversationId: "chat" };
  for (const id of ["first", "second"]) writer.execute({ type: "submit", value: {
    id, account: '["feishu","main"]', conversation: '["feishu","main","chat"]', payload: JSON.stringify({ version: 1, owner: "owner", event: {
      type: "text.completed", target, threadId: "t", turnId: "u", itemId: id, text: id,
    } }),
  } });
  writer.execute({ type: "state", id: "first", from: "pending", to: "uncertain" }); writer.close();
  const sent: string[] = [];
  let checks = 0;
  const output = new PersistentSurfaceOutput({ directory: f.directory, workerUrl: new URL("../dist/delivery/worker.js", import.meta.url),
    accounts: () => ['["feishu","main"]'], owner: () => "owner", authorized: (_event, owner) => { checks++; return authorized && owner === "owner"; },
    deliver: async event => { if (event.type === "text.completed") sent.push(event.text); }, fault: () => {},
  });
  try {
    await output.start();
    const row = (await f.snapshot()).records.find(row => row.id === "first")!;
    const input = { action, entries: [{ id: row.id, revision: row.revision }] };
    const preview = await (await f.post("batch-preview", input)).json() as { confirmationToken: string };
    const response = await f.post("batch-apply", { ...input, confirmationToken: preview.confirmationToken });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: action === "retry" ? "pending" : "ignored", auditStatus: "recorded" });
    if (authorized) {
      await output.waitForIdle(target, AbortSignal.timeout(3000));
      expect(sent).toEqual(action === "retry" ? ["first", "second"] : ["second"]);
      expect((await f.snapshot()).summary?.records).toBe(0);
    } else {
      await vi.waitFor(async () => expect((await f.snapshot()).records.find(row => row.id === "first")?.state).toBe("blocked"));
      expect(sent).toEqual([]);
    }
    expect(checks).toBeGreaterThan(0);
    expect((await f.post("batch-apply", { ...input, confirmationToken: preview.confirmationToken })).status).toBe(409);
  } finally { await output.close(); }
});

it("does not fall back to an offline mutation after losing an online response", async () => {
  const f = await fixture();
  const server = new PrivateIpcServer(deliveryControlSocketPath(f.directory), socket => {
    socket.on("error", () => {});
    socket.once("data", () => socket.destroy());
  });
  await server.start("occupied");
  try {
    const row = (await f.snapshot()).records[0]!;
    const input = { action: "ignore", entries: [{ id: row.id, revision: row.revision }] };
    const preview = await (await f.post("batch-preview", input)).json() as { confirmationToken: string };
    const response = await f.post("batch-apply", { ...input, confirmationToken: preview.confirmationToken });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "delivery_unconfirmed" } });
    expect((await f.snapshot()).records[0]?.id).toBe(row.id);
  } finally { await server.close(); }
});
