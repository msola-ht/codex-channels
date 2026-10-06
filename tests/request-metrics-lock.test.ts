import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireRequestMetricsDatabaseLock } from "../src/observability/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("request metrics database lock", () => {

  it.skipIf(process.platform === "win32")("keeps a lock held by the current process lifetime fail-closed", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const lockPath = `${path}.lock`;
    const owner = acquireRequestMetricsDatabaseLock(path);

    expect(() => acquireRequestMetricsDatabaseLock(path)).toThrow(/正在使用/u);
    expect(existsSync(`${lockPath}.sqlite3`)).toBe(true);
    expect(statSync(`${lockPath}.sqlite3`).mode & 0o777).toBe(0o600);

    owner.release();
    expect(existsSync(`${lockPath}.sqlite3`)).toBe(true);
  });

  it("uses a kernel lock that is released when its owner process exits", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const lockDatabasePath = `${path}.lock.sqlite3`;
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[1]);
database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
process.stdout.write("ready\\n");
setInterval(() => undefined, 1_000);`,
        lockDatabasePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolveReady, rejectReady) => {
      owner.stdout.once("data", () => resolveReady());
      owner.once("error", rejectReady);
      owner.once("exit", (code) => rejectReady(new Error(`锁进程提前退出：${code}`)));
    });
    let unexpectedLock: ReturnType<typeof acquireRequestMetricsDatabaseLock> | undefined;
    try {
      expect(() => {
        unexpectedLock = acquireRequestMetricsDatabaseLock(path);
      }).toThrow(/正在使用/u);
    } finally {
      unexpectedLock?.release();
      owner.kill("SIGKILL");
      await new Promise<void>((resolveExit) => owner.once("exit", () => resolveExit()));
    }

    const recovered = acquireRequestMetricsDatabaseLock(path);
    recovered.release();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}
