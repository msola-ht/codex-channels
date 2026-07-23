import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "dotenv";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { addWorkspaceToEnv, readWorkspaceConfig } from "../scripts/workspace-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workspace:add script", () => {
  it("registers the invocation directory once and preserves the default workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-add-"));
    temporaryDirectories.push(root);
    const main = join(root, "Main");
    const added = join(root, "New Project");
    mkdirSync(main);
    mkdirSync(added);
    const envPath = join(root, ".env");
    writeFileSync(
      envPath,
      [
        `CODEX_WORKSPACES_JSON='${JSON.stringify([{ id: "main", name: "Main", cwd: main }])}'`,
        "CODEX_DEFAULT_WORKSPACE=main",
        "TELEGRAM_BOT_TOKEN=secret",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );

    const first = addWorkspaceToEnv({ envPath, cwd: added });
    const second = addWorkspaceToEnv({ envPath, cwd: added });
    const config = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

    expect(first).toMatchObject({
      added: true,
      workspace: { id: "new-project", name: "New Project", cwd: realpathSync(added) },
    });
    expect(second).toMatchObject({ added: false, workspace: { id: "new-project" } });
    expect(config.defaultWorkspace.id).toBe("main");
    expect(config.workspaces).toHaveLength(2);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("rejects an existing file as the directory being registered", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-add-"));
    temporaryDirectories.push(root);
    const main = join(root, "Main");
    const file = join(root, "not-a-directory");
    mkdirSync(main);
    writeFileSync(file, "test");
    const envPath = join(root, ".env");
    writeFileSync(
      envPath,
      [
        `CODEX_WORKSPACES_JSON='${JSON.stringify([{ id: "main", name: "Main", cwd: main }])}'`,
        "CODEX_DEFAULT_WORKSPACE=main",
        "",
      ].join("\n"),
    );

    expect(() => addWorkspaceToEnv({ envPath, cwd: file })).toThrow("cwd 必须是目录");
  });

  it("requires explicit pruning and recovers when the default Workspace is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-add-"));
    temporaryDirectories.push(root);
    const missing = join(root, "Moved Project");
    const current = join(root, "Current Project");
    mkdirSync(current);
    const envPath = join(root, ".env");
    writeFileSync(
      envPath,
      [
        `CODEX_WORKSPACES_JSON='${JSON.stringify([{
          id: "moved-project",
          name: "Moved Project",
          cwd: missing,
        }])}'`,
        "CODEX_DEFAULT_WORKSPACE=moved-project",
        "",
      ].join("\n"),
    );

    expect(() => addWorkspaceToEnv({ envPath, cwd: current })).toThrow(
      "codexc ws add --prune-missing",
    );

    const result = addWorkspaceToEnv({
      envPath,
      cwd: current,
      pruneMissing: true,
    });
    const config = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

    expect(result).toMatchObject({
      added: true,
      defaultChanged: true,
      workspace: { id: "current-project" },
      defaultWorkspace: { id: "current-project" },
      removedWorkspaces: [{ id: "moved-project" }],
    });
    expect(config.workspaces).toEqual([
      {
        id: "current-project",
        name: "Current Project",
        cwd: realpathSync(current),
      },
    ]);
    expect(config.defaultWorkspace.id).toBe("current-project");
  });
});
