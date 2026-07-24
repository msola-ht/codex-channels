import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeGatewayConfig } from "../runtime/gateway-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("launchd installer", () => {
  it.skipIf(process.platform !== "darwin")("renders absolute executables and a controlled PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-launchd-"));
    temporaryDirectories.push(root);
    const configDir = join(root, ".codex-connect");
    const runtimeDir = join(configDir, "runtime");
    const configPath = join(configDir, "config.toml");
    mkdirSync(runtimeDir, { recursive: true });
    writeGatewayConfig(configPath, gatewayDocument(root, {
      binary: process.execPath,
      socket_path: join(runtimeDir, "codex-app-server.sock"),
    }, {
      http_proxy: "http://127.0.0.1:7897",
      https_proxy: "http://127.0.0.1:7897",
      no_proxy: "localhost,127.0.0.1",
    }));

    execFileSync(process.execPath, [resolve("scripts/install-launchd.mjs")], {
      env: {
        ...process.env,
        HOME: root,
        CODEX_CONNECT_HOME: configDir,
        CODEX_CONNECT_CONFIG_FILE: configPath,
      },
    });

    const appServer = readFileSync(
      join(root, "Library/LaunchAgents/com.hegenai.codex-app-server.plist"),
      "utf8",
    );
    const gateway = readFileSync(
      join(root, "Library/LaunchAgents/com.hegenai.codex-gateway.plist"),
      "utf8",
    );
    const nodeBinary = realpathSync(process.execPath);

    expect(appServer).toContain(`<string>${nodeBinary}</string>`);
    expect(appServer).toContain(`<string>${dirname(nodeBinary)}:`);
    expect(gateway).toContain(`<key>CODEX_BINARY</key>\n    <string>${nodeBinary}</string>`);
    expect(gateway).toContain(`<key>PATH</key>`);
    expect(gateway).toContain("/opt/homebrew/bin");
    for (const plist of [appServer, gateway]) {
      expect(plist).toContain("<key>HTTP_PROXY</key>\n    <string>http://127.0.0.1:7897</string>");
      expect(plist).toContain("<key>HTTPS_PROXY</key>\n    <string>http://127.0.0.1:7897</string>");
      expect(plist).toContain("<key>NO_PROXY</key>\n    <string>localhost,127.0.0.1</string>");
    }
  });

  it.skipIf(process.platform !== "darwin")("uninstalls only launchd plists and preserves user data", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-uninstall-"));
    temporaryDirectories.push(root);
    const agentsDir = join(root, "Library/LaunchAgents");
    const binDir = join(root, "bin");
    const dataDir = join(root, ".codex-connect");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(binDir);
    mkdirSync(dataDir);
    const appPlist = join(agentsDir, "com.hegenai.codex-app-server.plist");
    const gatewayPlist = join(agentsDir, "com.hegenai.codex-gateway.plist");
    const userConfig = join(dataDir, "config.toml");
    writeFileSync(appPlist, "app");
    writeFileSync(gatewayPlist, "gateway");
    writeFileSync(userConfig, "preserved=true\n");
    const fakeLaunchctl = join(binDir, "launchctl");
    writeFileSync(fakeLaunchctl, "#!/bin/sh\n[ \"$1\" = print ] && exit 1\nexit 0\n");
    chmodSync(fakeLaunchctl, 0o755);

    const output = execFileSync("/bin/zsh", [resolve("scripts/launchd-control.sh"), "uninstall"], {
      env: { ...process.env, HOME: root, PATH: `${binDir}:/usr/bin:/bin` },
      encoding: "utf8",
    });

    expect(output).toContain("launchd 服务已卸载");
    expect(existsSync(appPlist)).toBe(false);
    expect(existsSync(gatewayPlist)).toBe(false);
    expect(readFileSync(userConfig, "utf8")).toBe("preserved=true\n");
  });

  it.skipIf(process.platform !== "darwin")("supports start, stop, and restart lifecycle actions", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-service-"));
    temporaryDirectories.push(root);
    const agentsDir = join(root, "Library/LaunchAgents");
    const binDir = join(root, "bin");
    const launchctlLog = join(root, "launchctl.log");
    const launchctlState = join(root, "launchctl-state");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(binDir);
    mkdirSync(launchctlState);
    const fakeLaunchctl = join(binDir, "launchctl");
    writeFileSync(fakeLaunchctl, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"",
      "command=$1",
      "shift",
      "case \"$command\" in",
      "  print)",
      "    label=${1##*/}",
      "    test -f \"$LAUNCHCTL_STATE/$label\"",
      "    ;;",
      "  bootstrap)",
      "    label=${2##*/}",
      "    label=${label%.plist}",
      "    touch \"$LAUNCHCTL_STATE/$label\"",
      "    ;;",
      "  bootout)",
      "    label=${1##*/}",
      "    rm -f \"$LAUNCHCTL_STATE/$label\"",
      "    ;;",
      "  kickstart)",
      "    label=${2##*/}",
      "    test -f \"$LAUNCHCTL_STATE/$label\"",
      "    ;;",
      "  kill)",
      "    test \"${LAUNCHCTL_KILL_FAIL:-0}\" != 1",
      "    ;;",
      "esac",
    ].join("\n"));
    chmodSync(fakeLaunchctl, 0o755);
    const environment = {
      ...process.env,
      HOME: root,
      PATH: `${binDir}:/usr/bin:/bin`,
      LAUNCHCTL_LOG: launchctlLog,
      LAUNCHCTL_STATE: launchctlState,
    };
    const script = resolve("scripts/launchd-control.sh");

    const started = execFileSync("/bin/zsh", [script, "start"], { env: environment, encoding: "utf8" });
    const startCalls = readFileSync(launchctlLog, "utf8");
    writeFileSync(launchctlLog, "");
    const stopped = execFileSync("/bin/zsh", [script, "stop"], { env: environment, encoding: "utf8" });
    const stopCalls = readFileSync(launchctlLog, "utf8");
    execFileSync("/bin/zsh", [script, "start"], { env: environment, encoding: "utf8" });
    writeFileSync(launchctlLog, "");
    const restarted = execFileSync("/bin/zsh", [script, "restart"], { env: environment, encoding: "utf8" });
    const restartCalls = readFileSync(launchctlLog, "utf8");
    writeFileSync(launchctlLog, "");
    const reloaded = execFileSync("/bin/zsh", [script, "reload"], { env: environment, encoding: "utf8" });
    const reloadCalls = readFileSync(launchctlLog, "utf8");
    writeFileSync(launchctlLog, "");
    const recovered = execFileSync("/bin/zsh", [script, "reload"], {
      env: { ...environment, LAUNCHCTL_KILL_FAIL: "1" },
      encoding: "utf8",
    });
    const recoveryCalls = readFileSync(launchctlLog, "utf8");
    const runtimeDir = join(root, ".codex-connect", "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "codex-app-server.log"), "app-old\napp-latest\n");
    writeFileSync(join(runtimeDir, "gateway.log"), "gateway-old\ngateway-latest\n");
    const logs = execFileSync("/bin/zsh", [script, "logs", "--lines", "1"], {
      env: environment,
      encoding: "utf8",
    });
    const allLogs = execFileSync(
      "/bin/zsh",
      [script, "logs", "--service", "all", "--lines", "1"],
      { env: environment, encoding: "utf8" },
    );

    expect(started).toContain("已启动");
    expect(stopped).toContain("已停止");
    expect(restarted).toContain("Gateway 已重启");
    expect(restarted).toContain("App Server 保持运行");
    expect(startCalls).toContain("bootstrap");
    expect(startCalls).toContain("kickstart -k");
    expect(stopCalls).toContain("bootout");
    expect(restartCalls).not.toContain("bootout");
    expect(restartCalls).not.toContain("bootstrap");
    expect(restartCalls).toContain("kickstart -k");
    expect(restartCalls).toContain("com.hegenai.codex-gateway");
    expect(restartCalls).not.toContain("com.hegenai.codex-app-server");
    expect(reloaded).toContain("重新读取配置");
    expect(reloadCalls).toContain("kill SIGHUP");
    expect(reloadCalls).toContain("com.hegenai.codex-gateway");
    expect(reloadCalls).not.toContain("com.hegenai.codex-app-server");
    expect(recovered).toContain("Gateway 已启动并将读取最新配置");
    expect(recoveryCalls).toContain("kill SIGHUP");
    expect(recoveryCalls).toContain("kickstart -k");
    expect(recoveryCalls).not.toContain("com.hegenai.codex-app-server");
    expect(logs).toContain("gateway-latest");
    expect(logs).not.toContain("gateway-old");
    expect(logs).not.toContain("codex-app-server.log");
    expect(allLogs).toContain("codex-app-server.log");
    expect(allLogs).toContain("app-latest");
    expect(allLogs).not.toContain("app-old");
  });

  it.skipIf(process.platform !== "darwin")("rejects unsupported launchd jobs without modifying them", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-unsupported-launchd-"));
    temporaryDirectories.push(root);
    const binDir = join(root, "bin");
    const stateDir = join(root, "state");
    const launchctlLog = join(root, "launchctl.log");
    mkdirSync(binDir);
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "com.msola.codex-gateway"), "loaded");
    const fakeLaunchctl = join(binDir, "launchctl");
    writeFileSync(fakeLaunchctl, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$LAUNCHCTL_LOG\"",
      "if [ \"$1\" = print ]; then",
      "  label=${2##*/}",
      "  test -f \"$LAUNCHCTL_STATE/$label\"",
      "  exit $?",
      "fi",
      "exit 0",
    ].join("\n"));
    chmodSync(fakeLaunchctl, 0o755);

    const result = spawnSync(
      "/bin/zsh",
      [resolve("scripts/launchd-control.sh"), "install"],
      {
        env: {
          ...process.env,
          HOME: root,
          PATH: `${binDir}:/usr/bin:/bin`,
          LAUNCHCTL_LOG: launchctlLog,
          LAUNCHCTL_STATE: stateDir,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("检测到不支持的 launchd Job：com.msola.codex-gateway");
    expect(readFileSync(launchctlLog, "utf8")).not.toContain("bootout");
    expect(existsSync(join(stateDir, "com.msola.codex-gateway"))).toBe(true);
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
