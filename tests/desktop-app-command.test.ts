import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadOrCreateDesktopAppBridgeToken,
} from "../runtime/desktop-app-bridge.mjs";
import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  inspectWindowsDesktopApp,
  openWindowsDesktopApp,
  runDesktopAppCommand,
} from "../scripts/desktop-app-command.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop-app command", () => {
  it("enables the macOS bridge, restarts the service and verifies readiness", async () => {
    const fixture = createFixture();
    const endpoints: string[] = [];
    let restarts = 0;

    const result = await runDesktopAppCommand(["enable", "--port", "49200"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      restartAppServer: async () => { restarts += 1; },
      probeBridge: async (endpoint) => {
        endpoints.push(endpoint);
        return true;
      },
      writeMessage: () => undefined,
    });

    expect(result).toEqual({ action: "enable", enabled: true, port: 49_200 });
    expect(restarts).toBe(1);
    expect(readGatewayConfig(fixture.configPath).codex).toMatchObject({
      desktop_app: { enabled: true, port: 49_200 },
    });
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatch(
      /^ws:\/\/127\.0\.0\.1:49200\/codex-app-server\?token=[A-Za-z0-9_-]{43}$/u,
    );
  });

  it("restores the previous configuration when readiness fails", async () => {
    const fixture = createFixture();
    let restarts = 0;

    await expect(runDesktopAppCommand(["enable"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      restartAppServer: async () => { restarts += 1; },
      probeBridge: async () => false,
      writeMessage: () => undefined,
    })).rejects.toThrow("服务重启后未就绪");

    expect(restarts).toBe(2);
    expect(readGatewayConfig(fixture.configPath).codex).not.toHaveProperty("desktop_app");
  });

  it("can disable the bridge even when the Desktop app is no longer installed", async () => {
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
      port: 49_202,
      tokenReady: false,
      bridgeReady: false,
    });
    expect(JSON.parse(output)).toMatchObject({
      endpoint: "ws://127.0.0.1:49202/codex-app-server",
      tokenReady: false,
    });
    expect(output).not.toContain("?token=");
  });

  it("opens the compatible macOS app with the private endpoint only after a ready probe", async () => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    const token = loadOrCreateDesktopAppBridgeToken(fixture.root);
    const opened: Array<{ path: string; endpoint: string }> = [];

    await expect(runDesktopAppCommand(["open"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      probeBridge: async () => true,
      openDesktop: (path, endpoint) => { opened.push({ path, endpoint }); },
      writeMessage: () => undefined,
    })).resolves.toEqual({ action: "open", opened: true });

    expect(opened).toEqual([{
      path: "/Applications/ChatGPT.app",
      endpoint: `ws://127.0.0.1:49203/codex-app-server?token=${token}`,
    }]);
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

  it("inspects only the verified executable and compatibility marker from a Windows package", () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-desktop-windows-"));
    temporaryDirectories.push(root);
    const executablePath = join(root, "app", "ChatGPT.exe");
    const resourcePath = join(root, "app", "resources", "app.asar");
    mkdirSync(join(root, "app", "resources"), { recursive: true });
    writeFileSync(executablePath, "desktop");
    writeFileSync(resourcePath, "prefix CODEX_APP_SERVER_WS_URL suffix");

    expect(inspectWindowsDesktopApp({
      inspectInstallation: () => ({
        installed: true,
        executablePath,
        resourcePath,
        version: "26.910.1000.0",
        running: false,
      }),
    })).toEqual({
      installed: true,
      path: executablePath,
      version: "26.910.1000.0",
      running: false,
      compatible: true,
      reason: null,
    });
  });

  it("launches Windows Desktop with a child-only endpoint and removes inherited aliases", async () => {
    const child = Object.assign(new EventEmitter(), {
      unrefCalls: 0,
      unref() { this.unrefCalls += 1; },
    });
    let launched: { file: string; args: readonly string[]; options: SpawnOptions } | undefined;
    const spawnProcess = ((file: string, args: readonly string[], options: SpawnOptions) => {
      launched = { file, args, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;

    await openWindowsDesktopApp("/package/app/ChatGPT.exe", "ws://127.0.0.1/private?token=secret", {
      environment: {
        Path: "C:\\Windows\\System32",
        codex_app_server_ws_url: "ws://127.0.0.1/stale",
        KEEP_ME: "yes",
      },
      spawnProcess,
      startupConfirmationMs: 0,
    });

    expect(launched).toMatchObject({
      file: "/package/app/ChatGPT.exe",
      args: [],
      options: {
        cwd: "/package/app",
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    });
    expect(launched?.options.env).toMatchObject({
      Path: "C:\\Windows\\System32",
      KEEP_ME: "yes",
      CODEX_APP_SERVER_WS_URL: "ws://127.0.0.1/private?token=secret",
    });
    expect(launched?.options.env).not.toHaveProperty("codex_app_server_ws_url");
    expect(child.unrefCalls).toBe(1);
  });

  it("keeps unsupported platforms read-only", async () => {
    const fixture = createFixture();
    const status = await runDesktopAppCommand(["status", "--json"], {
      environment: fixture.environment,
      platform: "linux",
      output: { write: () => true },
    });
    expect(status).toMatchObject({ supported: false, supportLevel: "unsupported" });
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
