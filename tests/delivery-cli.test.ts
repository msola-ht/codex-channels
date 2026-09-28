import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SqliteDeliveryJournal } from "../src/delivery/sqlite-journal.js";

const directories: string[] = [];
const cli = resolve("bin/codexc.mjs");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delivery-cli-"));
  directories.push(root);
  const home = join(root, "home");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: "" },
  });
  return { root, home, run };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it.each(["-h", "--help"].flatMap((flag) =>
  [[], ["status"], ["list"], ["retry"], ["confirm"]].map((path) => ({ args: [...path, flag] })),
))("provides delivery help for $args without creating data", ({ args }) => {
  const { home, run } = fixture();
  const result = run("delivery", ...args);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("codexc delivery");
  expect(existsSync(home)).toBe(false);
});

it.each([["retry", "id"], ["confirm", "id"], ["unknown", "--help"], ["status", "--help", "extra"]].map((args) => ({ args })))(
  "rejects unsafe delivery syntax $args before creating data", ({ args }) => {
    const { home, run } = fixture();
    expect(run("delivery", ...args).status).toBe(1);
    expect(existsSync(home)).toBe(false);
  },
);

it("lists safe metadata, rejects concurrent maintenance and requires explicit retry or confirmation", () => {
  const { home, run } = fixture();
  const initialized = run("init");
  expect(initialized.status, initialized.stderr).toBe(0);
  const directory = join(home, "data", "delivery-outbox");
  let store = new SqliteDeliveryJournal(directory);
  store.execute({ type: "submit", value: { id: "test-result", account: "account", conversation: "chat", payload: JSON.stringify({ version: 1, owner: "PRIVATE OWNER", event: { type: "text.completed", target: { surface: "feishu", accountId: "account", conversationId: "chat" }, threadId: "thread", turnId: "turn", itemId: "item", phase: "final_answer", text: "PRIVATE BODY" } }) } });
  store.execute({ type: "state", id: "test-result", from: "pending", to: "uncertain" });
  const conflict = run("delivery", "status");
  expect(conflict.status).toBe(1);
  expect(conflict.stderr).toContain("conflict");
  store.close();
  const listed = run("delivery", "list");
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout).toContain("test-result");
  expect(listed.stdout).not.toContain("PRIVATE BODY");
  expect(listed.stdout).not.toContain("PRIVATE OWNER");
  expect(JSON.parse(listed.stdout)).toMatchObject({ eventType: "text.completed", threadId: "thread", turnId: "turn", blocksFollowing: true, blocksExecution: true });
  expect(run("delivery", "retry", "test-result").status).toBe(1);
  expect(run("delivery", "retry", "test-result", "--allow-duplicate").status).toBe(0);
  store = new SqliteDeliveryJournal(directory);
  expect(store.execute({ type: "next", excluded: [] })).toMatchObject({ id: "test-result", state: "pending" });
  store.execute({ type: "state", id: "test-result", from: "pending", to: "uncertain" });
  store.close();
  expect(run("delivery", "confirm", "test-result", "--confirmed-delivered").status).toBe(0);
  expect(JSON.parse(run("delivery", "status").stdout)).toMatchObject({ records: 0 });
});


it("distinguishes retained notices, queued output and manual barriers without leaking content", () => {
  const { home, run } = fixture();
  expect(run("init").status).toBe(0);
  const store = new SqliteDeliveryJournal(join(home, "data", "delivery-outbox"));
  try {
    for (const [id, type, status, state] of [
      ["notice", "thread.name", null, "uncertain"],
      ["compact-start", "operation.updated", "running", "uncertain"],
      ["compact-end", "operation.updated", "completed", "uncertain"],
      ["queued", "thread.name", null, "pending"],
      ["revoked", "thread.name", null, "blocked"],
    ] as const) {
      const event = { type, threadId: "thread", turnId: "turn", name: "PRIVATE NAME", target: { surface: "feishu", accountId: "a", conversationId: "c" },
        ...(status ? { operation: { kind: "contextCompaction", itemId: "compact", status } } : {}) };
      store.execute({ type: "submit", value: { id, account: "a", conversation: "c", payload: JSON.stringify({ version: 1, owner: "PRIVATE OWNER", event }) } });
      if (state !== "pending") store.execute({ type: "state", id, from: "pending", to: state });
    }
  } finally { store.close(); }
  const result = run("delivery", "list");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toContain("PRIVATE");
  const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows.map(({ id, blocksFollowing, blocksExecution }) => ({ id, blocksFollowing, blocksExecution }))).toEqual([
    { id: "notice", blocksFollowing: false, blocksExecution: false },
    { id: "compact-start", blocksFollowing: false, blocksExecution: false },
    { id: "compact-end", blocksFollowing: true, blocksExecution: true },
    { id: "queued", blocksFollowing: true, blocksExecution: false },
    { id: "revoked", blocksFollowing: true, blocksExecution: true },
  ]);
  expect(rows[1]).toMatchObject({ operationKind: "contextCompaction", operationStatus: "running", threadId: "thread", turnId: "turn" });
  expect(JSON.parse(run("delivery", "status").stdout)).toMatchObject({ records: 5, uncertain: 3, pending: 1, blocked: 1, retainedNotices: 2, blockingRecords: 3, blockedConversations: 1 });
});
