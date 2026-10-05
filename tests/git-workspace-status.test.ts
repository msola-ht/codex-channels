import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { currentGitBranch } from "../src/bootstrap/git-workspace-status.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("currentGitBranch", () => {
  it("reads the active branch from the authorized Workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codex-git-status-"));
    temporaryDirectories.push(workspace);
    execFileSync(
      "git",
      ["init", "--quiet", "--initial-branch", "feature/weixin-surface"],
      {
        cwd: workspace,
        stdio: "ignore",
      },
    );

    expect(await currentGitBranch(workspace)).toBe("feature/weixin-surface");
  });

  it("returns no branch for a non-Git Workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "codex-git-status-"));
    temporaryDirectories.push(workspace);

    expect(await currentGitBranch(workspace)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("does not block another Conversation while Git is slow", async () => {
    const workspace = fakeGit(150);
    let completed = false;
    const branch = currentGitBranch(workspace).then((value) => { completed = true; return value; });
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(completed).toBe(false);
    expect(await branch).toBe("feature/async");
  });

  it.skipIf(process.platform === "win32").each(["cancel", "timeout"] as const)("kills a stalled Git child on %s", async (reason) => {
    const workspace = fakeGit(60_000);
    const controller = new AbortController();
    const branch = currentGitBranch(workspace, controller.signal);
    const pidPath = join(workspace, "pid");
    await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
    const pid = Number(readFileSync(pidPath, "utf8"));
    if (reason === "cancel") controller.abort();
    expect(await branch).toBeUndefined();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it.skipIf(process.platform === "win32").each([513, 5_000])("omits an oversized Git result of %s bytes", async (length) => {
    const workspace = fakeGit(0, "x".repeat(length));
    expect(await currentGitBranch(workspace)).toBeUndefined();
  });

  it("does not start a child after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await currentGitBranch("/unavailable", controller.signal)).toBeUndefined();
  });
});

function fakeGit(delayMs: number, branch = "feature/async"): string {
  const workspace = mkdtempSync(join(tmpdir(), "codex-slow-git-"));
  temporaryDirectories.push(workspace);
  writeFileSync(join(workspace, "git"), `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(require("node:path").join(process.argv[3], "pid"), String(process.pid));
process.on("SIGTERM", () => {});
setTimeout(() => process.stdout.write(${JSON.stringify(branch)}), ${delayMs});
`, { mode: 0o700 });
  vi.stubEnv("PATH", `${workspace}${delimiter}${process.env.PATH ?? ""}`);
  return workspace;
}
