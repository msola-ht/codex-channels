import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { runWorkspaceCommand } from "../scripts/workspace-command.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Workspace CLI JSON", () => {
  it("lists workspaces as parseable JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-workspace-json-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace);
    writeFileSync(join(dataDir, "config.toml"), [
      'config_version = "1"',
      'default_workspace = "main"',
      "",
      "[[workspaces]]",
      'id = "main"',
      'name = "Main"',
      `cwd = "${workspace}"`,
      "",
    ].join("\n"));
    const output = { write: vi.fn() };
    await runWorkspaceCommand(["list", "--json"], {
      environment: { CODEX_CONNECT_HOME: dataDir },
      output,
      outputIsTTY: false,
    });
    expect(JSON.parse(output.write.mock.calls.map(([chunk]) => chunk).join(""))).toEqual({
      defaultWorkspaceId: "main",
      workspaces: [{
        id: "main",
        name: "Main",
        cwd: realpathSync(workspace),
        status: "available",
        default: true,
      }],
    });
  });
});
