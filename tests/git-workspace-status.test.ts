import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { currentGitBranch } from "../src/bootstrap/app.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("currentGitBranch", () => {
  it("reads the active branch from the authorized Workspace", () => {
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

    expect(currentGitBranch(workspace)).toBe("feature/weixin-surface");
  });

  it("returns no branch for a non-Git Workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "codex-git-status-"));
    temporaryDirectories.push(workspace);

    expect(currentGitBranch(workspace)).toBeUndefined();
  });
});
