import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { GatewayOwner } from "../runtime/gateway-owner.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
import { applyDatabaseUpdates, inspectCoreServiceInstallation, inspectGatewayConfiguration, inspectDatabaseUpdates, waitForCoreServiceTarget } from "../scripts/local-installation.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local installation inspection", () => {
  it("inspects a fresh installation without creating databases or changing config", () => {
    const { environment, configPath, dataDir } = fixture();
    const before = readFileSync(configPath, "utf8");
    expect(inspectGatewayConfiguration(environment)).toEqual({ configPath });
    expect(inspectDatabaseUpdates(environment)).toMatchObject({
      required: false, state: { exists: false }, metrics: { exists: false }, sessionDisplayCache: { exists: false },
    });
    applyDatabaseUpdates(environment);
    expect(existsSync(join(dataDir, "data", "gateway.sqlite3"))).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("rejects old state schemas without migrating data", () => {
    const { environment, dataDir } = fixture();
    mkdirSync(join(dataDir, "data"), { recursive: true });
    const path = join(dataDir, "data", "gateway.sqlite3");
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 4");
    database.close();
    expect(() => inspectDatabaseUpdates(environment)).toThrow("状态数据库 Schema 4 不兼容");
    expect(() => applyDatabaseUpdates(environment)).toThrow("状态数据库 Schema 4 不兼容");
    const unchanged = new DatabaseSync(path, { readOnly: true });
    expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    unchanged.close();
  });

  it("distinguishes an uninstalled service set from a partial installation", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-local-update-services-"));
    temporaryDirectories.push(home);
    const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: "" };

    expect(inspectCoreServiceInstallation(environment, "linux")).toEqual({
      installed: false,
    });

    const unitsDirectory = join(home, ".config", "systemd", "user");
    mkdirSync(unitsDirectory, { recursive: true });
    writeFileSync(join(unitsDirectory, "codex-connect-center.service"), "unit");
    expect(inspectCoreServiceInstallation(environment, "linux")).toEqual({
      installed: false,
    });
    rmSync(join(unitsDirectory, "codex-connect-center.service"));
    writeFileSync(join(unitsDirectory, "codex-connect-app-server.service"), "unit");
    expect(() => inspectCoreServiceInstallation(environment, "linux")).toThrow(
      "核心后台服务安装不完整",
    );
  });

  it("recognizes installed macOS launchd plist definitions", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-local-update-launchd-"));
    temporaryDirectories.push(home);
    const agentsDirectory = join(home, "Library", "LaunchAgents");
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(join(agentsDirectory, "com.hegenai.codex-app-server.plist"), "plist");
    writeFileSync(join(agentsDirectory, "com.hegenai.codex-gateway.plist"), "plist");

    expect(inspectCoreServiceInstallation({ ...process.env, HOME: home }, "darwin"))
      .toEqual({ installed: true });
  });

  it("recognizes installed Windows Scheduled Task definitions", () => {
    const { dataDir, environment } = fixture();
    const definitionsDirectory = join(dataDir, "services");
    mkdirSync(definitionsDirectory, { recursive: true });
    writeFileSync(join(definitionsDirectory, "app-server.json"), "{}");
    writeFileSync(join(definitionsDirectory, "gateway.json"), "{}");
    writeFileSync(join(definitionsDirectory, "app-server.vbs"), "");
    writeFileSync(join(definitionsDirectory, "gateway.vbs"), "");

    expect(inspectCoreServiceInstallation({
      ...environment,
      USERPROFILE: dataDir,
    }, "win32")).toEqual({ installed: true });
  });

  it("requires matching App Server topology and stable Gateway health", async () => {
    const { configPath, dataDir, environment } = fixture();
    const descriptor = resolveAppServerRuntime(
      readGatewayConfig(configPath),
      dataDir,
      environment,
    );
    let nowMs = 0;
    let gatewayChecks = 0;
    await waitForCoreServiceTarget("all", environment, {
      gatewayHealthy: () => ++gatewayChecks >= 2,
      inspectSupervisor: () => ({
        pid: process.pid,
        primaryProvider: descriptor.topology.primaryProvider,
        managedProviders: descriptor.topology.managedProviders,
        socketPaths: descriptor.topology.socketPaths,
        version: 5,
        runningProviders: [],
        releasedProviders: [],
        leasedProviders: [],
      }),
      intervalMs: 100,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
      },
      socketHealthy: () => true,
      stableMs: 200,
      timeoutMs: 1_000,
    });
    expect(gatewayChecks).toBeGreaterThanOrEqual(4);

    nowMs = 0;
    gatewayChecks = 0;
    await waitForCoreServiceTarget("all", environment, {
      gatewayHealthy: () => ++gatewayChecks >= 2,
      inspectSupervisorState: async () => ({
        status: "ready" as const,
        topology: {
          pid: process.pid,
          primaryProvider: descriptor.topology.primaryProvider,
          managedProviders: descriptor.topology.managedProviders,
          socketPaths: descriptor.topology.socketPaths,
          version: 5,
          runningProviders: [],
          releasedProviders: [descriptor.topology.primaryProvider],
          leasedProviders: [],
        },
      }),
      intervalMs: 100,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
      },
      socketHealthy: () => false,
      stableMs: 200,
      timeoutMs: 1_000,
    });
    expect(gatewayChecks).toBeGreaterThanOrEqual(4);
  });

  it("fails fast when the supervisor protocol version does not match", async () => {
    const { environment } = fixture();
    await expect(waitForCoreServiceTarget("app-server", environment, {
      gatewayHealthy: async () => true,
      inspectSupervisorState: async () => ({ status: "incompatible" as const }),
      intervalMs: 100,
      now: () => 0,
      sleep: async () => undefined,
      socketHealthy: async () => true,
      stableMs: 0,
      timeoutMs: 1_000,
    })).rejects.toThrow("codexc service restart all");
  });

  it("checks only the requested core service target", async () => {
    const { environment } = fixture();
    let nowMs = 0;
    const inspectSupervisor = vi.fn();
    const socketHealthy = vi.fn();
    const gatewayHealthy = vi.fn(async () => true);

    await waitForCoreServiceTarget("gateway", environment, {
      gatewayHealthy,
      inspectSupervisor,
      intervalMs: 100,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
      },
      socketHealthy,
      stableMs: 200,
      timeoutMs: 1_000,
    });

    expect(gatewayHealthy).toHaveBeenCalled();
    expect(inspectSupervisor).not.toHaveBeenCalled();
    expect(socketHealthy).not.toHaveBeenCalled();
  });

  it("requires application readiness rather than Gateway ownership alone", async () => {
    const { configPath, environment } = fixture();
    const owner = new GatewayOwner(configPath);
    await owner.start();
    let nowMs = 0;
    const timing = {
      intervalMs: 100,
      now: () => nowMs,
      sleep: async (milliseconds: number) => {
        nowMs += milliseconds;
      },
      stableMs: 100,
      timeoutMs: 300,
    };
    try {
      await expect(
        waitForCoreServiceTarget("gateway", environment, timing),
      ).rejects.toThrow("Gateway 未能及时就绪");

      owner.markReady();
      nowMs = 0;
      await expect(
        waitForCoreServiceTarget("gateway", environment, timing),
      ).resolves.toBeUndefined();
    } finally {
      await owner.close();
    }
  });

  it("returns target-specific status and log remediation when readiness times out", async () => {
    const { environment } = fixture();
    let nowMs = 0;

    await expect(waitForCoreServiceTarget("gateway", environment, {
      gatewayHealthy: async () => false,
      intervalMs: 100,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
      },
      stableMs: 200,
      timeoutMs: 300,
    })).rejects.toThrow(
      /Gateway 未能及时就绪.*service status gateway.*service logs gateway/u,
    );
  });

  it("allows more than the longest normal Surface startup window by default", async () => {
    const { environment } = fixture();
    let nowMs = 0;

    await expect(waitForCoreServiceTarget("gateway", environment, {
      gatewayHealthy: async () => false,
      intervalMs: 10_000,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
      },
    })).rejects.toThrow("Gateway 未能及时就绪");

    expect(nowMs).toBeGreaterThan(120_000);
  });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "codexc-local-update-"));
  temporaryDirectories.push(home);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_HOME: join(home, ".codex"),
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  const { configPath, dataDir } = initializeUserData({ environment, cwd: home });
  const document = readGatewayConfig(configPath);
  document.telegram = {
    allowed_user_ids: [1],
    bot_token: "test-token",
    message_format: "html",
  };
  writeGatewayConfig(configPath, document);
  return { configPath, dataDir, environment };
}
