import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inspectThreadWriterLock,
  processCommandLine,
  terminateThreadWriterHolder,
  threadWriterLockHolders,
} from "../runtime/thread-writer-lock.mjs";

describe("thread writer lock diagnostics", () => {
  it("finds the local process holding a thread lock through /proc", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-thread-lock-"));
    const codexHome = join(root, "codex-home");
    const lockDirectory = join(codexHome, "thread-writer-locks");
    const lockPath = join(lockDirectory, "thread-1.lock");
    const procRoot = join(root, "proc");
    const pid = 12345;
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(lockPath, "");
    mkdirSync(join(procRoot, String(pid), "fd"), { recursive: true });
    symlinkSync(lockPath, join(procRoot, String(pid), "fd", "3"));
    writeFileSync(
      join(procRoot, String(pid), "cmdline"),
      "codex\0app-server\0--listen\0unix:///tmp/codex.sock",
    );

    expect(threadWriterLockHolders(lockPath, procRoot)).toEqual([pid]);
    expect(processCommandLine(pid, procRoot))
      .toBe("codex app-server --listen unix:///tmp/codex.sock");
  });

  it("treats a missing lock file as free", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-thread-lock-free-"));
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome, { recursive: true });

    expect(inspectThreadWriterLock("thread-missing", {
      ...process.env,
      CODEX_HOME: codexHome,
    }, join(root, "proc"))).toEqual({ held: false });
  });

  it("treats an unreadable process table as unidentifiable instead of free", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-thread-lock-proc-"));
    const codexHome = join(root, "codex-home");
    const lockDirectory = join(codexHome, "thread-writer-locks");
    const procRoot = join(root, "not-a-directory");
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(join(lockDirectory, "thread-3.lock"), "");
    writeFileSync(procRoot, "");

    expect(inspectThreadWriterLock("thread-3", {
      ...process.env,
      CODEX_HOME: codexHome,
    }, procRoot)).toEqual({ held: true, holder: null });
  });

  it.skipIf(process.platform !== "linux")(
    "reports the holder through inspectThreadWriterLock",
    () => {
      const root = mkdtempSync(join(tmpdir(), "codexc-thread-lock-holder-"));
      const codexHome = join(root, "codex-home");
      const lockDirectory = join(codexHome, "thread-writer-locks");
      const lockPath = join(lockDirectory, "thread-2.lock");
      const procRoot = join(root, "proc");
      const pid = 23456;
      mkdirSync(lockDirectory, { recursive: true });
      writeFileSync(lockPath, "");
      mkdirSync(join(procRoot, String(pid), "fd"), { recursive: true });
      symlinkSync(lockPath, join(procRoot, String(pid), "fd", "5"));
      writeFileSync(join(procRoot, String(pid), "cmdline"), "codex\0exec");

      expect(inspectThreadWriterLock("thread-2", {
        ...process.env,
        CODEX_HOME: codexHome,
      }, procRoot)).toEqual({
        held: true,
        holder: { pid, command: "codex exec" },
      });
    },
  );

  it("treats an already exited holder as terminated", async () => {
    await expect(terminateThreadWriterHolder(Number.MAX_SAFE_INTEGER))
      .resolves.toBe(true);
  });
});
