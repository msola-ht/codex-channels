import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeProjectRulesAtRoot } from "../runtime/project-rules.mjs";
import { executableInvocation, resolveOptionalExecutable } from "../runtime/executable.mjs";

const temporaryDirectories: string[] = [];
const codexBinary = resolveOptionalExecutable(process.env.CODEX_BINARY?.trim() || "codex");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project rules runtime", () => {
  it("writes only inside the exact authorized Workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-workspace-rules-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(join(root, ".git"));
    mkdirSync(workspace);
    writeFileSync(join(root, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
    }));

    const result = initializeProjectRulesAtRoot({ projectRoot: workspace });

    expect(result.projectRoot).toBe(realpathSync(workspace));
    expect(result.rulesPath).toBe(
      join(realpathSync(workspace), ".codex", "rules", "default.rules"),
    );
    expect(existsSync(result.rulesPath)).toBe(true);
    const rules = readFileSync(result.rulesPath, "utf8");
    expect(rules).toContain("codexc channel send-image");
    expect(rules).toContain('pattern = ["codexc", "channel", "send-image"]');
    expect(existsSync(join(root, ".codex", "rules", "default.rules"))).toBe(false);
  });

  it.skipIf(!codexBinary && process.env.CI !== "true")(
    "uses the real policy engine to allow status without preauthorizing branch or remote writes",
    () => {
      expect(codexBinary, "CI must install the locked Codex CLI").toBeDefined();
      const root = mkdtempSync(join(tmpdir(), "codex-connect-policy-contract-"));
      temporaryDirectories.push(root);
      const { rulesPath } = initializeProjectRulesAtRoot({ projectRoot: root });
      const cases = [
        { args: ["git", "status", "-sb"], allowed: true },
        { args: ["git", "branch", "new-branch"], allowed: false },
        { args: ["git", "branch", "-D", "existing-branch"], allowed: false },
        { args: ["git", "remote", "add", "origin", "https://example.invalid/repo"], allowed: false },
        { args: ["git", "remote", "set-url", "origin", "https://example.invalid/repo"], allowed: false },
        { args: ["git", "remote", "remove", "origin"], allowed: false },
      ];
      for (const { args, allowed } of cases) {
        // execpolicy evaluates the supplied command; it never executes that command.
        const invocation = executableInvocation(codexBinary!, [
          "execpolicy", "check", "--rules", rulesPath, "--", ...args,
        ]);
        const result = spawnSync(invocation.file, invocation.args, {
          cwd: root,
          encoding: "utf8",
          timeout: 5_000,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
        expect(result.error, args.join(" ")).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const policy = JSON.parse(result.stdout) as { decision?: string };
        expect(policy.decision === "allow", args.join(" ")).toBe(allowed);
      }
    },
  );

  it("rejects a symlinked Codex directory instead of escaping the Workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-workspace-rules-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, ".codex"));

    expect(() => initializeProjectRulesAtRoot({ projectRoot: workspace }))
      .toThrow("项目规则路径不能使用符号链接");
    expect(existsSync(join(outside, "rules", "default.rules"))).toBe(false);
  });
});
