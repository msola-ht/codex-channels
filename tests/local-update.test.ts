import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
import {
  inspectDatabaseUpdates,
  updateDatabases,
  updateGatewayConfiguration,
  updateLocalInstallation,
  waitForCoreServices,
} from "../scripts/local-update.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local update", () => {
  it("materializes only missing safe config defaults and keeps a private backup", () => {
    const { environment, configPath } = fixture();
    const document = readGatewayConfig(configPath);
    delete document.display;
    writeGatewayConfig(configPath, document);

    const result = updateGatewayConfiguration(environment, {
      now: () => new Date("2026-08-13T12:34:56.789Z"),
    });

    expect(result.changed).toBe(true);
    expect(result.addedPaths).toEqual(expect.arrayContaining([
      "display.operation_updates",
      "display.plan_updates",
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
    for (const schemaVersion of [3, 4, 5, 6]) {
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
      stopServices: () => {
        calls.push("stop");
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
      "update-config",
      "update-databases",
      "validate-offline",
      "start",
      "wait-ready",
    ]);
    expect(result).toEqual({ config: "config", databases: "databases" });
  });

  it("restores and verifies core services when stopping reports a failure", async () => {
    const calls: string[] = [];
    await expect(updateLocalInstallation(terminalEnvironment(), {
      inspectConfig: () => ({ configPath: "/config", missingSafeDefaults: [] }),
      inspectDatabases: () => ({ state: {}, metrics: {} }),
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
        managedProvider: descriptor.topology.managedProvider ?? null,
        socketPaths: descriptor.topology.socketPaths,
        version: 1,
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
  const environment = { ...process.env };
  delete environment.CODEX_CONNECT_SERVICE_ROLE;
  return environment;
}
