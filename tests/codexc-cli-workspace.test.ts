import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acknowledgeConfigEvents,
  configEventQueuePath,
  matchingWorkspaceConfigEvents,
  readConfigEvents,
} from "../runtime/config-event-queue.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { readWorkspaceConfig } from "../scripts/workspace-config.mjs";
import { cli, mkdtempSync } from "./codexc-cli-test-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

if (process.platform === "win32") {
  describe.skip("codexc CLI workspace (Unix-only fixtures)", () => {
    it.skip("requires a dedicated Windows Workspace contract", () => undefined);
  });
} else {
  describe("codexc CLI", { timeout: 15_000 }, () => {
  it("initializes an isolated user directory and registers another workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const first = join(root, "First Project");
    const second = join(root, "Second Project");
    mkdirSync(first);
    mkdirSync(second);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };

    const initialized = execFileSync(process.execPath, [cli, "init"], {
      cwd: first,
      env: environment,
      encoding: "utf8",
    });
    const firstAdded = execFileSync(process.execPath, [cli, "work", "add", "--cwd", first], {
      cwd: first,
      env: environment,
      encoding: "utf8",
    });
    const added = execFileSync(process.execPath, [cli, "work", "add", "--cwd", second], {
      cwd: second,
      env: environment,
      encoding: "utf8",
    });
    const listed = execFileSync(process.execPath, [cli, "work"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    const configPath = join(home, "config.toml");
    const eventQueuePath = configEventQueuePath(home);
    const parsed = readGatewayConfig(configPath);
    const config = readWorkspaceConfig(parsed);
    expect(initialized).toContain("Codex Connect 已初始化");
    expect(firstAdded).toContain("Workspace 已添加");
    expect(added).toContain("Workspace 已添加");
    expect(added).toContain("Gateway 会自动重新读取配置");
    expect(initialized).toContain(`默认 Workspace：${realpathSync(join(home, "workspace"))}`);
    expect(listed).toContain(".codex-connect/workspace · codex-connect ← 默认");
    expect(listed).toContain("First Project · first-project");
    expect(listed).toContain("Second Project · second-project");
    expect(config.workspaces.map((workspace: { cwd: string }) => workspace.cwd)).toEqual([
      realpathSync(join(home, "workspace")),
      realpathSync(first),
      realpathSync(second),
    ]);
    expect(readConfigEvents(eventQueuePath)).toMatchObject([
      { workspace: { id: "first-project", cwd: realpathSync(first) } },
      { workspace: { id: "second-project", cwd: realpathSync(second) } },
    ]);
    expect(parsed.codex).toMatchObject({ socket_path: "runtime/codex-app-server.sock" });
    expect(parsed.storage).toMatchObject({ database_path: "data/gateway.sqlite3" });
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "workspace")).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("registers the current directory with an explicit Workspace name", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-cli-ws-add-name-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const project = join(root, "Data Analysis");
    mkdirSync(project);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };

    execFileSync(process.execPath, [cli, "init"], {
      cwd: project,
      env: environment,
      encoding: "utf8",
    });
    const created = execFileSync(
      process.execPath,
      [cli, "work", "add", "--name", "Data Analysis"],
      {
        cwd: project,
        env: environment,
        encoding: "utf8",
      },
    );

    const configPath = join(home, "config.toml");
    const eventQueuePath = configEventQueuePath(home);
    const parsed = readGatewayConfig(configPath);
    const config = readWorkspaceConfig(parsed);
    const directory = realpathSync(project);
    expect(created).toContain("Workspace 已添加");
    expect(created).toContain("data-analysis");
    expect(config.workspaces.some((workspace: { id: string; name: string; cwd: string }) =>
      workspace.id === "data-analysis"
      && workspace.name === "Data Analysis"
      && workspace.cwd === directory)).toBe(true);
    expect(readConfigEvents(eventQueuePath)).toMatchObject([
      { workspace: { id: "data-analysis", cwd: directory } },
    ]);
  });

  it("recovers from a missing default Workspace only with explicit pruning", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const current = join(root, "Current Project");
    mkdirSync(current);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: current,
      env: environment,
    });
    rmSync(join(home, "workspace"), { recursive: true });

    const rejected = spawnSync(process.execPath, [cli, "work", "add", "--cwd", current], {
      cwd: current,
      env: environment,
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("codexc work add --prune-missing");
    expect(rejected.stderr).not.toContain("ENOENT");

    const repaired = execFileSync(
      process.execPath,
      [cli, "work", "add", "--cwd", current, "--prune-missing"],
      {
        cwd: current,
        env: environment,
        encoding: "utf8",
      },
    );
    const configPath = join(home, "config.toml");
    const config = readWorkspaceConfig(readGatewayConfig(configPath));

    expect(repaired).toContain("已清理失效 Workspace");
    expect(repaired).not.toContain("默认 Workspace 已切换为：Current Project");
    expect(config.workspaces.map((workspace: { cwd: string }) => workspace.cwd)).toEqual([
      realpathSync(join(home, "workspace")),
      realpathSync(current),
    ]);
    expect(config.defaultWorkspace).toMatchObject({
      id: "codex-connect",
      cwd: realpathSync(join(home, "workspace")),
    });

  });

  it("lists and removes a missing Workspace registration", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const project = join(root, "Temporary Project");
    mkdirSync(project);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: root, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", project], { cwd: project, env: environment });
    rmSync(project, { recursive: true });

    const listed = execFileSync(process.execPath, [cli, "work"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const removed = execFileSync(process.execPath, [cli, "work", "remove", "temporary-project"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const relisted = execFileSync(process.execPath, [cli, "work"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const rejected = spawnSync(process.execPath, [cli, "work", "remove", "1"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    expect(listed).toContain("Temporary Project · temporary-project · 目录不存在");
    expect(removed).toContain("Workspace 注册已删除：Temporary Project (temporary-project)");
    expect(removed).toContain("磁盘目录未删除");
    expect(relisted).not.toContain("temporary-project");
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("固定默认 Workspace 不能删除");
    expect(readConfigEvents(configEventQueuePath(home))).toEqual([]);
  });

  it("preserves a re-added Workspace notification when config changes coalesce", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const project = join(root, "Project");
    mkdirSync(project);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: root, env: environment });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", project], { cwd: project, env: environment });
    const queuePath = configEventQueuePath(home);
    acknowledgeConfigEvents(
      queuePath,
      readConfigEvents(queuePath).map((event) => event.id),
    );
    const before = readFileSync(join(home, "config.toml"), "utf8");

    execFileSync(process.execPath, [cli, "work", "remove", "project"], {
      cwd: root,
      env: environment,
    });
    execFileSync(process.execPath, [cli, "work", "add", "--cwd", project], {
      cwd: project,
      env: environment,
    });

    const after = readFileSync(join(home, "config.toml"), "utf8");
    const config = readWorkspaceConfig(readGatewayConfig(join(home, "config.toml")));
    const events = readConfigEvents(queuePath);
    expect(after).toBe(before);
    expect(events).toHaveLength(1);
    expect(matchingWorkspaceConfigEvents(events, config.workspaces)).toMatchObject([
      { type: "workspace-added", workspace: { id: "project", cwd: realpathSync(project) } },
    ]);
  });


});
}
