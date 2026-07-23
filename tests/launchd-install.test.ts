import { execFileSync } from "node:child_process";
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
    const envPath = join(configDir, ".env");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      envPath,
      [
        `CODEX_BINARY=${process.execPath}`,
        `CODEX_WORKSPACES_JSON='${JSON.stringify([{ id: "test", name: "Test", cwd: root }])}'`,
        "CODEX_DEFAULT_WORKSPACE=test",
        `CODEX_SOCKET_PATH=${join(runtimeDir, "codex-app-server.sock")}`,
        "HTTP_PROXY=http://127.0.0.1:7897",
        "HTTPS_PROXY=http://127.0.0.1:7897",
        "NO_PROXY=localhost,127.0.0.1",
      ].join("\n"),
    );

    execFileSync(process.execPath, [resolve("scripts/install-launchd.mjs")], {
      env: {
        ...process.env,
        HOME: root,
        CODEX_CONNECT_HOME: configDir,
        CODEX_CONNECT_ENV_FILE: envPath,
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
    const legacyAppPlist = join(agentsDir, "com.msola.codex-app-server.plist");
    const legacyGatewayPlist = join(agentsDir, "com.msola.codex-gateway.plist");
    const userConfig = join(dataDir, ".env");
    writeFileSync(appPlist, "app");
    writeFileSync(gatewayPlist, "gateway");
    writeFileSync(legacyAppPlist, "legacy app");
    writeFileSync(legacyGatewayPlist, "legacy gateway");
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
    expect(existsSync(legacyAppPlist)).toBe(false);
    expect(existsSync(legacyGatewayPlist)).toBe(false);
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
    writeFileSync(join(launchctlState, "com.msola.codex-app-server"), "loaded");
    writeFileSync(join(launchctlState, "com.msola.codex-gateway"), "loaded");
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

    expect(started).toContain("已启动");
    expect(stopped).toContain("已停止");
    expect(restarted).toContain("Gateway 已重启");
    expect(restarted).toContain("App Server 保持运行");
    expect(startCalls).toContain("bootstrap");
    expect(startCalls).toContain("kickstart -k");
    expect(stopCalls).toContain("bootout");
    expect(stopCalls).toContain("com.msola.codex-gateway");
    expect(stopCalls).toContain("com.msola.codex-app-server");
    expect(restartCalls).not.toContain("bootout");
    expect(restartCalls).not.toContain("bootstrap");
    expect(restartCalls).toContain("kickstart -k");
    expect(restartCalls).toContain("com.hegenai.codex-gateway");
    expect(restartCalls).not.toContain("com.hegenai.codex-app-server");
    expect(reloaded).toContain("重新读取配置");
    expect(reloadCalls).toContain("kill SIGHUP");
    expect(reloadCalls).toContain("com.hegenai.codex-gateway");
    expect(reloadCalls).not.toContain("com.hegenai.codex-app-server");
  });

  it.skipIf(process.platform !== "darwin")("migrates legacy launchd jobs during install", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-connect-migrate-"));
    temporaryDirectories.push(root);
    const agentsDir = join(root, "Library/LaunchAgents");
    const binDir = join(root, "bin");
    const stateDir = join(root, "state");
    const launchctlLog = join(root, "launchctl.log");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(binDir);
    mkdirSync(stateDir);
    for (const label of [
      "com.hegenai.codex-app-server",
      "com.hegenai.codex-gateway",
      "com.msola.codex-app-server",
      "com.msola.codex-gateway",
    ]) {
      writeFileSync(join(agentsDir, `${label}.plist`), label);
    }
    for (const label of ["com.msola.codex-app-server", "com.msola.codex-gateway"]) {
      writeFileSync(join(stateDir, label), "loaded");
    }
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
      "esac",
    ].join("\n"));
    chmodSync(fakeLaunchctl, 0o755);

    const output = execFileSync("/bin/zsh", [resolve("scripts/launchd-control.sh"), "install"], {
      env: {
        ...process.env,
        HOME: root,
        PATH: `${binDir}:/usr/bin:/bin`,
        LAUNCHCTL_LOG: launchctlLog,
        LAUNCHCTL_STATE: stateDir,
      },
      encoding: "utf8",
    });
    const calls = readFileSync(launchctlLog, "utf8");

    expect(output).toContain("已安装并启动");
    expect(calls).toContain("bootout gui/");
    expect(calls).toContain("com.msola.codex-gateway");
    expect(calls).toContain("com.msola.codex-app-server");
    expect(calls).toContain("com.hegenai.codex-gateway.plist");
    expect(calls).toContain("com.hegenai.codex-app-server.plist");
    expect(existsSync(join(agentsDir, "com.msola.codex-gateway.plist"))).toBe(false);
    expect(existsSync(join(agentsDir, "com.msola.codex-app-server.plist"))).toBe(false);
    expect(existsSync(join(agentsDir, "com.hegenai.codex-gateway.plist"))).toBe(true);
    expect(existsSync(join(agentsDir, "com.hegenai.codex-app-server.plist"))).toBe(true);
  });
});
