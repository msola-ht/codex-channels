import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withPrivateFileLock } from "../runtime/private-file-lock.mjs";

describe("private file lock", () => {
  it("serializes asynchronous transactions for the same target", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "codexc-private-lock-")), "state");
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const order: string[] = [];

    const first = withPrivateFileLock(target, async () => {
      order.push("first-start");
      markFirstEntered();
      await firstMayFinish;
      order.push("first-end");
    });
    await firstEntered;
    const second = withPrivateFileLock(target, async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  it("does not remove a replacement lock owned by another writer", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "codexc-private-lock-replace-")), "state");
    const lockPath = `${target}.lock`;

    await withPrivateFileLock(target, () => {
      unlinkSync(lockPath);
      writeFileSync(lockPath, "replacement\n", { mode: 0o600 });
    });

    expect(readFileSync(lockPath, "utf8")).toBe("replacement\n");
  });

  it("preserves an undefined operation rejection", async () => {
    const target = join(mkdtempSync(join(tmpdir(), "codexc-private-lock-error-")), "state");
    let rejected = false;

    try {
      await withPrivateFileLock(target, () => Promise.reject(undefined));
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }

    expect(rejected).toBe(true);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });
});
