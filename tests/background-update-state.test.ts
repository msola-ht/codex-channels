import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  copyUpdateRunner, createUpdateDirectory, listUpdateJobIds, readActiveUpdate, readUpdateJob,
  readUpdateReceipt, releaseUpdate, reserveUpdate, snapshotLocalSource, withUpdateLock,
  writeUpdateJob, writeUpdateReceipt,
  type UpdateJob,
} from "../scripts/background-update-state.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync("/tmp/codexc-update-state-");
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function job(id: string): UpdateJob {
  return { formatVersion: 1, id, createdAt: new Date().toISOString(), originalSourceDirectory: "/source",
    sourceCommit: "a".repeat(40), snapshotSha256: "b".repeat(64), installedDirectory: "/installed",
    npmPrefix: "/prefix", nodeBinary: process.execPath, environment: { HOME: "/home/test" },
    unitName: `codexc-update-${id}` };
}
function git(directory: string, args: string[]) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" });
}
function sourceFixture() {
  const root = fixture();
  const source = join(root, "source with spaces");
  mkdirSync(source);
  git(source, ["init", "--quiet"]);
  writeFileSync(join(source, "tracked.txt"), "original");
  writeFileSync(join(source, "deleted.txt"), "deleted");
  writeFileSync(join(source, ".gitignore"), "ignored.txt\n");
  git(source, ["add", "."]);
  git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"]);
  return { root, source };
}

describe("后台更新任务状态", () => {
  it("freezes strict private job definitions and atomically replaces receipts", () => {
    const root = fixture();
    const id = randomUUID();
    const directory = createUpdateDirectory(root, id);
    const definition = job(id);
    writeUpdateJob(root, definition);
    expect(readUpdateJob(root, id)).toEqual(definition);
    expect(() => writeUpdateJob(root, job(id))).toThrow("冻结");
    writeUpdateReceipt(root, id, { formatVersion: 1, id, updatedAt: new Date().toISOString(), status: "queued", stage: "queued" });
    writeUpdateReceipt(root, id, { formatVersion: 1, id, updatedAt: new Date().toISOString(), status: "succeeded", stage: "complete" });
    expect(readUpdateReceipt(root, id).status).toBe("succeeded");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "job.json")).mode & 0o777).toBe(0o600);
    expect(listUpdateJobIds(root)).toEqual([id]);
    createUpdateDirectory(root, randomUUID());
    expect(listUpdateJobIds(root)).toEqual([id]);
  });

  it("rejects unsupported schemas, environment leakage, path traversal and nonprivate documents", () => {
    const root = fixture();
    const id = randomUUID();
    const directory = createUpdateDirectory(root, id);
    expect(() => createUpdateDirectory(root, "../escape")).toThrow("ID");
    expect(() => writeUpdateJob(root, { ...job(id), environment: { TOKEN: "private" } })).toThrow("环境");
    writeUpdateJob(root, job(id));
    const path = join(directory, "job.json");
    writeFileSync(path, JSON.stringify({ ...job(id), formatVersion: 2 }));
    expect(() => readUpdateJob(root, id)).toThrow("格式");
    writeFileSync(path, JSON.stringify(job(id)));
    chmodSync(path, 0o644);
    expect(() => readUpdateJob(root, id)).toThrow("权限");
    expect(() => readUpdateReceipt(root, id)).toThrow();
    expect(existsSync(join(directory, "receipt.json"))).toBe(false);
  });

  it("preserves dirty and untracked files while isolating the submitted snapshot", () => {
    const { root, source } = sourceFixture();
    writeFileSync(join(source, "tracked.txt"), "dirty");
    rmSync(join(source, "deleted.txt"));
    writeFileSync(join(source, "new.txt"), "untracked");
    chmodSync(join(source, "new.txt"), 0o755);
    writeFileSync(join(source, "ignored.txt"), "ignored");
    mkdirSync(join(source, "node_modules"));
    writeFileSync(join(source, "node_modules", "module.txt"), "dependency");
    const before = git(source, ["status", "--porcelain"]);
    const destination = join(root, "snapshot");
    const result = snapshotLocalSource(source, destination);
    expect(result.sourceCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(result.snapshotSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(join(destination, "tracked.txt"), "utf8")).toBe("dirty");
    expect(readFileSync(join(destination, "new.txt"), "utf8")).toBe("untracked");
    for (const name of [".git", "node_modules", "ignored.txt", "deleted.txt"]) expect(existsSync(join(destination, name))).toBe(false);
    expect(git(source, ["status", "--porcelain"])).toBe(before);
    writeFileSync(join(source, "tracked.txt"), "later");
    expect(readFileSync(join(destination, "tracked.txt"), "utf8")).toBe("dirty");
  });

  it("rejects source symlinks and task directories inside the source", () => {
    const { root, source } = sourceFixture();
    expect(() => snapshotLocalSource(source, join(source, "snapshot"))).toThrow("内部");
    symlinkSync("/etc/passwd", join(source, "escape"));
    expect(() => snapshotLocalSource(source, join(root, "snapshot"))).toThrow("符号链接");
  });

  it("rejects symlink ancestors before creating any task directories", () => {
    const root = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "redirect"));
    expect(() => createUpdateDirectory(join(root, "redirect", "updates"))).toThrow("符号链接");
    expect(existsSync(join(outside, "updates"))).toBe(false);
  });

  it("copies the complete installed runner and internal dependency links but rejects external links", () => {
    const root = fixture();
    const installed = join(root, "installed");
    mkdirSync(join(installed, "node_modules", "dep"), { recursive: true });
    mkdirSync(join(installed, "node_modules", ".bin"));
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@hegenai/codexc" }));
    writeFileSync(join(installed, "node_modules", "dep", "run.js"), "runner");
    symlinkSync("../dep/run.js", join(installed, "node_modules", ".bin", "run"));
    copyUpdateRunner(installed, join(root, "runner"));
    expect(readFileSync(join(root, "runner", "node_modules", ".bin", "run"), "utf8")).toBe("runner");
    symlinkSync("/etc/passwd", join(installed, "external"));
    expect(() => copyUpdateRunner(installed, join(root, "runner2"))).toThrow("外部");
  });

  it.skipIf(process.platform !== "linux")("serializes foreground and background operations while retaining reservations", async () => {
    const root = fixture();
    const id = randomUUID();
    await withUpdateLock(root, async () => {
      reserveUpdate(root, id);
      expect(readActiveUpdate(root)).toBe(id);
      await expect(withUpdateLock(root, () => undefined)).rejects.toThrow("正在运行");
      const competing = spawnSync("flock", ["--nonblock", "--conflict-exit-code", "73", join(root, "update.lock"), "true"]);
      expect(competing.status).toBe(73);
      expect(() => reserveUpdate(root, randomUUID())).toThrow("占用");
      expect(() => releaseUpdate(root, randomUUID())).toThrow("其他");
    });
    await expect(withUpdateLock(root, () => {
      expect(readActiveUpdate(root)).toBe(id);
      releaseUpdate(root, id);
      return "released";
    })).resolves.toBe("released");
    expect(readActiveUpdate(root)).toBeUndefined();
    await expect(withUpdateLock(root, () => { throw new Error("fixture"); })).rejects.toThrow("fixture");
    await expect(withUpdateLock(root, () => "recovered")).resolves.toBe("recovered");
  });
});
