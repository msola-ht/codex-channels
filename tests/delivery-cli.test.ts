import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { SqliteDeliveryJournal } from "../src/delivery/sqlite-journal.js";

const directories: string[] = [];
const cli = resolve("bin/codexc.mjs");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delivery-cli-"));
  directories.push(root);
  const home = join(root, "home");
  // Match the public executable shebang; SQLite runs in the journal Worker.
  const run = (...args: string[]) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: "" },
  });
  return { root, home, run };
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it.each(["scripts/delivery-command.mjs", "dist/surfaces/delivery-diagnostics/index.js"])(
  "loads %s without platform SDKs or SQLite in the CLI process", (entry) => {
    const loader = `export async function resolve(specifier, context, next) {
      if (specifier === 'node:sqlite' || specifier === 'grammy' || specifier.startsWith('@larksuiteoapi/')) {
        throw new Error('Unexpected CLI dependency: ' + specifier);
      }
      return next(specifier, context);
    }`;
    const script = `import { register } from 'node:module';
      register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});
      await import(${JSON.stringify(pathToFileURL(resolve(entry)).href)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  },
);

it.each(["-h", "--help"].flatMap((flag) =>
  [[], ["status"], ["list"], ["retry"], ["confirm"]].map((path) => ({ args: [...path, flag] })),
))("provides delivery help for $args without creating data", ({ args }) => {
  const { home, run } = fixture();
  const result = run("delivery", ...args);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("codexc delivery");
  expect(result.stderr).toBe("");
  expect(existsSync(home)).toBe(false);
});

it.each([["retry", "id"], ["confirm", "id"], ["unknown", "--help"], ["status", "--help", "extra"]].map((args) => ({ args })))(
  "rejects unsafe delivery syntax $args before creating data", ({ args }) => {
    const { home, run } = fixture();
    expect(run("delivery", ...args).status).toBe(1);
    expect(existsSync(home)).toBe(false);
  },
);

function uncertainResultFixture() {
  const value = fixture();
  const initialized = value.run("init");
  expect(initialized.status, initialized.stderr).toBe(0);
  const directory = join(value.home, "data", "delivery-outbox");
  const store = new SqliteDeliveryJournal(directory);
  try {
    store.execute({ type: "submit", value: { id: "test-result", account: "account", conversation: "chat", payload: JSON.stringify({ version: 1, owner: "PRIVATE OWNER", event: { type: "text.completed", target: { surface: "feishu", accountId: "account", conversationId: "chat" }, threadId: "thread", turnId: "turn", itemId: "item", phase: "final_answer", text: "PRIVATE BODY" } }) } });
    store.execute({ type: "state", id: "test-result", from: "pending", to: "uncertain" });
  } finally { store.close(); }
  return { ...value, directory };
}

it("lists safe metadata and rejects concurrent maintenance", () => {
  const { directory, run } = uncertainResultFixture();
  const store = new SqliteDeliveryJournal(directory);
  try {
    const conflict = run("delivery", "status");
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("投递箱正被其他进程占用");
    expect(conflict.stderr).toContain("codexc service stop gateway");
    expect(store.execute({ type: "summary" })).toMatchObject({ records: 1, uncertain: 1 });
  } finally { store.close(); }
  const listed = run("delivery", "list");
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stderr).toBe("");
  expect(listed.stdout).toContain("test-result");
  expect(listed.stdout).not.toContain("PRIVATE BODY");
  expect(listed.stdout).not.toContain("PRIVATE OWNER");
  expect(JSON.parse(listed.stdout)).toMatchObject({ eventType: "text.completed", threadId: "thread", turnId: "turn", blocksFollowing: true, blocksExecution: false });
});

it("requires explicit retry and preserves the result as pending", () => {
  const { directory, run } = uncertainResultFixture();
  expect(run("delivery", "retry", "test-result").status).toBe(1);
  expect(run("delivery", "retry", "test-result", "--allow-duplicate").status).toBe(0);
  const store = new SqliteDeliveryJournal(directory);
  try { expect(store.execute({ type: "next", excluded: [] })).toMatchObject({ id: "test-result", state: "pending" }); }
  finally { store.close(); }
});

it("removes a result only after explicit delivered confirmation", () => {
  const { run } = uncertainResultFixture();
  expect(run("delivery", "confirm", "test-result", "--confirmed-delivered").status).toBe(0);
  const status = run("delivery", "status");
  expect(status.status, status.stderr).toBe(0);
  expect(status.stderr).toBe("");
  expect(JSON.parse(status.stdout)).toMatchObject({ records: 0 });
});

it("distinguishes retained notices, queued output and manual barriers without leaking content", () => {
  const { home, run } = fixture();
  expect(run("init").status).toBe(0);
  const store = new SqliteDeliveryJournal(join(home, "data", "delivery-outbox"));
  try {
    for (const [id, type, status, state, kind = "contextCompaction"] of [
      ["notice", "thread.name", null, "uncertain"],
      ["compact-start", "operation.updated", "running", "uncertain"],
      ["compact-end", "operation.updated", "completed", "uncertain"],
      ["command-end", "operation.updated", "completed", "uncertain", "command"],
      ["command-error", "operation.updated", "failed", "uncertain", "command"],
      ["queued", "thread.name", null, "pending"],
      ["revoked", "thread.name", null, "blocked"],
    ] as const) {
      const event = { type, threadId: "thread", turnId: "turn", name: "PRIVATE NAME", target: { surface: "feishu", accountId: "a", conversationId: "c" },
        ...(status ? { operation: { kind, itemId: "compact", status } } : {}) };
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
    { id: "compact-end", blocksFollowing: true, blocksExecution: false },
    { id: "command-end", blocksFollowing: false, blocksExecution: false },
    { id: "command-error", blocksFollowing: true, blocksExecution: false },
    { id: "queued", blocksFollowing: true, blocksExecution: false },
    { id: "revoked", blocksFollowing: false, blocksExecution: false },
  ]);
  expect(rows[1]).toMatchObject({ operationKind: "contextCompaction", operationStatus: "running", threadId: "thread", turnId: "turn" });
  expect(JSON.parse(run("delivery", "status").stdout)).toMatchObject({ records: 7, uncertain: 5, pending: 1, blocked: 1, retainedNotices: 4, blockingRecords: 3, blockedConversations: 1 });
});
