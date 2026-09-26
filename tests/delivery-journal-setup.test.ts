import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { prepareDeliveryJournal } from "../src/bootstrap/delivery-journal-setup.js";
import type { GatewayConfig } from "../src/config/index.js";
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "delivery-backup-test-")); temporary.push(directory);
  const stateDatabasePath = join(directory, "bindings.sqlite");
  const db = new DatabaseSync(stateDatabasePath);
  db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('binding');"); db.close(); chmodSync(stateDatabasePath, 0o600);
  const configPath = join(directory, "config.toml"); writeFileSync(configPath, "private config", { mode: 0o600 });
  return { directory, configPath, config: { stateDatabasePath } as GatewayConfig };
}
it("backs up configuration and bindings privately without changing the original database", () => {
  const { directory, config, configPath } = fixture();
  const before = readFileSync(config.stateDatabasePath);
  const journal = prepareDeliveryJournal(config, configPath);
  try {
    const backup = join(directory, "delivery-v1", "pre-enable-backup");
    expect(readFileSync(join(backup, "config.toml"), "utf8")).toBe("private config");
    const db = new DatabaseSync(join(backup, "bindings.sqlite"), { readOnly: true });
    try { expect(db.prepare("SELECT value FROM fixture").get()).toMatchObject({ value: "binding" }); } finally { db.close(); }
    expect(readFileSync(config.stateDatabasePath)).toEqual(before);
    if (process.platform !== "win32") expect(statSync(join(backup, "bindings.sqlite")).mode & 0o777).toBe(0o600);
  } finally { journal.close(); }
  const reopened = prepareDeliveryJournal(config, configPath); reopened.close();
});
it.skipIf(process.platform === "win32")("rejects a replaced backup directory without following its symlink", () => {
  const { directory, config, configPath } = fixture();
  const journal = prepareDeliveryJournal(config, configPath); journal.close();
  const backup = join(directory, "delivery-v1", "pre-enable-backup");
  rmSync(backup, { recursive: true }); symlinkSync(directory, backup);
  expect(() => prepareDeliveryJournal(config, configPath)).toThrow("私有路径");
});
