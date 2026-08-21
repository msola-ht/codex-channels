import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { GatewayOwner } from "../runtime/gateway-owner.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
import {
  inspectDatabaseUpdates,
  inspectCoreServiceInstallation,
  inspectGatewayConfiguration,
  updateDatabases,
  updateGatewayConfiguration,
  updateLocalInstallation,
  waitForCoreServiceTarget,
  waitForCoreServices,
} from "../scripts/local-update.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local update", () => {
  it("distinguishes an uninstalled service set from a partial installation", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-local-update-services-"));
    temporaryDirectories.push(home);
    const environment = { ...process.env, HOME: home, XDG_CONFIG_HOME: "" };

    expect(inspectCoreServiceInstallation(environment, "linux")).toEqual({
      installed: false,
    });

    const unitsDirectory = join(home, ".config", "systemd", "user");
    mkdirSync(unitsDirectory, { recursive: true });
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

  it("materializes only missing safe config defaults and keeps a private backup", () => {
    const { environment, configPath } = fixture();
    const document = readGatewayConfig(configPath);
    delete document.display;
    writeGatewayConfig(configPath, document);

    const result = updateGatewayConfiguration(environment, {
      now: () => new Date("2026-08-13T12:34:56.789Z"),
    });

    expect(result.changed).toBe(true);
    expect(result.removedPaths).toEqual([]);
    expect(result.addedPaths).toEqual(expect.arrayContaining([
      "display.operation_updates",
      "display.plan_updates",
      "display.reasoning",
      "display.price_currency",
    ]));
    expect(result.backupPath).toContain(".pre-update.2026-08-13T12-34-56-789Z.bak");
    if (result.backupPath === null) throw new Error("缺少配置备份");
    expect(existsSync(result.backupPath)).toBe(true);
    expect(statSync(result.backupPath).mode & 0o777).toBe(0o600);
    expect(readGatewayConfig(configPath).display).toMatchObject({
      operation_updates: "compact",
      plan_updates: true,
      price_currency: "cny",
    });
  });

  it("backs up and removes the obsolete vision config during update", () => {
    const { environment, configPath } = fixture();
    const document = readGatewayConfig(configPath);
    (document as Record<string, unknown>).vision = {
      mode: "responses_api",
      provider: "relay",
      model: "legacy-vision",
    };
    writeGatewayConfig(configPath, document);

    expect(inspectGatewayConfiguration(environment)).toMatchObject({
      removedPaths: ["vision"],
    });
    const result = updateGatewayConfiguration(environment);

    expect(result.changed).toBe(true);
    expect(result.removedPaths).toEqual(["vision"]);
    expect(result.backupPath).not.toBeNull();
    expect((readGatewayConfig(configPath) as Record<string, unknown>).vision).toBeUndefined();
  });

  it("restores the obsolete vision config when config validation fails", () => {
    const { environment, configPath } = fixture();
    const document = readGatewayConfig(configPath);
    (document as Record<string, unknown>).vision = {
      mode: "responses_api",
      provider: "relay",
      model: "legacy-vision",
    };
    writeGatewayConfig(configPath, document);

    expect(() => updateGatewayConfiguration(environment, {
      loadConfig: () => {
        throw new Error("validation failed");
      },
    })).toThrow("validation failed");

    expect((readGatewayConfig(configPath) as Record<string, unknown>).vision)
      .toMatchObject({ model: "legacy-vision" });
    expect(readdirSync(dirname(configPath)))
      .not.toEqual(expect.arrayContaining([expect.stringContaining(".pre-update.")]));
  });

  it("rejects unsupported database schemas before applying updates", () => {
    expect(() => updateDatabases(process.env, {
      inspect: () => inspectDatabaseUpdates(process.env, {
        inspectState: () => ({
          schemaVersion: 2,
          targetSchemaVersion: 4,
          updateable: false,
        }),
        inspectMetrics: () => ({
          compatible: true,
          exists: true,
          schemaVersion: 7,
        }),
      }),
    })).toThrow(/数据库版本预检失败.*状态数据库 Schema 2/u);
  });

  it("accepts every metrics schema with an explicit migration path", () => {
    for (const schemaVersion of [3, 4, 5, 6, 7, 8, 9]) {
      expect(inspectDatabaseUpdates(process.env, {
        inspectState: () => ({
          schemaVersion: 4,
          targetSchemaVersion: 4,
          updateable: true,
        }),
        inspectMetrics: () => ({
          compatible: false,
          exists: true,
          schemaVersion,
        }),
        validateMetrics: () => undefined,
      }).metrics.schemaVersion).toBe(schemaVersion);
    }
  });

  it("updates both databases after their shared preflight", () => {
    const calls: string[] = [];
    const result = updateDatabases(process.env, {
      inspect: () => ({ state: {}, metrics: {} }),
      updateState: () => {
        calls.push("state");
        return { changed: false, databasePath: "/state", version: 4 };
      },
      updateMetrics: () => {
        calls.push("metrics");
        return { changed: false, databasePath: "/metrics", schemaVersion: 7 };
      },
    });

    expect(calls).toEqual(["state", "metrics"]);
    expect(result.state.version).toBe(4);
    expect(result.metrics.schemaVersion).toBe(7);
  });

  it("keeps config and both databases inside one stopped service window", async () => {
    const calls: string[] = [];
    const result = await updateLocalInstallation(terminalEnvironment(), {
      inspectConfig: () => {
        calls.push("inspect-config");
        return { configPath: "/config", missingSafeDefaults: [] };
      },
      inspectDatabases: () => {
        calls.push("inspect-databases");
        return { state: {}, metrics: {} };
      },
      inspectServices: () => ({ installed: true }),
      stopServices: () => {
        calls.push("stop");
      },
      updateProviderFiles: () => {
        calls.push("update-provider-files");
      },
      updateProviderCatalogs: () => {
        calls.push("update-provider-catalogs");
        return "provider-catalogs";
      },
      updateConfig: () => {
        calls.push("update-config");
        return "config";
      },
      updateDatabases: () => {
        calls.push("update-databases");
        return "databases";
      },
      validateOffline: () => calls.push("validate-offline"),
      startServices: () => calls.push("start"),
      waitForServices: async () => {
        calls.push("wait-ready");
      },
    });

    expect(calls).toEqual([
      "inspect-config",
      "inspect-databases",
      "stop",
      "update-provider-files",
      "update-provider-catalogs",
      "update-config",
      "update-databases",
      "validate-offline",
      "start",
      "wait-ready",
    ]);
    expect(result).toEqual({
      config: "config",
      databases: "databases",
      providerCatalogs: "provider-catalogs",
      servicesRestored: true,
    });
  });

  it("updates offline without starting services when core services are not installed", async () => {
    const calls: string[] = [];
    const result = await updateLocalInstallation(terminalEnvironment(), {
      inspectConfig: () => {
        calls.push("inspect-config");
        return { configPath: "/config", missingSafeDefaults: [] };
      },
      inspectDatabases: () => {
        calls.push("inspect-databases");
        return { state: {}, metrics: {} };
      },
      inspectServices: () => {
        calls.push("inspect-services");
        return { installed: false };
      },
      stopServices: () => calls.push("stop"),
      updateProviderFiles: () => calls.push("update-provider-files"),
      updateProviderCatalogs: () => {
        calls.push("update-provider-catalogs");
        return "provider-catalogs";
      },
      updateConfig: () => {
        calls.push("update-config");
        return "config";
      },
      updateDatabases: () => {
        calls.push("update-databases");
        return "databases";
      },
      validateOffline: () => calls.push("validate-offline"),
      startServices: () => calls.push("start"),
      waitForServices: async () => {
        calls.push("wait-ready");
      },
    });

    expect(calls).toEqual([
      "inspect-config",
      "inspect-databases",
      "inspect-services",
      "update-provider-files",
      "update-provider-catalogs",
      "update-config",
      "update-databases",
      "validate-offline",
    ]);
    expect(result).toEqual({
      config: "config",
      databases: "databases",
      providerCatalogs: "provider-catalogs",
      servicesRestored: false,
    });
  });

  it("backs up and migrates legacy provider files by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-local-update-provider-migration-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, ".codex");
    const connectHome = join(root, ".codex-connect");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(join(connectHome, "providers"), { recursive: true, mode: 0o700 });
    const catalogPath = join(codexHome, "sf-deepseek.models.json");
    writeFileSync(
      catalogPath,
      `${JSON.stringify({
        models: [{
          slug: "deepseek-v4-flash",
          display_name: "DeepSeek-V4-Flash",
          context_window: 1_048_576,
          default_reasoning_level: "high",
          supported_reasoning_levels: [{ effort: "high", description: "High" }],
        }],
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "sf-deepseek.models.manifest.json"),
      JSON.stringify({ sha256: "legacy" }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "sf-deepseek.managed.toml"),
      'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "sf-deepseek.config.toml"),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        'model_reasoning_effort = "high"',
        `model_catalog_json = ${JSON.stringify(catalogPath)}`,
        "[model_providers.deepseek]",
        'name = "deepseek"',
        'base_url = "https://api.deepseek.com/"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        'experimental_bearer_token = "sk-test-secret"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: connectHome,
    };
    delete environment.CODEX_CONNECT_SERVICE_ROLE;

    const result = await updateLocalInstallation(environment, {
      inspectConfig: () => ({
        configPath: join(connectHome, "config.toml"),
        missingSafeDefaults: [],
      }),
      inspectDatabases: () => ({ state: {}, metrics: {} }),
      inspectServices: () => ({ installed: false }),
      updateConfig: () => "config",
      updateProviderCatalogs: () => "provider-catalogs",
      updateDatabases: () => "databases",
      validateOffline: () => undefined,
      startServices: () => undefined,
      waitForServices: async () => undefined,
    });

    expect(result).toEqual({
      config: "config",
      databases: "databases",
      providerCatalogs: "provider-catalogs",
      servicesRestored: false,
    });
    const providerDirectory = join(connectHome, "providers", "deepseek");
    expect(existsSync(join(providerDirectory, "models.json"))).toBe(true);
    expect(existsSync(join(providerDirectory, "models.manifest.json"))).toBe(true);
    expect(existsSync(join(providerDirectory, "managed.toml"))).toBe(true);
    expect(existsSync(catalogPath)).toBe(false);
    expect(readdirSync(join(connectHome, "backups")).some((name) =>
      name.startsWith("provider-migration-"))).toBe(true);
  });

  it("rejects before writing when an uninstalled foreground Gateway is active", async () => {
    const { configPath, environment: fixtureEnvironment } = fixture();
    const environment: NodeJS.ProcessEnv = { ...fixtureEnvironment };
    delete environment.CODEX_CONNECT_SERVICE_ROLE;
    const owner = new GatewayOwner(configPath);
    const calls: string[] = [];
    await owner.start();
    try {
      await expect(updateLocalInstallation(environment, {
        inspectConfig: () => {
          calls.push("inspect-config");
          return { configPath, missingSafeDefaults: [] };
        },
        inspectDatabases: () => {
          calls.push("inspect-databases");
          return { state: {}, metrics: {} };
        },
        inspectServices: () => {
          calls.push("inspect-services");
          return { installed: false };
        },
        stopServices: () => calls.push("stop"),
        updateConfig: () => calls.push("update-config"),
        updateDatabases: () => calls.push("update-databases"),
        startServices: () => calls.push("start"),
      })).rejects.toThrow(
        /前台 Gateway 正在运行.*codexc start.*Ctrl-C.*codexc update/u,
      );

      expect(calls).toEqual([
        "inspect-config",
        "inspect-databases",
        "inspect-services",
      ]);
    } finally {
      await owner.close();
    }
  });

  it("restores and verifies core services when stopping reports a failure", async () => {
    const calls: string[] = [];
    await expect(updateLocalInstallation(terminalEnvironment(), {
      inspectConfig: () => ({ configPath: "/config", missingSafeDefaults: [] }),
      inspectDatabases: () => ({ state: {}, metrics: {} }),
      inspectServices: () => ({ installed: true }),
      stopServices: () => {
        calls.push("stop");
        throw new Error("stop failed");
      },
      startServices: () => calls.push("start"),
      waitForServices: async () => {
        calls.push("wait-ready");
      },
    })).rejects.toThrow(/stop failed/u);
    expect(calls).toEqual(["stop", "start", "wait-ready"]);
  });

  it("restores and verifies core services when an offline update fails", async () => {
    const calls: string[] = [];
    await expect(updateLocalInstallation(terminalEnvironment(), {
      inspectConfig: () => ({ configPath: "/config", missingSafeDefaults: [] }),
      inspectDatabases: () => ({ state: {}, metrics: {} }),
      inspectServices: () => ({ installed: true }),
      stopServices: () => calls.push("stop"),
      updateConfig: () => calls.push("update-config"),
      updateDatabases: () => {
        calls.push("update-databases");
        throw new Error("database failed");
      },
      validateOffline: () => calls.push("validate-offline"),
      startServices: () => calls.push("start"),
      waitForServices: async () => {
        calls.push("wait-ready");
      },
    })).rejects.toThrow(/database failed/u);
    expect(calls).toEqual([
      "stop",
      "update-config",
      "update-databases",
      "start",
      "wait-ready",
    ]);
  });

  it("validates config and databases before stopping or applying updates", async () => {
    const calls: string[] = [];
    await expect(updateLocalInstallation(terminalEnvironment(), {
      inspectConfig: () => {
        calls.push("inspect-config");
        return { configPath: "/config", missingSafeDefaults: [] };
      },
      inspectDatabases: () => {
        calls.push("inspect-databases");
        throw new Error("schema mismatch");
      },
      updateConfig: () => {
        calls.push("update-config");
      },
    })).rejects.toThrow(/schema mismatch/u);
    expect(calls).toEqual(["inspect-config", "inspect-databases"]);
  });

  it("rejects updates launched inside a running Codex service", async () => {
    await expect(updateLocalInstallation({
      ...process.env,
      CODEX_CONNECT_SERVICE_ROLE: "app-server",
    })).rejects.toThrow(/请在本机终端运行 codexc update/u);
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
    await waitForCoreServices(environment, {
      gatewayHealthy: () => ++gatewayChecks >= 2,
      inspectSupervisor: () => ({
        pid: process.pid,
        primaryProvider: descriptor.topology.primaryProvider,
        managedProviders: descriptor.topology.managedProviders,
        socketPaths: descriptor.topology.socketPaths,
        version: 4,
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

function terminalEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "codexc-local-update-terminal-"));
  temporaryDirectories.push(root);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: join(root, ".codex"),
    CODEX_CONNECT_HOME: join(root, ".codex-connect"),
  };
  delete environment.CODEX_CONNECT_SERVICE_ROLE;
  return environment;
}
