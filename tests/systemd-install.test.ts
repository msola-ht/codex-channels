import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeGatewayConfig } from "../runtime/gateway-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("systemd installer", () => {
  it.skipIf(process.platform !== "linux")("renders absolute executables and private user units", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-systemd-"));
    temporaryDirectories.push(root);
    const configDir = join(root, ".codex-connect");
    const runtimeDir = join(configDir, "runtime");
    const configPath = join(configDir, "config.toml");
    const configHome = join(root, ".config");
    mkdirSync(runtimeDir, { recursive: true });
    writeGatewayConfig(configPath, gatewayDocument(root, {
      binary: process.execPath,
      socket_path: join(runtimeDir, "codex-app-server.sock"),
    }, {
      http_proxy: "http://127.0.0.1:7897/path%20value",
      no_proxy: "localhost,127.0.0.1",
    }));

    execFileSync(process.execPath, [resolve("scripts/install-systemd.mjs")], {
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: configHome,
        CODEX_CONNECT_HOME: configDir,
        CODEX_CONNECT_CONFIG_FILE: configPath,
      },
    });

    const unitsDir = join(configHome, "systemd/user");
    const appServerPath = join(unitsDir, "codex-connect-app-server.service");
    const gatewayPath = join(unitsDir, "codex-connect-gateway.service");
    const appServer = readFileSync(appServerPath, "utf8");
    const gateway = readFileSync(gatewayPath, "utf8");
    const nodeBinary = realpathSync(process.execPath);

    expect(appServer).toContain(
      `ExecStart="${nodeBinary}" "${resolve("bin/codexc.mjs")}" service-app-server`,
    );
    expect(appServer).toContain(`WorkingDirectory=${root}`);
    expect(gateway).toContain(`WorkingDirectory=${configDir}`);
    expect(appServer).not.toContain(`WorkingDirectory="${root}"`);
    expect(gateway).not.toContain(`WorkingDirectory="${configDir}"`);
    expect(gateway).toContain(`ExecStart="${nodeBinary}"`);
    expect(gateway).toContain("codex-connect-app-server.service");
    expect(appServer).toContain('Environment="CODEX_CONNECT_SERVICE_ROLE=app-server"');
    expect(gateway).toContain('Environment="CODEX_CONNECT_SERVICE_ROLE=gateway"');
    expect(gateway).toContain('Environment="CODEX_CONNECT_GATEWAY_SUPERVISED=1"');
    for (const unit of [appServer, gateway]) {
      expect(unit).toContain("UMask=0077");
      expect(unit).toContain("Restart=always");
      expect(unit).not.toContain('Environment="HTTP_PROXY=');
      expect(unit).not.toMatch(/__[A-Z_]+__/);
    }
    expect(statSync(appServerPath).mode & 0o777).toBe(0o600);
    expect(statSync(gatewayPath).mode & 0o777).toBe(0o600);

    const verified = spawnSync("systemd-analyze", ["verify", appServerPath, gatewayPath], { encoding: "utf8" });
    if (!verified.error) {
      expect(verified.status, verified.stderr || verified.stdout).toBe(0);
    }
  });

  it("queries only the requested service identifier", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-systemd-query-"));
    temporaryDirectories.push(root);
    const binDir = join(root, "bin");
    const nodeLog = join(root, "node.log");
    mkdirSync(binDir);
    const nodeWrapper = join(binDir, "node");
    writeFileSync(
      nodeWrapper,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NODE_LOG\"\nexec \"$REAL_NODE\" \"$@\"\n",
    );
    chmodSync(nodeWrapper, 0o755);
    const fakeSystemctl = join(binDir, "systemctl");
    writeFileSync(fakeSystemctl, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeSystemctl, 0o755);

    execFileSync("/bin/sh", [resolve("scripts/systemd-control.sh"), "status", "gateway"], {
      env: {
        ...process.env,
        HOME: root,
        NODE_BINARY: nodeWrapper,
        NODE_LOG: nodeLog,
        REAL_NODE: process.execPath,
        SYSTEMCTL_BINARY: fakeSystemctl,
      },
    });

    const queries = readFileSync(nodeLog, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes("service-target-query.mjs"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("systemd gateway start");
  });

  it("fails closed when the service catalog query fails", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-systemd-query-failure-"));
    temporaryDirectories.push(root);
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const nodeWrapper = join(binDir, "node");
    writeFileSync(nodeWrapper, [
      "#!/bin/sh",
      "case \"$1\" in",
      "  *service-target-query.mjs) exit 42 ;;",
      "esac",
      "exec \"$REAL_NODE\" \"$@\"",
    ].join("\n"));
    chmodSync(nodeWrapper, 0o755);
    const fakeSystemctl = join(binDir, "systemctl");
    writeFileSync(fakeSystemctl, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeSystemctl, 0o755);

    const result = spawnSync(
      "/bin/sh",
      [resolve("scripts/systemd-control.sh"), "start", "gateway"],
      {
        env: {
          ...process.env,
          HOME: root,
          NODE_BINARY: nodeWrapper,
          REAL_NODE: process.execPath,
          SYSTEMCTL_BINARY: fakeSystemctl,
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(42);
    expect(result.stdout).not.toContain("[成功]");
  });

  it("supports lifecycle actions and preserves user data on uninstall", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-systemd-control-"));
    temporaryDirectories.push(root);
    const configHome = join(root, ".config");
    const unitsDir = join(configHome, "systemd/user");
    const dataDir = join(root, ".codex-connect");
    const binDir = join(root, "bin");
    const systemctlLog = join(root, "systemctl.log");
    mkdirSync(unitsDir, { recursive: true });
    mkdirSync(dataDir);
    mkdirSync(binDir);
    const appUnit = join(unitsDir, "codex-connect-app-server.service");
    const gatewayUnit = join(unitsDir, "codex-connect-gateway.service");
    const userConfig = join(dataDir, "config.toml");
    writeFileSync(appUnit, "app");
    writeFileSync(gatewayUnit, "gateway");
    writeFileSync(userConfig, "preserved=true\n");
    const fakeSystemctl = join(binDir, "systemctl");
    writeFileSync(fakeSystemctl, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n");
    chmodSync(fakeSystemctl, 0o755);
    const journalctlLog = join(root, "journalctl.log");
    const fakeJournalctl = join(binDir, "journalctl");
    writeFileSync(
      fakeJournalctl,
      "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$JOURNALCTL_LOG\"\nprintf 'gateway journal line\\n'\n",
    );
    chmodSync(fakeJournalctl, 0o755);
    const environment = {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
      SYSTEMCTL_BINARY: fakeSystemctl,
      SYSTEMCTL_LOG: systemctlLog,
      JOURNALCTL_BINARY: fakeJournalctl,
      JOURNALCTL_LOG: journalctlLog,
    };
    const script = resolve("scripts/systemd-control.sh");

    const installed = execFileSync("/bin/sh", [script, "install"], { env: environment, encoding: "utf8" });
    const installCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const started = execFileSync("/bin/sh", [script, "start"], { env: environment, encoding: "utf8" });
    const startCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const gatewayStarted = execFileSync(
      "/bin/sh",
      [script, "start", "gateway"],
      { env: environment, encoding: "utf8" },
    );
    const gatewayStartCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const stopped = execFileSync("/bin/sh", [script, "stop"], { env: environment, encoding: "utf8" });
    const stopCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const appServerStopped = execFileSync(
      "/bin/sh",
      [script, "stop", "app-server"],
      { env: environment, encoding: "utf8" },
    );
    const appServerStopCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const restarted = execFileSync("/bin/sh", [script, "restart"], { env: environment, encoding: "utf8" });
    const restartCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const appServerRestarted = execFileSync(
      "/bin/sh",
      [script, "restart", "app-server"],
      { env: environment, encoding: "utf8" },
    );
    const appServerRestartCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const allRestarted = execFileSync(
      "/bin/sh",
      [script, "restart", "all"],
      { env: environment, encoding: "utf8" },
    );
    const allRestartCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const reloaded = execFileSync("/bin/sh", [script, "reload"], { env: environment, encoding: "utf8" });
    const reloadCalls = readFileSync(systemctlLog, "utf8");
    const logs = execFileSync("/bin/sh", [script, "logs", "--follow", "--lines", "25"], {
      env: environment,
      encoding: "utf8",
    });
    const journalctlCalls = readFileSync(journalctlLog, "utf8");
    execFileSync("/bin/sh", [script, "logs", "all", "--lines", "10"], {
      env: environment,
      encoding: "utf8",
    });
    const allJournalctlCalls = readFileSync(journalctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    execFileSync("/bin/sh", [script, "status", "gateway"], {
      env: environment,
      encoding: "utf8",
    });
    const gatewayStatusCalls = readFileSync(systemctlLog, "utf8");
    const uninstalled = execFileSync("/bin/sh", [script, "uninstall"], { env: environment, encoding: "utf8" });

    expect(installed).toContain("已安装并启动");
    expect(installCalls).toContain("--user daemon-reload");
    expect(installCalls).toContain("--user enable codex-connect-app-server.service codex-connect-gateway.service");
    expect(installCalls).toContain("--user restart codex-connect-app-server.service");
    expect(installCalls).toContain("--user restart codex-connect-gateway.service");
    expect(started).toContain("已启动");
    expect(started).toContain("[成功]");
    expect(startCalls).toContain("--user start codex-connect-app-server.service");
    expect(startCalls).toContain("--user start codex-connect-gateway.service");
    expect(gatewayStarted).toContain("Gateway 已启动");
    expect(gatewayStarted).toContain("[成功]");
    expect(gatewayStartCalls).toContain("codex-connect-gateway.service");
    expect(gatewayStartCalls).not.toContain("codex-connect-app-server.service");
    expect(stopped).toContain("已停止");
    expect(stopCalls).toContain("--user stop codex-connect-gateway.service");
    expect(stopCalls).toContain("--user stop codex-connect-app-server.service");
    expect(appServerStopped).toContain("Codex App Server 已停止");
    expect(appServerStopCalls).toContain("codex-connect-app-server.service");
    expect(appServerStopCalls).not.toContain("codex-connect-gateway.service");
    expect(restarted).toContain("Gateway 已重启");
    expect(restartCalls).toContain("codex-connect-gateway.service");
    expect(restartCalls).not.toContain("codex-connect-app-server.service");
    expect(appServerRestarted).toContain("Codex App Server 已重启");
    expect(appServerRestartCalls).toContain("codex-connect-app-server.service");
    expect(appServerRestartCalls).not.toContain("codex-connect-gateway.service");
    expect(allRestarted).toContain("Codex App Server 与 Gateway 已重启");
    expect(allRestartCalls).toContain("codex-connect-app-server.service");
    expect(allRestartCalls).toContain("codex-connect-gateway.service");
    expect(reloaded).toContain("重新读取配置");
    expect(reloadCalls).toContain("--user is-active --quiet codex-connect-gateway.service");
    expect(reloadCalls).toContain("--user kill --kill-whom=main --signal=HUP codex-connect-gateway.service");
    expect(reloadCalls).not.toContain("codex-connect-app-server.service");
    expect(logs).toContain("gateway journal line");
    expect(journalctlCalls.trim()).toBe(
      "--user-unit=codex-connect-gateway.service --lines=25 --no-pager --follow",
    );
    expect(allJournalctlCalls.trim()).toBe(
      "--user-unit=codex-connect-gateway.service "
      + "--user-unit=codex-connect-app-server.service --lines=10 --no-pager",
    );
    expect(gatewayStatusCalls).toContain("codex-connect-gateway.service");
    expect(gatewayStatusCalls).not.toContain("codex-connect-app-server.service");
    expect(uninstalled).toContain("用户配置与运行数据保留");
    expect(existsSync(appUnit)).toBe(false);
    expect(existsSync(gatewayUnit)).toBe(false);
    expect(readFileSync(userConfig, "utf8")).toBe("preserved=true\n");
  });
});

function gatewayDocument(cwd: string, codex: Record<string, string>, network: Record<string, string>) {
  return {
    version: 1,
    default_workspace: "test",
    telegram: { bot_token: "test", allowed_user_ids: [1], message_format: "html" },
    network,
    codex: { sandbox: "workspace-write", ...codex },
    approval: { timeout_seconds: 300 },
    storage: { database_path: "data/gateway.sqlite3" },
    logging: { level: "info" },
    workspaces: [{ id: "test", name: "Test", cwd }],
  };
}
