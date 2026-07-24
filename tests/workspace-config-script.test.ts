import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configEventQueuePath, readConfigEvents } from "../runtime/config-event-queue.mjs";
import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { addWorkspaceToConfig, inspectWorkspaceConfig, readWorkspaceConfig, removeWorkspaceFromConfig } from "../scripts/workspace-config.mjs";

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
    const configPath = join(root, "config.toml");
    const eventQueuePath = configEventQueuePath(root);
    writeWorkspaceFixture(
      configPath,
      [{ id: "main", name: "Main", cwd: main }],
      "main",
    );
    chmodSync(configPath, 0o644);

    const first = addWorkspaceToConfig({ configPath, cwd: added, eventQueuePath });
    const second = addWorkspaceToConfig({ configPath, cwd: added, eventQueuePath });
    const config = readWorkspaceConfig(readGatewayConfig(configPath));

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
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("rejects an existing file as the directory being registered", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-add-"));
    temporaryDirectories.push(root);
    const main = join(root, "Main");
    const file = join(root, "not-a-directory");
    mkdirSync(main);
    writeFileSync(file, "test");
    const configPath = join(root, "config.toml");
    writeWorkspaceFixture(
      configPath,
      [{ id: "main", name: "Main", cwd: main }],
      "main",
    );

    expect(() => addWorkspaceToConfig({ configPath, cwd: file })).toThrow("cwd 必须是目录");
  });

  it("requires explicit pruning and enforces the fixed default Workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-workspace-add-"));
    temporaryDirectories.push(root);
    const missing = join(root, "Moved Project");
    const fallback = join(root, ".codex-connect", "workspace");
    const current = join(root, "Current Project");
    mkdirSync(current);
    const configPath = join(root, "config.toml");
    writeWorkspaceFixture(
      configPath,
      [{ id: "moved-project", name: "Moved Project", cwd: missing }],
      "moved-project",
    );

    expect(() => addWorkspaceToConfig({ configPath, cwd: current })).toThrow(
      "codexc ws add --prune-missing",
    );

    const result = addWorkspaceToConfig({
      configPath,
      cwd: current,
      pruneMissing: true,
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
    });
    const config = readWorkspaceConfig(readGatewayConfig(configPath));

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

    writeWorkspaceFixture(
      configPath,
      [{ id: "current-project", name: "Current Project", cwd: current }],
      "current-project",
    );
    const normalized = addWorkspaceToConfig({
      configPath,
      cwd: current,
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
    });
    const normalizedConfig = readWorkspaceConfig(readGatewayConfig(configPath));

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
    const configPath = join(root, "config.toml");
    writeWorkspaceFixture(configPath, [
      { id: "codex-connect", name: ".codex-connect/workspace", cwd: fallback },
      { id: "deleted-project", name: "Deleted Project", cwd: missing },
    ], "codex-connect");

    const result = addWorkspaceToConfig({
      configPath,
      cwd: current,
      pruneMissing: true,
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
    });
    const config = readWorkspaceConfig(readGatewayConfig(configPath));

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
    const configPath = join(root, "config.toml");
    writeWorkspaceFixture(
      configPath,
      [{ id: "codex-connect", name: ".codex-connect/workspace", cwd: fallbackAlias }],
      "codex-connect",
    );

    const result = addWorkspaceToConfig({ configPath, cwd: current });
    const config = readWorkspaceConfig(readGatewayConfig(configPath));

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
    const configPath = join(root, "config.toml");
    writeWorkspaceFixture(configPath, [
      { id: "codex-connect", name: ".codex-connect/workspace", cwd: fallback },
      { id: "deleted-project", name: "Deleted Project", cwd: missing },
    ], "codex-connect");
    const fallbackDefaultWorkspace = {
      id: "codex-connect",
      name: ".codex-connect/workspace",
      cwd: fallback,
    };

    const inspected = inspectWorkspaceConfig(readGatewayConfig(configPath));
    expect(inspected.workspaces).toMatchObject([
      { id: "codex-connect", status: "available" },
      { id: "deleted-project", status: "missing" },
    ]);

    const result = removeWorkspaceFromConfig({
      configPath,
      selector: "2",
      fallbackDefaultWorkspace,
    });
    const config = readWorkspaceConfig(readGatewayConfig(configPath));

    expect(result).toMatchObject({
      removedWorkspace: { id: "deleted-project", cwd: missing },
      defaultWorkspace: { id: "codex-connect" },
      defaultChanged: false,
    });
    expect(config.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([
      "codex-connect",
    ]);
    expect(() => statSync(missing)).toThrow();
    expect(() => removeWorkspaceFromConfig({
      configPath,
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
    const configPath = join(root, "config.toml");
    writeWorkspaceFixture(
      configPath,
      [{ id: "project", name: "Project", cwd: project }],
      "project",
    );

    const result = removeWorkspaceFromConfig({
      configPath,
      selector: "Project",
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
    });
    const config = readWorkspaceConfig(readGatewayConfig(configPath));

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
    const configPath = join(root, "config.toml");
    const eventQueuePath = configEventQueuePath(root);
    writeWorkspaceFixture(configPath, [
      { id: "codex-connect", name: ".codex-connect/workspace", cwd: fallback },
      { id: "project", name: "Project", cwd: project },
    ], "codex-connect");
    mkdirSync(join(root, "data"));
    writeFileSync(eventQueuePath, "{broken");

    expect(() => removeWorkspaceFromConfig({
      configPath,
      selector: "project",
      fallbackDefaultWorkspace: {
        id: "codex-connect",
        name: ".codex-connect/workspace",
        cwd: fallback,
      },
      eventQueuePath,
    })).toThrow("不是有效 JSON");

    expect(readWorkspaceConfig(readGatewayConfig(configPath)).workspaces).toHaveLength(2);
  });
});

function writeWorkspaceFixture(
  configPath: string,
  workspaces: Array<{ id: string; name: string; cwd: string }>,
  defaultWorkspace: string,
): void {
  writeGatewayConfig(configPath, {
    version: 1,
    default_workspace: defaultWorkspace,
    workspaces,
  });
}
