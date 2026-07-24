import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeProjectRulesAtRoot } from "../runtime/project-rules.mjs";

const temporaryDirectories: string[] = [];

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
    expect(existsSync(join(root, ".codex", "rules", "default.rules"))).toBe(false);
  });

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
