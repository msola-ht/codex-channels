import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { parse } from "dotenv";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  acknowledgeConfigEvents,
  configEventQueuePath,
  matchingWorkspaceConfigEvents,
  readConfigEvents,
} from "../runtime/config-event-queue.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { readWorkspaceConfig } from "../scripts/workspace-config.mjs";

const temporaryDirectories: string[] = [];
const cli = resolve("bin/codexc.mjs");
const execFileAsync = promisify(execFile);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("codexc CLI", () => {
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
      CODEX_CONNECT_ENV_FILE: "",
    };

    const initialized = execFileSync(process.execPath, [cli, "init"], {
      cwd: first,
      env: environment,
      encoding: "utf8",
    });
    const firstAdded = execFileSync(process.execPath, [cli, "ws", "add"], {
      cwd: first,
      env: environment,
      encoding: "utf8",
    });
    const added = execFileSync(process.execPath, [cli, "ws", "add"], {
      cwd: second,
      env: environment,
      encoding: "utf8",
    });
    const listed = execFileSync(process.execPath, [cli, "ws"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    const envPath = join(home, ".env");
    const eventQueuePath = configEventQueuePath(home);
    const parsed = parse(readFileSync(envPath, "utf8"));
    const config = readWorkspaceConfig(parsed);
    expect(initialized).toContain("Codex Connect 已初始化");
    expect(firstAdded).toContain("Workspace 已添加");
    expect(added).toContain("Workspace 已添加");
    expect(added).toContain("Gateway 会自动热加载");
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
    expect(parsed.CODEX_SOCKET_PATH).toBe(join(home, "runtime", "codex-app-server.sock"));
    expect(parsed.STATE_DATABASE_PATH).toBe(join(home, "data", "gateway.sqlite3"));
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "workspace")).mode & 0o777).toBe(0o700);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
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
      CODEX_CONNECT_ENV_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], {
      cwd: current,
      env: environment,
    });
    rmSync(join(home, "workspace"), { recursive: true });

    const rejected = spawnSync(process.execPath, [cli, "ws", "add"], {
      cwd: current,
      env: environment,
      encoding: "utf8",
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("codexc ws add --prune-missing");
    expect(rejected.stderr).not.toContain("ENOENT");

    const repaired = execFileSync(
      process.execPath,
      [cli, "ws", "add", "--prune-missing"],
      {
        cwd: current,
        env: environment,
        encoding: "utf8",
      },
    );
    const envPath = join(home, ".env");
    const config = readWorkspaceConfig(parse(readFileSync(envPath, "utf8")));

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
      CODEX_CONNECT_ENV_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: root, env: environment });
    execFileSync(process.execPath, [cli, "ws", "add"], { cwd: project, env: environment });
    rmSync(project, { recursive: true });

    const listed = execFileSync(process.execPath, [cli, "ws"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const removed = execFileSync(process.execPath, [cli, "ws", "remove", "temporary-project"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const relisted = execFileSync(process.execPath, [cli, "ws"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    const rejected = spawnSync(process.execPath, [cli, "ws", "remove", "1"], {
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
      CODEX_CONNECT_ENV_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: root, env: environment });
    execFileSync(process.execPath, [cli, "ws", "add"], { cwd: project, env: environment });
    const queuePath = configEventQueuePath(home);
    acknowledgeConfigEvents(
      queuePath,
      readConfigEvents(queuePath).map((event) => event.id),
    );
    const before = readFileSync(join(home, ".env"), "utf8");

    execFileSync(process.execPath, [cli, "ws", "remove", "project"], {
      cwd: root,
      env: environment,
    });
    execFileSync(process.execPath, [cli, "ws", "add"], {
      cwd: project,
      env: environment,
    });

    const after = readFileSync(join(home, ".env"), "utf8");
    const config = readWorkspaceConfig(parse(after));
    const events = readConfigEvents(queuePath);
    expect(after).toBe(before);
    expect(events).toHaveLength(1);
    expect(matchingWorkspaceConfigEvents(events, config.workspaces)).toMatchObject([
      { type: "workspace-added", workspace: { id: "project", cwd: realpathSync(project) } },
    ]);
  });

  it("runs remote in the invocation directory unless a workspace is explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const first = join(root, "First Project");
    const second = join(root, "Second Project");
    mkdirSync(first);
    mkdirSync(second);
    const fakeCodex = join(root, "fake-codex.mjs");
    writeFileSync(
      fakeCodex,
      "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(fakeCodex, 0o700);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_ENV_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: first, env: environment });
    execFileSync(process.execPath, [cli, "ws", "add"], { cwd: first, env: environment });
    const envPath = join(home, ".env");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace("CODEX_BINARY=codex", `CODEX_BINARY=${fakeCodex}`),
    );
    execFileSync(process.execPath, [cli, "ws", "add"], { cwd: second, env: environment });

    const currentCapture = join(root, "current.json");
    execFileSync(process.execPath, [cli, "remote", "resume"], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: currentCapture },
    });
    const explicitCapture = join(root, "explicit.json");
    execFileSync(process.execPath, [cli, "remote", "--workspace", "second-project", "resume"], {
      cwd: first,
      env: { ...environment, CODEX_TEST_CAPTURE: explicitCapture },
    });

    expect(JSON.parse(readFileSync(currentCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(first),
      "resume",
    ]);
    expect(JSON.parse(readFileSync(explicitCapture, "utf8"))).toEqual([
      "--remote",
      `unix://${join(home, "runtime", "codex-app-server.sock")}`,
      "-C",
      realpathSync(second),
      "resume",
    ]);
  });

  it("does not overwrite an existing user configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_ENV_FILE: "",
    };

    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const before = readFileSync(join(home, ".env"), "utf8");
    const output = execFileSync(process.execPath, [cli, "init"], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    expect(output).toContain("已经初始化");
    expect(output).not.toContain("初始 Workspace");
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(before);
  });

  it("rejects ignored extra arguments", () => {
    const result = spawnSync(process.execPath, [cli, "config", "unexpected"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("用法：codexc config");
  });

  it("documents the launchd uninstall command", () => {
    const output = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

    expect(output).toContain("service uninstall");
    expect(output).toContain("service reload");
    expect(output).toContain("service logs");
    expect(output).toContain("保留用户数据");
    expect(output).toContain("setup ");
  });

  it("rejects invalid service log options before reading user configuration", () => {
    const invalidLines = spawnSync(process.execPath, [cli, "service", "logs", "--lines", "0"], {
      encoding: "utf8",
    });
    const unknown = spawnSync(process.execPath, [cli, "service", "logs", "--unknown"], {
      encoding: "utf8",
    });
    const invalidService = spawnSync(
      process.execPath,
      [cli, "service", "logs", "--service", "unknown"],
      { encoding: "utf8" },
    );

    expect(invalidLines.status).toBe(1);
    expect(invalidLines.stderr).toContain("日志行数必须是 1 到 10000");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("未知日志参数");
    expect(invalidService.status).toBe(1);
    expect(invalidService.stderr).toContain("日志服务必须是");
  });

  it("shows an explicitly configured environment file", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const envPath = join(root, "profile", "gateway.env");
    mkdirSync(join(root, "profile"));

    const output = execFileSync(process.execPath, [cli, "config"], {
      env: { ...process.env, CODEX_CONNECT_ENV_FILE: envPath },
      encoding: "utf8",
    });

    expect(output).toContain(`用户目录：${join(root, "profile")}`);
    expect(output).toContain(`配置文件：${envPath}`);
  });

  it("initializes an explicitly configured environment file", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-cli-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "Workspace");
    const envPath = join(root, "profile", "gateway.env");
    mkdirSync(workspace);

    const output = execFileSync(process.execPath, [cli, "init"], {
      cwd: workspace,
      env: { ...process.env, CODEX_CONNECT_ENV_FILE: envPath },
      encoding: "utf8",
    });

    const parsed = parse(readFileSync(envPath, "utf8"));
    expect(output).toContain(`配置文件：${envPath}`);
    expect(parsed.CODEX_SOCKET_PATH).toBe(join(root, "profile", "runtime", "codex-app-server.sock"));
    expect(parsed.STATE_DATABASE_PATH).toBe(join(root, "profile", "data", "gateway.sqlite3"));
    expect(statSync(join(root, "profile")).mode & 0o777).toBe(0o700);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("diagnoses configuration and a real Unix WebSocket without exposing the Telegram token", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_ENV_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });

    const fakeCodex = join(root, "codex");
    writeFileSync(fakeCodex, "#!/bin/sh\nprintf 'codex-cli 0.145.0\\n'\n");
    chmodSync(fakeCodex, 0o700);
    const envPath = join(home, ".env");
    const socketPath = join(root, "app.sock");
    let initializedReceived = false;
    const secret = "123456:test-secret-token";
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8")
        .replace("TELEGRAM_BOT_TOKEN=", `TELEGRAM_BOT_TOKEN=${secret}`)
        .replace("TELEGRAM_ALLOWED_USER_IDS=", "TELEGRAM_ALLOWED_USER_IDS=123456")
        .replace("CODEX_BINARY=codex", `CODEX_BINARY=${fakeCodex}`)
        .replace(/^CODEX_SOCKET_PATH=.*$/m, `CODEX_SOCKET_PATH=${socketPath}`),
    );

    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    webSocketServer.on("connection", (client) => {
      client.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.method === "initialize") {
          client.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { platformFamily: "unix", platformOs: "macos" } }));
        }
        if (message.method === "initialized") {
          initializedReceived = true;
        }
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });

    try {
      const { stdout } = await execFileAsync(process.execPath, [cli, "doctor"], {
        cwd: workspace,
        env: environment,
        encoding: "utf8",
      });
      expect(stdout).toContain("[通过] Codex CLI：codex-cli 0.145.0");
      expect(stdout).toContain("[通过] Codex App Server：initialize 握手通过");
      expect(stdout).toContain("诊断通过");
      expect(stdout).not.toContain(secret);
      expect(initializedReceived).toBe(true);
    } finally {
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("explicitly repairs the deprecated sandbox configuration with doctor --fix", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-fix-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_ENV_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const envPath = join(home, ".env");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(
        "CODEX_SANDBOX=workspace-write",
        "CODEX_BRIDGE_SANDBOX=read-only",
      ),
    );

    const repaired = spawnSync(process.execPath, [cli, "doctor", "--fix"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });
    const parsed = parse(readFileSync(envPath, "utf8"));

    expect(repaired.stdout).toContain(
      "[修复] 用户配置：已将 CODEX_BRIDGE_SANDBOX 改为 CODEX_SANDBOX",
    );
    expect(repaired.stdout).toContain("[通过] 配置兼容性");
    expect(parsed.CODEX_SANDBOX).toBe("read-only");
    expect(parsed.CODEX_BRIDGE_SANDBOX).toBeUndefined();
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("reports deprecated configuration without silently repairing it", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-legacy-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_ENV_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const envPath = join(home, ".env");
    const legacyContent = readFileSync(envPath, "utf8").replace(
      "CODEX_SANDBOX=workspace-write",
      "CODEX_BRIDGE_SANDBOX=read-only",
    );
    writeFileSync(envPath, legacyContent);

    const diagnosed = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });

    expect(diagnosed.status).toBe(1);
    expect(diagnosed.stdout).toContain(
      "[失败] 配置兼容性：检测到 CODEX_BRIDGE_SANDBOX；请运行 codexc doctor --fix",
    );
    expect(readFileSync(envPath, "utf8")).toBe(legacyContent);
  });

  it("keeps the current sandbox value when doctor --fix removes a duplicate old key", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-doctor-fix-"));
    temporaryDirectories.push(root);
    const home = join(root, ".codex-connect");
    const workspace = join(root, "Workspace");
    mkdirSync(workspace);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_ENV_FILE: "",
    };
    execFileSync(process.execPath, [cli, "init"], { cwd: workspace, env: environment });
    const envPath = join(home, ".env");
    writeFileSync(
      envPath,
      `${readFileSync(envPath, "utf8")}CODEX_BRIDGE_SANDBOX=read-only\n`,
    );

    const repaired = spawnSync(process.execPath, [cli, "doctor", "--fix"], {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });
    const parsed = parse(readFileSync(envPath, "utf8"));

    expect(repaired.stdout).toContain(
      "[修复] 用户配置：已保留 CODEX_SANDBOX 并删除旧的 CODEX_BRIDGE_SANDBOX",
    );
    expect(parsed.CODEX_SANDBOX).toBe("workspace-write");
    expect(parsed.CODEX_BRIDGE_SANDBOX).toBeUndefined();
  });
});
