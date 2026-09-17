import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  macDesktopAppPluginEnabledConfigKey,
  parseMacDesktopAppToolsEnabled,
} from "../runtime/desktop-app-host.mjs";
import {
  runDesktopAppCommand,
} from "../scripts/desktop-app-command.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop-app command", () => {
  it("enables the macOS managed host and verifies supervisor readiness", async () => {
    const fixture = createFixture();
    let restarts = 0;
    let bridgeProbed = false;

    const result = await runDesktopAppCommand(["enable", "--port", "49200"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: readyDesktopHostSupervisor,
      restartAppServer: async () => { restarts += 1; },
      probeBridge: async () => {
        bridgeProbed = true;
        return true;
      },
      writeMessage: () => undefined,
    });

    expect(result).toEqual({ action: "enable", enabled: true, port: 49_200 });
    expect(restarts).toBe(1);
    expect(readGatewayConfig(fixture.configPath).codex).toMatchObject({
      desktop_app: { enabled: true, port: 49_200 },
    });
    expect(bridgeProbed).toBe(false);
  });

  it("restores the previous configuration when the macOS host capability is missing", async () => {
    const fixture = createFixture();
    let restarts = 0;

    await expect(runDesktopAppCommand(["enable"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: async () => ({ status: "missing" }),
      restartAppServer: async () => { restarts += 1; },
      writeMessage: () => undefined,
    })).rejects.toThrow("不支持当前 Desktop Host");

    expect(restarts).toBe(2);
    expect(readGatewayConfig(fixture.configPath).codex).not.toHaveProperty("desktop_app");
  });

  it("can disable sharing even when the Desktop app is no longer installed", async () => {
    const fixture = createFixture({ enabled: true, port: 49_201 });
    let restarts = 0;

    await expect(runDesktopAppCommand(["disable"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: () => ({
        installed: false,
        path: null,
        version: null,
        running: false,
        compatible: false,
        reason: "not installed",
      }),
      restartAppServer: async () => { restarts += 1; },
      writeMessage: () => undefined,
    })).resolves.toEqual({ action: "disable", enabled: false });

    expect(restarts).toBe(1);
    expect(readGatewayConfig(fixture.configPath).codex).not.toHaveProperty("desktop_app");
  });

  it("keeps status read-only and never prints the private endpoint token", async () => {
    const fixture = createFixture({ enabled: true, port: 49_202 });
    let output = "";

    const status = await runDesktopAppCommand(["status", "--json"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: readyDesktopHostSupervisor,
      output: { write: (value: string | Uint8Array) => {
        output += value.toString();
        return true;
      } },
      probeBridge: async () => {
        throw new Error("缺少令牌时不应探测桥");
      },
    });

    expect(status).toMatchObject({
      configured: true,
      port: null,
      endpoint: null,
      tokenReady: false,
      bridgeReady: false,
      toolHostSupported: true,
      toolHostAttached: false,
    });
    expect(JSON.parse(output)).toMatchObject({
      endpoint: null,
      tokenReady: false,
      toolHostSupported: true,
      toolHostAttached: false,
    });
    expect(output).not.toContain("?token=");
  });

  it("opens the compatible macOS app through the managed host without a bridge endpoint", async () => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    const opened: Array<{ path: string; endpoint: string }> = [];
    let bridgeProbed = false;

    await expect(runDesktopAppCommand(["open"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: readyDesktopHostSupervisor,
      probeBridge: async () => {
        bridgeProbed = true;
        return true;
      },
      openDesktop: (path, endpoint) => { opened.push({ path, endpoint }); },
      writeMessage: () => undefined,
    })).resolves.toEqual({ action: "open", opened: true });

    expect(opened).toEqual([{
      path: "/Applications/ChatGPT.app",
      endpoint: "",
    }]);
    expect(bridgeProbed).toBe(false);
  });

  it("parses the exact macOS Desktop tools plugin override", () => {
    expect(parseMacDesktopAppToolsEnabled([
      "-c",
      `${macDesktopAppPluginEnabledConfigKey}=true`,
    ])).toBe(true);
    expect(parseMacDesktopAppToolsEnabled([
      "-c",
      `${macDesktopAppPluginEnabledConfigKey}=false`,
    ])).toBe(false);
    expect(() => parseMacDesktopAppToolsEnabled([]))
      .toThrow("未提供内置工具插件配置");
    expect(() => parseMacDesktopAppToolsEnabled([
      "-c",
      `${macDesktopAppPluginEnabledConfigKey}=true`,
      "-c",
      `${macDesktopAppPluginEnabledConfigKey}=false`,
    ])).toThrow("无效的内置工具配置");
  });

  it("reports Windows as a per-launch preview when the current-user package is compatible", async () => {
    const fixture = createFixture();
    let output = "";

    const status = await runDesktopAppCommand(["status", "--json"], {
      environment: fixture.environment,
      platform: "win32",
      inspectDesktopApp: compatibleStoppedWindowsApp,
      output: { write: (value: string | Uint8Array) => {
        output += value.toString();
        return true;
      } },
    });
    expect(status).toMatchObject({
      supported: true,
      supportLevel: "preview",
      launchMode: "per-launch-environment",
    });
    expect(output).not.toContain("?token=");
  });

  it("enables and opens the Windows preview without persistent environment state", async () => {
    const fixture = createFixture();
    const opened: Array<{ path: string; endpoint: string }> = [];

    await expect(runDesktopAppCommand(["enable", "--port", "49204"], {
      environment: fixture.environment,
      platform: "win32",
      inspectDesktopApp: compatibleStoppedWindowsApp,
      restartAppServer: async () => undefined,
      probeBridge: async () => true,
      writeMessage: () => undefined,
    })).resolves.toEqual({ action: "enable", enabled: true, port: 49_204 });

    await expect(runDesktopAppCommand(["open"], {
      environment: fixture.environment,
      platform: "win32",
      inspectDesktopApp: compatibleStoppedWindowsApp,
      probeBridge: async () => true,
      openDesktop: async (path, endpoint) => { opened.push({ path, endpoint }); },
      writeMessage: () => undefined,
    })).resolves.toEqual({ action: "open", opened: true });

    expect(opened).toHaveLength(1);
    expect(opened[0]?.path).toBe("C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe");
    expect(opened[0]?.endpoint).toMatch(
      /^ws:\/\/127\.0\.0\.1:49204\/codex-app-server\?token=[A-Za-z0-9_-]{43}$/u,
    );
  });

  it("keeps unsupported platforms read-only", async () => {
    const fixture = createFixture({ enabled: true, port: 49_204 });
    const messages: string[] = [];
    const status = await runDesktopAppCommand(["status"], {
      environment: fixture.environment,
      platform: "linux",
      writeMessage: (_level, message) => { messages.push(message); },
    });
    expect(status).toMatchObject({
      supported: false,
      supportLevel: "unsupported",
      configured: true,
      port: null,
      endpoint: null,
      tokenReady: false,
      bridgeReady: false,
    });
    expect(messages).toContain("共享配置：unsupported（当前平台不支持）");
    expect(messages).not.toContain("共享配置：enabled（端口 null）");
    expect(messages).not.toContain("共享桥：not-ready");
    await expect(runDesktopAppCommand(["enable"], {
      environment: fixture.environment,
      platform: "linux",
    })).rejects.toThrow("当前只支持 macOS 与 Windows");
  });
});

