import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  macDesktopAppPluginEnabledConfigKey,
  parseMacDesktopAppToolsEnabled,
  readMacDesktopAppToolsEnabled,
} from "../runtime/desktop-app-host.mjs";
import {
  inspectMacDesktopApp,
  runDesktopAppCommand,
} from "../scripts/desktop-app-command.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop-app command", () => {
  it("rejects an explicit open subcommand before reading configuration", async () => {
    await expect(runDesktopAppCommand(["open"], { environment: {} })).rejects.toThrow("用法：codexc app");
  });
  it.each(["darwin", "win32"] as const)("confirms first open, enables sharing and launches on %s", async (platform) => {
    const fixture = createFixture();
    const events: string[] = [];
    const options = {
      environment: fixture.environment,
      platform,
      inspectDesktopApp: platform === "darwin" ? compatibleStoppedApp : compatibleStoppedWindowsApp,
      inspectSupervisorState: readyDesktopHostSupervisor,
      acquireProviderLease: async () => ({ close: async () => undefined }),
      inspectActiveThreads: async () => 0,
      confirmEnable: async () => { events.push("confirm"); return true; },
      restartAppServer: async () => { events.push("restart"); },
      probeBridge: async () => true,
      openDesktop: async () => { events.push("open"); },
      writeMessage: () => undefined,
    };
    await expect(runDesktopAppCommand([], options)).resolves.toEqual({ action: "open", opened: true });
    expect(events).toEqual(["confirm", "restart", "open"]);
    expect(readGatewayConfig(fixture.configPath).codex).toMatchObject({
      desktop_app: { enabled: true, port: 47_821 },
    });
    events.length = 0;
    await runDesktopAppCommand([], options);
    expect(events).toEqual(["open"]);
  });

  it("leaves configuration and services untouched when first open is declined", async () => {
    const fixture = createFixture();
    const before = readGatewayConfig(fixture.configPath);
    const events: string[] = [];
    await expect(runDesktopAppCommand([], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      confirmEnable: async () => false,
      restartAppServer: async () => { events.push("restart"); },
      openDesktop: async () => { events.push("open"); },
      writeMessage: () => undefined,
    })).resolves.toEqual({ action: "open", opened: false });
    expect(events).toEqual([]);
    expect(readGatewayConfig(fixture.configPath)).toEqual(before);
  });

  it.each(["darwin", "win32"] as const)("rolls back failed first-open enablement without launching on %s", async (platform) => {
    const fixture = createFixture({ enabled: false, port: 49_205 });
    const before = readGatewayConfig(fixture.configPath);
    const events: string[] = [];
    await expect(runDesktopAppCommand([], {
      environment: fixture.environment,
      platform,
      inspectDesktopApp: platform === "darwin" ? compatibleStoppedApp : compatibleStoppedWindowsApp,
      inspectSupervisorState: async () => ({ status: "missing" }),
      probeBridge: async () => false,
      confirmEnable: async () => true,
      restartAppServer: async () => { events.push("restart"); },
      openDesktop: async () => { events.push("open"); },
      writeMessage: () => undefined,
    })).rejects.toThrow(platform === "darwin" ? "不支持当前 Desktop Host" : "桥在服务重启后未就绪");
    expect(events).toEqual(["restart", "restart"]);
    expect(readGatewayConfig(fixture.configPath)).toEqual(before);
  });

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

    await expect(runDesktopAppCommand([], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: readyDesktopHostSupervisor,
      inspectActiveThreads: async () => 0,
      acquireProviderLease: async () => ({ close: async () => undefined }),
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

  it("refuses to open the macOS app while the primary App Server has an active Thread and releases its lease", async () => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    let opened = false;
    let closes = 0;

    await expect(runDesktopAppCommand([], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: readyDesktopHostSupervisor,
      inspectActiveThreads: async () => 2,
      acquireProviderLease: async () => ({ close: async () => { closes += 1; } }),
      openDesktop: () => { opened = true; },
      writeMessage: () => undefined,
    })).rejects.toThrow("当前有 2 个活动 Thread");

    expect(opened).toBe(false);
    expect(closes).toBe(1);
  });

  it("fails closed when the macOS active Thread check is unavailable", async () => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    let opened = false;
    let closes = 0;

    const result = runDesktopAppCommand([], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: readyDesktopHostSupervisor,
      inspectActiveThreads: async () => { throw new Error("private-token"); },
      acquireProviderLease: async () => ({ close: async () => { closes += 1; } }),
      openDesktop: () => { opened = true; },
      writeMessage: () => undefined,
    });
    await expect(result).rejects.toThrow("无法读取主 OpenAI App Server 活动 Thread 状态");
    await expect(result).rejects.not.toHaveProperty("cause");

    expect(opened).toBe(false);
    expect(closes).toBe(1);
  });

  it("restores and leases a released primary before checking activity, then releases before launch", async () => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    const events: string[] = [];
    let closed = false;
    await runDesktopAppCommand([], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: async () => ({
        ...await readyDesktopHostSupervisor(),
        topology: {
          ...(await readyDesktopHostSupervisor()).topology,
          runningProviders: [],
          releasedProviders: ["openai"],
        },
      }),
      acquireProviderLease: async (socketPath, provider) => {
        expect(socketPath).toBe(join(fixture.root, "app-server.sock"));
        expect(provider).toBe("openai");
        events.push("restore-and-lease");
        return { close: async () => { events.push("release"); closed = true; } };
      },
      inspectActiveThreads: async () => { events.push("activity"); expect(closed).toBe(false); return 0; },
      openDesktop: async () => { expect(closed).toBe(true); events.push("open"); },
      writeMessage: () => undefined,
    });
    expect(events).toEqual(["restore-and-lease", "activity", "release", "open"]);
  });

  it.each(["invalid-count", "launch-failure"])(
    "releases the preflight lease when %s cancels launch", async (failure) => {
      const fixture = createFixture({ enabled: true, port: 49_203 });
      let closed = false;
      let closes = 0;
      let opened = false;
      await expect(runDesktopAppCommand([], {
        environment: fixture.environment,
        platform: "darwin",
        inspectDesktopApp: compatibleStoppedApp,
        inspectSupervisorState: readyDesktopHostSupervisor,
        acquireProviderLease: async () => ({ close: async () => { closed = true; closes += 1; } }),
        inspectActiveThreads: async () => failure === "invalid-count" ? NaN : 0,
        openDesktop: async () => { expect(closed).toBe(true); opened = true; throw new Error("launch failed"); },
        writeMessage: () => undefined,
      })).rejects.toThrow();
      expect(closes).toBe(1);
      expect(opened).toBe(failure === "launch-failure");
    },
  );

  it("rejects unknown fields added before the configuration write without replacing their table", async () => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    let restarts = 0;
    await expect(runDesktopAppCommand(["enable"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: () => {
        const document = readGatewayConfig(fixture.configPath);
        Object.assign((document.codex as { desktop_app: object }).desktop_app, { unexpected: true });
        writeGatewayConfig(fixture.configPath, document);
        return compatibleStoppedApp();
      },
      restartAppServer: async () => { restarts += 1; },
      writeMessage: () => undefined,
    })).rejects.toThrow("unexpected");
    expect(restarts).toBe(0);
    expect(readGatewayConfig(fixture.configPath).codex).toMatchObject({
      desktop_app: { enabled: true, port: 49_203, unexpected: true },
    });
  });

  it.each(["acquire", "close"])("reports a safe %s failure and never launches", async (failure) => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    let activityInspected = false;
    let opened = false;
    const result = runDesktopAppCommand([], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: readyDesktopHostSupervisor,
      acquireProviderLease: async () => {
        if (failure === "acquire") throw new Error("private-token");
        return { close: async () => { throw new Error("private-token"); } };
      },
      inspectActiveThreads: async () => { activityInspected = true; return 0; },
      openDesktop: () => { opened = true; },
      writeMessage: () => undefined,
    });
    await expect(result).rejects.toThrow(failure === "acquire" ? "无法恢复并保护" : "无法释放启动检查");
    await expect(result).rejects.not.toHaveProperty("cause");
    expect(activityInspected).toBe(failure === "close");
    expect(opened).toBe(false);
  });

  it("reports initialization failure distinctly and releases its preflight lease", async () => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    let closes = 0;
    await expect(runDesktopAppCommand([], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: readyDesktopHostSupervisor,
      acquireProviderLease: async () => ({ close: async () => { closes += 1; } }),
      writeMessage: () => undefined,
    })).rejects.toThrow("无法完成主 OpenAI App Server 的连接初始化");
    expect(closes).toBe(1);
  });

  it.each(["version", "unknown-desktop", "unknown-codex"])(
    "rejects invalid %s configuration before inspection, mutation or launch", async (invalid) => {
      const fixture = createFixture({ enabled: true, port: 49_203 });
      const document = readGatewayConfig(fixture.configPath);
      if (invalid === "version") document.version = 2;
      else if (invalid === "unknown-codex") Object.assign(document.codex as object, { unexpected: true });
      else Object.assign((document.codex as { desktop_app: object }).desktop_app, { unexpected: true });
      writeGatewayConfig(fixture.configPath, document);
      const before = readFileSync(fixture.configPath, "utf8");
      for (const args of [[], ["enable"], ["disable"], ["status", "--json"]]) {
        await expect(runDesktopAppCommand(args, {
          environment: fixture.environment,
          platform: "darwin",
          inspectDesktopApp: () => { throw new Error("should not inspect Desktop"); },
        })).rejects.toThrow(invalid === "version" ? "version" : "unexpected");
      }
      expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
    },
  );

  it("uses the schema default port and preserves omitted defaults and comments through rollback", async () => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    const document = readGatewayConfig(fixture.configPath);
    delete (document.codex as { desktop_app: { port?: number } }).desktop_app.port;
    writeGatewayConfig(fixture.configPath, document);
    writeFileSync(fixture.configPath, `${readFileSync(fixture.configPath, "utf8")}\n# retain Desktop configuration comments\n`);
    const before = readFileSync(fixture.configPath, "utf8");
    const status = await runDesktopAppCommand(["status", "--json"], {
      environment: fixture.environment,
      platform: "win32",
      inspectDesktopApp: compatibleStoppedWindowsApp,
      inspectSupervisorState: async () => ({ status: "missing" }),
      output: { write: () => true },
    });
    expect(status).toMatchObject({ configured: true, port: 47_821 });
    expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
    let restarts = 0;
    await expect(runDesktopAppCommand(["enable", "--port", "49206"], {
      environment: fixture.environment,
      platform: "win32",
      inspectDesktopApp: compatibleStoppedWindowsApp,
      restartAppServer: async () => { restarts += 1; if (restarts === 1) throw new Error("restart failed"); },
      writeMessage: () => undefined,
    })).rejects.toThrow("restart failed");
    expect(restarts).toBe(2);
    expect(readGatewayConfig(fixture.configPath).codex).toMatchObject({ desktop_app: { enabled: true } });
    expect((readGatewayConfig(fixture.configPath).codex as { desktop_app: object }).desktop_app).not.toHaveProperty("port");
    expect(readFileSync(fixture.configPath, "utf8")).toContain("# retain Desktop configuration comments");
  });

  it("retains unknown running status when macOS Desktop resources cannot be read", async () => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    const appPath = join(fixture.root, "ChatGPT.app");
    mkdirSync(appPath);
    const app = inspectMacDesktopApp({ candidates: [appPath] });
    expect(app).toMatchObject({ installed: true, compatible: false, running: null });
    await expect(runDesktopAppCommand(["disable"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: () => app,
    })).rejects.toThrow("无法确认 ChatGPT Desktop App 是否已退出");
    expect(readGatewayConfig(fixture.configPath).codex).toHaveProperty("desktop_app");
  });

  it.each(["running", "released", "unknown"])("reports primary instance %s without restoring it", async (state) => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    const messages: string[] = [];
    const before = readFileSync(fixture.configPath, "utf8");
    const status = await runDesktopAppCommand(["status"], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: async () => {
        if (state === "unknown") throw new Error("private-token");
        const inspection = await readyDesktopHostSupervisor();
        return { ...inspection, topology: {
          ...inspection.topology,
          runningProviders: state === "running" ? ["openai"] : [],
          releasedProviders: state === "released" ? ["openai"] : [],
        } };
      },
      acquireProviderLease: async () => { throw new Error("must not restore"); },
      restartAppServer: async () => { throw new Error("must not restart"); },
      writeMessage: (_kind, message) => { messages.push(message); },
    });
    expect(status.primaryInstanceState).toBe(state);
    expect(messages.some((message) => message.startsWith("主 App Server 实例："))).toBe(true);
    expect(messages.join("\n")).not.toContain("private-token");
    expect(JSON.stringify(status)).not.toContain("private-token");
    expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
  });

  it.each([false, true])("refuses to open the macOS app while the primary lease is held and Host attached is %s", async (attached) => {
    const fixture = createFixture({ enabled: true, port: 49_203 });
    let activityInspected = false;
    let opened = false;

    await expect(runDesktopAppCommand([], {
      environment: fixture.environment,
      platform: "darwin",
      inspectDesktopApp: compatibleStoppedApp,
      inspectSupervisorState: async () => ({
        ...await readyDesktopHostSupervisor(),
        topology: {
          ...(await readyDesktopHostSupervisor()).topology,
          leasedProviders: ["openai"],
          desktopAppAttached: attached,
        },
      }),
      inspectActiveThreads: async () => {
        activityInspected = true;
        return 0;
      },
      openDesktop: () => { opened = true; },
      writeMessage: () => undefined,
    })).rejects.toThrow(attached ? "Host 租约尚未释放" : "正由 codexc remote 使用");

    expect(activityInspected).toBe(false);
    expect(opened).toBe(false);
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

  it("treats the plain App Server launch as an attachment-free Desktop connection", () => {
    expect(readMacDesktopAppToolsEnabled([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
    ])).toBeUndefined();
    expect(readMacDesktopAppToolsEnabled([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
      "-c",
      `${macDesktopAppPluginEnabledConfigKey}=true`,
    ])).toBe(true);
    expect(() => readMacDesktopAppToolsEnabled([
      "-c",
      `${macDesktopAppPluginEnabledConfigKey}=maybe`,
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

    await expect(runDesktopAppCommand([], {
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
