import { assertPrivateDirectoryAccessSync, assertPrivateFileAccessSync, securePrivateDirectorySync } from "../../runtime/private-file.mjs";
import { constants, closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GatewayConfig } from "../config/index.js";
import { DeliveryJournal } from "../surfaces/index.js";

/** First-use backup is independent of the binding schema and never rewrites it. */
export function prepareDeliveryJournal(config: GatewayConfig, configPath?: string): DeliveryJournal {
  const directory = join(dirname(config.stateDatabasePath), "delivery-v1");
  const journal = new DeliveryJournal(directory);
  try {
    const backup = join(directory, "pre-enable-backup");
    const backupExisted = existsSync(backup);
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    if (!backupExisted && process.platform === "win32") securePrivateDirectorySync(backup);
    requirePrivate(backup, true);
    const manifestPath = join(backup, "complete.json");
    if (existsSync(manifestPath)) {
      requirePrivate(manifestPath, false);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown; config?: unknown; bindings?: unknown };
      if (manifest.version !== 1 || typeof manifest.config !== "boolean" || typeof manifest.bindings !== "boolean") throw new Error("消息日志备份清单不受支持");
      if (manifest.config) requirePrivate(join(backup, "config.toml"), false);
      if (manifest.bindings) verifyDatabase(join(backup, "bindings.sqlite"));
      return journal;
    }
    const databasePath = join(backup, "bindings.sqlite");
    const hasBindings = existsSync(config.stateDatabasePath);
    if (hasBindings) {
      if (!existsSync(databasePath)) {
        const database = new DatabaseSync(config.stateDatabasePath, { readOnly: true });
        try { database.prepare("VACUUM INTO ?").run(databasePath); }
        finally { database.close(); }
        const fd = openSync(databasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fchmodSync(fd, 0o600); fsyncSync(fd); } finally { closeSync(fd); }
      }
      verifyDatabase(databasePath);
    }
    const savedConfig = join(backup, "config.toml");
    if (configPath) {
      if (!existsSync(savedConfig)) writePrivate(savedConfig, readFileSync(configPath));
      requirePrivate(savedConfig, false);
      if (!readFileSync(savedConfig).equals(readFileSync(configPath))) throw new Error("未完成的配置备份与当前配置不同，请人工核对后恢复备份流程");
    }
    writePrivate(manifestPath, Buffer.from(JSON.stringify({ version: 1, createdAt: Date.now(), config: Boolean(configPath), bindings: hasBindings })));
    if (process.platform !== "win32") {
      for (const path of [backup, directory]) {
        const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
    return journal;
  } catch (error) { journal.close(); throw error; }
}
function verifyDatabase(path: string): void {
  requirePrivate(path, false);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (result.quick_check !== "ok") throw new Error("绑定数据库备份校验失败");
  } finally { database.close(); }
}
function requirePrivate(path: string, directory: boolean): void {
  if (process.platform === "win32") {
    if (directory) assertPrivateDirectoryAccessSync(path);
    else assertPrivateFileAccessSync(path);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("消息日志备份路径不是当前用户的私有路径");
}
function writePrivate(path: string, value: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}