function createFixture(desktopApp?: { enabled: boolean; port: number }) {
  const root = mkdtempSync(join(tmpdir(), "codexc-desktop-command-"));
  temporaryDirectories.push(root);
  const configPath = join(root, "config.toml");
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "workspace");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  writeFileSync(join(codexHome, "config.toml"), "model_provider = \"openai\"\n", {
    mode: 0o600,
  });
  writeGatewayConfig(configPath, {
    version: 1,
    default_workspace: "main",
    telegram: {
      bot_token: "desktop-command-test",
      allowed_user_ids: [123],
      message_format: "html",
    },
    codex: {
      binary: "codex",
      socket_path: join(root, "app-server.sock"),
      sandbox: "workspace-write",
      ...(desktopApp ? { desktop_app: desktopApp } : {}),
    },
    approval: { timeout_seconds: 300 },
    storage: { database_path: join(root, "gateway.sqlite3") },
    logging: { level: "info" },
    workspaces: [{ id: "main", name: "Main", cwd: workspace }],
  });
  return {
    root,
    configPath,
    environment: {
      ...process.env,
      CODEX_CONNECT_HOME: root,
      CODEX_CONNECT_CONFIG_FILE: configPath,
      CODEX_HOME: codexHome,
    },
  };
}

function compatibleStoppedApp() {
  return {
    installed: true,
    path: "/Applications/ChatGPT.app",
    version: "26.908.70816",
    running: false,
    compatible: true,
    reason: null,
  };
}

function compatibleStoppedWindowsApp() {
  return {
    installed: true,
    path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\ChatGPT.exe",
    version: "26.910.1000.0",
    running: false,
    compatible: true,
    reason: null,
  };
}

async function readyDesktopHostSupervisor() {
  return {
    status: "ready" as const,
    topology: {
      version: 5 as const,
      pid: process.pid,
      primaryProvider: "openai",
      managedProviders: [],
      socketPaths: ["/tmp/codex-app-server.sock"],
      runningProviders: ["openai"],
      releasedProviders: [],
      leasedProviders: [],
      desktopAppHostProtocolVersion: 1 as const,
      desktopAppAttached: false,
    },
  };
}
