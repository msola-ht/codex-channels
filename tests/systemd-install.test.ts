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
    const envPath = join(configDir, ".env");
    const configHome = join(root, ".config");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      envPath,
      [
        `CODEX_BINARY=${process.execPath}`,
        `CODEX_WORKSPACES_JSON='${JSON.stringify([{ id: "test", name: "Test", cwd: root }])}'`,
        "CODEX_DEFAULT_WORKSPACE=test",
        `CODEX_SOCKET_PATH=${join(runtimeDir, "codex-app-server.sock")}`,
        "HTTP_PROXY='http://127.0.0.1:7897/path%20value'",
        "NO_PROXY=localhost,127.0.0.1",
      ].join("\n"),
    );

    execFileSync(process.execPath, [resolve("scripts/install-systemd.mjs")], {
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: configHome,
        CODEX_CONNECT_HOME: configDir,
        CODEX_CONNECT_ENV_FILE: envPath,
      },
    });

    const unitsDir = join(configHome, "systemd/user");
    const appServerPath = join(unitsDir, "codex-connect-app-server.service");
    const gatewayPath = join(unitsDir, "codex-connect-gateway.service");
    const appServer = readFileSync(appServerPath, "utf8");
    const gateway = readFileSync(gatewayPath, "utf8");
    const nodeBinary = realpathSync(process.execPath);

    expect(appServer).toContain(
      `ExecStart="${nodeBinary}" app-server --listen "unix://${join(runtimeDir, "codex-app-server.sock")}"`,
    );
    expect(appServer).toContain(`WorkingDirectory=${root}`);
    expect(gateway).toContain(`WorkingDirectory=${configDir}`);
    expect(appServer).not.toContain(`WorkingDirectory="${root}"`);
    expect(gateway).not.toContain(`WorkingDirectory="${configDir}"`);
    expect(gateway).toContain(`ExecStart="${nodeBinary}"`);
    expect(gateway).toContain("codex-connect-app-server.service");
    for (const unit of [appServer, gateway]) {
      expect(unit).toContain("UMask=0077");
      expect(unit).toContain("Restart=always");
      expect(unit).toContain('Environment="HTTP_PROXY=http://127.0.0.1:7897/path%%20value"');
      expect(unit).not.toMatch(/__[A-Z_]+__/);
    }
    expect(statSync(appServerPath).mode & 0o777).toBe(0o600);
    expect(statSync(gatewayPath).mode & 0o777).toBe(0o600);

    const verified = spawnSync("systemd-analyze", ["verify", appServerPath, gatewayPath], { encoding: "utf8" });
    if (!verified.error) {
      expect(verified.status, verified.stderr || verified.stdout).toBe(0);
    }
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
    const userConfig = join(dataDir, ".env");
    writeFileSync(appUnit, "app");
    writeFileSync(gatewayUnit, "gateway");
    writeFileSync(userConfig, "preserved=true\n");
    const fakeSystemctl = join(binDir, "systemctl");
    writeFileSync(fakeSystemctl, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n");
    chmodSync(fakeSystemctl, 0o755);
    const environment = {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
      SYSTEMCTL_BINARY: fakeSystemctl,
      SYSTEMCTL_LOG: systemctlLog,
    };
    const script = resolve("scripts/systemd-control.sh");

    const installed = execFileSync("/bin/sh", [script, "install"], { env: environment, encoding: "utf8" });
    const installCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const started = execFileSync("/bin/sh", [script, "start"], { env: environment, encoding: "utf8" });
    const startCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const stopped = execFileSync("/bin/sh", [script, "stop"], { env: environment, encoding: "utf8" });
    const stopCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const restarted = execFileSync("/bin/sh", [script, "restart"], { env: environment, encoding: "utf8" });
    const restartCalls = readFileSync(systemctlLog, "utf8");
    writeFileSync(systemctlLog, "");
    const reloaded = execFileSync("/bin/sh", [script, "reload"], { env: environment, encoding: "utf8" });
    const reloadCalls = readFileSync(systemctlLog, "utf8");
    const uninstalled = execFileSync("/bin/sh", [script, "uninstall"], { env: environment, encoding: "utf8" });

    expect(installed).toContain("已安装并启动");
    expect(installCalls).toContain("--user daemon-reload");
    expect(installCalls).toContain("--user enable codex-connect-app-server.service codex-connect-gateway.service");
    expect(installCalls).toContain("--user restart codex-connect-app-server.service");
    expect(installCalls).toContain("--user restart codex-connect-gateway.service");
    expect(started).toContain("已启动");
    expect(startCalls).toContain("--user start codex-connect-app-server.service");
    expect(startCalls).toContain("--user start codex-connect-gateway.service");
    expect(stopped).toContain("已停止");
    expect(stopCalls).toContain("--user stop codex-connect-gateway.service");
    expect(stopCalls).toContain("--user stop codex-connect-app-server.service");
    expect(restarted).toContain("Gateway 已重启");
    expect(restartCalls).toContain("codex-connect-gateway.service");
    expect(restartCalls).not.toContain("codex-connect-app-server.service");
    expect(reloaded).toContain("重新读取配置");
    expect(reloadCalls).toContain("--user is-active --quiet codex-connect-gateway.service");
    expect(reloadCalls).toContain("--user kill --kill-whom=main --signal=HUP codex-connect-gateway.service");
    expect(reloadCalls).not.toContain("codex-connect-app-server.service");
    expect(uninstalled).toContain("用户配置与运行数据保留");
    expect(existsSync(appUnit)).toBe(false);
    expect(existsSync(gatewayUnit)).toBe(false);
    expect(readFileSync(userConfig, "utf8")).toBe("preserved=true\n");
  });
});
