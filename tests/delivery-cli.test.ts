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

it("provides exact short and long help paths and rejects unsafe syntax before creating data", () => {
  const { home, run } = fixture();
  for (const flag of ["-h", "--help"]) {
    for (const path of [[], ["status"], ["list"], ["retry"], ["confirm"]]) {
      const result = run("delivery", ...path, flag);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("codexc delivery");
    }
  }
  for (const args of [["retry", "id"], ["confirm", "id"], ["unknown", "--help"], ["status", "--help", "extra"]]) {
    expect(run("delivery", ...args).status).toBe(1);
  }
  expect(existsSync(home)).toBe(false);
});

it("lists safe metadata, rejects concurrent maintenance and requires explicit retry or confirmation", () => {
  const { home, run } = fixture();
  const initialized = run("init");
  expect(initialized.status, initialized.stderr).toBe(0);
  const directory = join(home, "data", "delivery-outbox");
  let store = new SqliteDeliveryJournal(directory);
  store.execute({ type: "submit", value: { id: "test-result", account: "account", conversation: "chat", payload: "PRIVATE BODY" } });
  store.execute({ type: "state", id: "test-result", from: "pending", to: "uncertain" });
  const conflict = run("delivery", "status");
  expect(conflict.status).toBe(1);
  expect(conflict.stderr).toContain("conflict");
  store.close();
  const listed = run("delivery", "list");
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout).toContain("test-result");
  expect(listed.stdout).not.toContain("PRIVATE BODY");
  expect(run("delivery", "retry", "test-result").status).toBe(1);
  expect(run("delivery", "retry", "test-result", "--allow-duplicate").status).toBe(0);
  store = new SqliteDeliveryJournal(directory);
  expect(store.execute({ type: "next", excluded: [] })).toMatchObject({ id: "test-result", state: "pending" });
  store.execute({ type: "state", id: "test-result", from: "pending", to: "uncertain" });
  store.close();
  expect(run("delivery", "confirm", "test-result", "--confirmed-delivered").status).toBe(0);
  expect(JSON.parse(run("delivery", "status").stdout)).toMatchObject({ records: 0 });
});
