import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "dotenv";
import { afterEach, describe, expect, it } from "vitest";

import { configEventQueuePath, readConfigEvents } from "../runtime/config-event-queue.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { addWorkspaceToEnv, inspectWorkspaceConfig, readWorkspaceConfig, removeWorkspaceFromEnv } from "../scripts/workspace-config.mjs";

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
    const eventQueuePath = configEventQueuePath(root);
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

    const first = addWorkspaceToEnv({ envPath, cwd: added, eventQueuePath });
    const second = addWorkspaceToEnv({ envPath, cwd: added, eventQueuePath });
    const config = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

    expect(first).toMatchObject({
      added: true,
      workspace: { id: "new-project", name: "New Project", cwd: realpathSync(added) },
    });
    expect(second).toMatchObject({ added: false, workspace: { id: "new-project" } });
    expect(config.defaultWorkspace.id).toBe("main");
    expect(config.workspaces).toHaveLength(2);
    expect(readConfigEvents(eventQueuePath)).toMatchObject([
      { type: "workspace-added", workspace: { id: "new-project", cwd: realpathSync(added) } },
    ]);
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

  it("requires explicit pruning and enforces the fixed default Workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-add-"));
    temporaryDirectories.push(root);
    const missing = join(root, "Moved Project");
    const fallback = join(root, ".codex-connect", "workspace");
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
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
    });
    const config = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

    expect(result).toMatchObject({
      added: true,
      defaultChanged: true,
      workspace: { id: "current-project" },
      defaultWorkspace: { id: "codex-connect" },
      removedWorkspaces: [{ id: "moved-project" }],
    });
    expect(config.workspaces).toEqual([
      {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: realpathSync(fallback),
      },
      {
        id: "current-project",
        name: "Current Project",
        cwd: realpathSync(current),
      },
    ]);
    expect(config.defaultWorkspace.id).toBe("codex-connect");

    const alternateDefault = [
      `CODEX_WORKSPACES_JSON='${JSON.stringify([{
        id: "current-project",
        name: "Current Project",
        cwd: current,
      }])}'`,
      "CODEX_DEFAULT_WORKSPACE=current-project",
      "",
    ].join("\n");
    writeFileSync(envPath, alternateDefault);
    const normalized = addWorkspaceToEnv({
      envPath,
      cwd: current,
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
    });
    const normalizedConfig = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

    expect(normalized).toMatchObject({
      added: false,
      defaultChanged: true,
      defaultWorkspace: { id: "codex-connect" },
      workspace: { id: "current-project" },
    });
    expect(normalizedConfig.defaultWorkspace.id).toBe("codex-connect");
    expect(normalizedConfig.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      "codex-connect",
      "current-project",
    ]);

  });

  it("prunes a deleted project without changing the fixed default Workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-add-"));
    temporaryDirectories.push(root);
    const fallback = join(root, ".codex-connect", "workspace");
    const missing = join(root, "Deleted Project");
    const current = join(root, "Current Project");
    mkdirSync(fallback, { recursive: true });
    mkdirSync(current);
    const envPath = join(root, ".env");
    writeFileSync(
      envPath,
      [
        `CODEX_WORKSPACES_JSON='${JSON.stringify([
          {
            id: "codex-connect",
            name: ".codex-connect/workspace",
            cwd: fallback,
          },
          {
            id: "deleted-project",
            name: "Deleted Project",
            cwd: missing,
          },
        ])}'`,
        "CODEX_DEFAULT_WORKSPACE=codex-connect",
        "",
      ].join("\n"),
    );

    const result = addWorkspaceToEnv({
      envPath,
      cwd: current,
      pruneMissing: true,
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
    });
    const config = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

    expect(result.defaultChanged).toBe(false);
    expect(result.removedWorkspaces).toMatchObject([{ id: "deleted-project" }]);
    expect(config.defaultWorkspace.id).toBe("codex-connect");
    expect(config.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      "codex-connect",
      "current-project",
    ]);
  });

  it("does not report a default change when its configured path resolves through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-add-"));
    temporaryDirectories.push(root);
    const fallback = join(root, "Default Workspace");
    const fallbackAlias = join(root, "Default Alias");
    const current = join(root, "Current Project");
    mkdirSync(fallback);
    symlinkSync(fallback, fallbackAlias, "dir");
    mkdirSync(current);
    const envPath = join(root, ".env");
    writeFileSync(
      envPath,
      [
        `CODEX_WORKSPACES_JSON='${JSON.stringify([{
          id: "codex-connect",
          name: ".codex-connect/workspace",
          cwd: fallbackAlias,
        }])}'`,
        "CODEX_DEFAULT_WORKSPACE=codex-connect",
        "",
      ].join("\n"),
    );

    const result = addWorkspaceToEnv({ envPath, cwd: current });
    const config = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

    expect(result.defaultChanged).toBe(false);
    expect(config.defaultWorkspace).toMatchObject({
      id: "codex-connect",
      cwd: realpathSync(fallback),
    });
  });

  it("lists missing directories and removes their registrations without touching disk", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-remove-"));
    temporaryDirectories.push(root);
    const fallback = join(root, ".codex-connect", "workspace");
    const missing = join(root, "Deleted Project");
    mkdirSync(fallback, { recursive: true });
    const envPath = join(root, ".env");
    writeFileSync(
      envPath,
      [
        `CODEX_WORKSPACES_JSON='${JSON.stringify([
          {
            id: "codex-connect",
            name: ".codex-connect/workspace",
            cwd: fallback,
          },
          {
            id: "deleted-project",
            name: "Deleted Project",
            cwd: missing,
          },
        ])}'`,
        "CODEX_DEFAULT_WORKSPACE=codex-connect",
        "",
      ].join("\n"),
    );
    const fallbackDefaultWorkspace = {
      id: "codex-connect",
      name: ".codex-connect/workspace",
      cwd: fallback,
    };

    const inspected = inspectWorkspaceConfig(parse(readFileSync(envPath, "utf8")));
    expect(inspected.workspaces).toMatchObject([
      { id: "codex-connect", status: "available" },
      { id: "deleted-project", status: "missing" },
    ]);

    const result = removeWorkspaceFromEnv({
      envPath,
      selector: "2",
      fallbackDefaultWorkspace,
    });
    const config = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

    expect(result).toMatchObject({
      removedWorkspace: { id: "deleted-project", cwd: missing },
      defaultWorkspace: { id: "codex-connect" },
      defaultChanged: false,
    });
    expect(config.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      "codex-connect",
    ]);
    expect(() => statSync(missing)).toThrow();
    expect(() => removeWorkspaceFromEnv({
      envPath,
      selector: "codex-connect",
      fallbackDefaultWorkspace,
    })).toThrow("固定默认 Workspace 不能删除");
  });

  it("restores the fixed default when removing a project incorrectly marked as default", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-remove-"));
    temporaryDirectories.push(root);
    const fallback = join(root, ".codex-connect", "workspace");
    const project = join(root, "Project");
    mkdirSync(project);
    const envPath = join(root, ".env");
    writeFileSync(
      envPath,
      [
        `CODEX_WORKSPACES_JSON='${JSON.stringify([{
          id: "project",
          name: "Project",
          cwd: project,
        }])}'`,
        "CODEX_DEFAULT_WORKSPACE=project",
        "",
      ].join("\n"),
    );

    const result = removeWorkspaceFromEnv({
      envPath,
      selector: "Project",
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
    });
    const config = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

    expect(result.defaultChanged).toBe(true);
    expect(config.defaultWorkspace).toMatchObject({
      id: "codex-connect",
      cwd: realpathSync(fallback),
    });
    expect(config.workspaces).toHaveLength(1);
  });

  it("does not mutate Workspace config when the event queue cannot be validated", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-remove-"));
    temporaryDirectories.push(root);
    const fallback = join(root, ".codex-connect", "workspace");
    const project = join(root, "Project");
    mkdirSync(fallback, { recursive: true });
    mkdirSync(project);
    const envPath = join(root, ".env");
    const eventQueuePath = configEventQueuePath(root);
    writeFileSync(
      envPath,
      [
        `CODEX_WORKSPACES_JSON='${JSON.stringify([
          { id: "codex-connect", name: ".codex-connect/workspace", cwd: fallback },
          { id: "project", name: "Project", cwd: project },
        ])}'`,
        "CODEX_DEFAULT_WORKSPACE=codex-connect",
        "",
      ].join("\n"),
    );
    mkdirSync(join(root, "data"));
    writeFileSync(eventQueuePath, "{broken");

    expect(() => removeWorkspaceFromEnv({
      envPath,
      selector: "project",
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
      eventQueuePath,
    })).toThrow("不是有效 JSON");

    expect(readWorkspaceConfig(parse(readFileSync(envPath, "utf8"))).workspaces).toHaveLength(2);
  });
});
