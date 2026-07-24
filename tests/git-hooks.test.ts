import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { installGitHooks } from "../scripts/install-git-hooks.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Git hooks installation", () => {
  it("configures the tracked hooks directory idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-git-hooks-"));
    temporaryDirectories.push(root);
    execFileSync("git", ["init", "--quiet", root]);
    mkdirSync(join(root, ".githooks"));
    writeFileSync(
      join(root, ".githooks", "pre-commit"),
      "#!/bin/sh\n",
      { mode: 0o755 },
    );

    expect(installGitHooks(root)).toEqual({ changed: true, installed: true });
    expect(installGitHooks(root)).toEqual({ changed: false, installed: true });
    expect(execFileSync(
      "git",
      ["config", "--local", "--get", "core.hooksPath"],
      { cwd: root, encoding: "utf8" },
    ).trim()).toBe(".githooks");
  });

  it("does not modify directories that are not Git repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-git-hooks-"));
    temporaryDirectories.push(root);

    expect(installGitHooks(root)).toEqual({ changed: false, installed: false });
  });
});
