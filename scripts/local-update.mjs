import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "smol-toml";

import {
  parseGatewayConfig,
  readGatewayConfig,
  validateGatewayConfigDocument,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  appServerSocketAcceptsWebSocket,
  inspectAppServerSupervisor,
  sameAppServerTopology,
} from "../runtime/app-server-supervisor.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import {
  gatewayOwnerIsActive,
  gatewayOwnerIsReady,
} from "../runtime/gateway-owner.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { opencodeGoProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import {
  assertSynchronousChildSuccess,
  ForwardedChildSignalError,
  ReportedChildExitError,
} from "../runtime/process-lifecycle.mjs";
import {
  loadConfigDocument,
  loadRuntimeConfig,
} from "../dist/config/index.js";
import { serviceDefinitionsForTarget } from "../runtime/service-targets.mjs";
import {
  modelRequestMetricsSchemaVersion,
} from "../dist/observability/index.js";
import { upgradeMetricsDatabase } from "./metrics-database.mjs";
import {
  inspectMetricsDatabase,
  metricsDatabaseCanUpgrade,
  validateMetricsDatabaseStructure,
} from "./metrics-database-access.mjs";
import {
  inspectStateDatabase,
  upgradeStateDatabase,
  validateStateDatabaseStructure,
} from "./upgrade-state.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import { backupAndMigrateProviderFiles } from "./backup-provider-migration.mjs";
import {
  downloadDeepseekCatalog,
  refreshDeepseekCatalogForUpdate,
} from "./deepseek-setup.mjs";
import { refreshOpencodeGoCatalogForUpdate } from "./opencode-go-setup.mjs";

const defaultCoreServiceReadinessTimeoutMs = 150_000;

export function updateGatewayConfiguration(environment = process.env, options = {}) {
  const { configPath } = requireUserConfig(environment);
  const before = readFileSync(configPath, "utf8");
  const now = options.now ?? (() => new Date());
  const backupPath = `${configPath}.pre-update.${backupTimestamp(now())}.bak`;
  if (existsSync(backupPath)) {
    throw new Error(`配置备份已存在：${backupPath}`);
  }
  copyFileSync(configPath, backupPath);
  chmodSync(backupPath, 0o600);
  try {
    const document = readGatewayConfig(configPath);
    const removedPaths = removeObsoleteGatewayConfig(document);
    if (removedPaths.length > 0) writeGatewayConfig(configPath, document);
    (options.loadConfig ?? (() => loadRuntimeConfig(environment)))();
    const changed = readFileSync(configPath, "utf8") !== before;
    const addedPaths = changed
      ? missingConfigPaths(
          parseGatewayConfig(before, configPath),
          parseGatewayConfig(readFileSync(configPath, "utf8"), configPath),
        )
      : [];
    if (!changed) unlinkSync(backupPath);
    return {
      addedPaths,
      backupPath: changed ? backupPath : null,
      changed,
      configPath,
      removedPaths,
    };
  } catch (error) {
    if (readFileSync(configPath, "utf8") !== before) {
      copyFileSync(backupPath, configPath);
      chmodSync(configPath, 0o600);
    }
    unlinkSync(backupPath);
    throw error;
  }
}

export function inspectGatewayConfiguration(environment = process.env) {
  const { configPath } = requireUserConfig(environment);
  const content = readFileSync(configPath, "utf8");
  const source = parseGatewayConfig(content, configPath);
  const removedPaths = removeObsoleteGatewayConfig(source);
  const defaults = validateGatewayConfigDocument(source);
  loadConfigDocument(stringify(source), dirname(configPath), {
    environment,
    detectSystemProxy: true,
  });
  return {
    configPath,
    missingSafeDefaults: missingConfigPaths(source, defaults),
    removedPaths,
  };
}

export async function updateLocalInstallation(environment = process.env, options = {}) {
  if (
    environment.CODEX_CONNECT_SERVICE_ROLE === "app-server"
    || environment.CODEX_CONNECT_SERVICE_ROLE === "gateway"
  ) {
    throw new Error("不能在运行中的 Codex 服务内执行更新；请在本机终端运行 codexc update");
  }
  const configInspection = (options.inspectConfig
    ?? (() => inspectGatewayConfiguration(environment)))();
  const databaseInspection = (options.inspectDatabases
    ?? (() => inspectDatabaseUpdates(environment)))();
  const serviceInspection = (options.inspectServices
    ?? (() => inspectCoreServiceInstallation(environment)))();
  if (
    !serviceInspection.installed
    && await gatewayOwnerIsActive(configInspection.configPath)
  ) {
    throw new Error(
      "核心后台服务未安装，但检测到前台 Gateway 正在运行；"
      + "请在运行 codexc start 的终端按 Ctrl-C，确认退出后再重试 codexc update",
    );
  }
  (options.onInspected ?? (() => {}))({
    config: configInspection,
    databases: databaseInspection,
    services: serviceInspection,
  });
  const stopServices = options.stopServices
    ?? (() => runCoreServiceAction("stop", environment));
  const startServices = options.startServices
    ?? (() => runCoreServiceAction("start", environment));
  const waitForServices = options.waitForServices
    ?? (() => waitForCoreServices(environment));
  const databaseOptions = {
    ...options.databaseOptions,
    inspect: options.databaseOptions?.inspect ?? (() => databaseInspection),
  };
  if (serviceInspection.installed) {
    await stopCoreServices(stopServices, startServices, waitForServices);
  }

  let config;
  let databases;
  let providerCatalogs;
  let updateError;
  try {
    (options.updateProviderFiles
      ?? (() => backupAndMigrateProviderFiles(environment, { apply: true })))();
    providerCatalogs = await (options.updateProviderCatalogs
      ?? (() => refreshManagedProviderCatalogsForUpdate(environment)))();
    config = (options.updateConfig
      ?? (() => updateGatewayConfiguration(environment)))();
    databases = (options.updateDatabases
      ?? (() => updateDatabases(environment, databaseOptions)))();
    (options.validateOffline
      ?? (() => validateLocalInstallation(environment)))();
  } catch (error) {
    updateError = error;
  }

  let startError;
  if (serviceInspection.installed) {
    try {
      startServices();
      await waitForServices();
    } catch (error) {
      startError = error;
    }
  }
  if (updateError !== undefined && startError !== undefined) {
    throw new AggregateError(
      [updateError, startError],
      "本地更新失败，且核心服务未能恢复就绪",
      { cause: updateError },
    );
  }
  if (updateError !== undefined) throw updateError;
  if (startError !== undefined) throw startError;
  return {
    config,
    databases,
    providerCatalogs,
    servicesRestored: serviceInspection.installed,
  };
}

async function refreshManagedProviderCatalogsForUpdate(environment) {
  let downloaded;
  const downloadCatalog = async () => {
    downloaded ??= await downloadDeepseekCatalog(globalThis.fetch);
    return downloaded;
  };
  return {
    deepseek: await refreshDeepseekCatalogForUpdate(environment, { downloadCatalog }),
    opencodeGo: await refreshOpencodeGoCatalogForUpdate(environment, { downloadCatalog }),
  };
}

function removeObsoleteGatewayConfig(document) {
  const removedPaths = [];
  if (Object.hasOwn(document, "vision")) {
    delete document.vision;
    removedPaths.push("vision");
  }
  return removedPaths;
}

export function inspectCoreServiceInstallation(
  environment = process.env,
  platform = process.platform,
) {
  const home = environment.HOME;
  if (!home) {
    throw new Error("无法检查后台服务安装状态：HOME 未设置");
  }
  let definitionsDirectory;
  let identifierKey;
  if (platform === "linux") {
    const configHome = environment.XDG_CONFIG_HOME?.trim() || join(home, ".config");
    definitionsDirectory = join(configHome, "systemd", "user");
    identifierKey = "systemd";
  } else if (platform === "darwin") {
    definitionsDirectory = join(home, "Library", "LaunchAgents");
    identifierKey = "launchd";
  } else {
    throw new Error("codexc update 当前支持 macOS launchd 与 Linux systemd");
  }
  const paths = serviceDefinitionsForTarget("all").map((definition) =>
    join(
      definitionsDirectory,
      platform === "darwin"
        ? `${definition[identifierKey]}.plist`
        : definition[identifierKey],
    )
  );
  const existingPaths = paths.filter((path) => existsSync(path));
  if (existingPaths.length === 0) {
    return { installed: false };
  }
  if (existingPaths.length !== paths.length) {
    throw new Error("核心后台服务安装不完整；请先运行 codexc service install");
  }
  return { installed: true };
}

export function inspectDatabaseUpdates(environment = process.env, options = {}) {
  const state = (options.inspectState ?? (() => inspectStateDatabase(environment)))();
  const metrics = (options.inspectMetrics ?? (() => inspectMetricsDatabase(environment)))();
  const failures = [];
  if (!state.updateable) {
    failures.push(
      `状态数据库 Schema ${state.schemaVersion ?? "unknown"} 无法直接更新到 ${state.targetSchemaVersion}`,
    );
  }
  if (
    metrics.exists
    && !metrics.compatible
    && !metricsDatabaseCanUpgrade(metrics.schemaVersion)
  ) {
    failures.push(
      `指标数据库 Schema ${metrics.schemaVersion ?? "unknown"} 无法直接更新到 ${modelRequestMetricsSchemaVersion}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`数据库版本预检失败：${failures.join("；")}`);
  }
  (options.validateMetrics
    ?? (() => validateMetricsDatabaseStructure(environment, { allowUpgradeable: true })))();
  return { state, metrics };
}

export function updateDatabases(environment = process.env, options = {}) {
  const updateState = options.updateState
    ?? (() => upgradeStateDatabase(environment, { allowMissing: true }));
  const updateMetrics = options.updateMetrics
    ?? (() => upgradeMetricsDatabase(environment));
  const inspect = options.inspect
    ?? (() => inspectDatabaseUpdates(environment));
  const onInspected = options.onInspected ?? (() => {});
  const onUpdated = options.onUpdated ?? (() => {});

  const inspection = inspect();
  onInspected(inspection);

  const results = {};
  const failures = [];
  for (const [name, update] of [["state", updateState], ["metrics", updateMetrics]]) {
    try {
      results[name] = update();
      onUpdated(name, results[name]);
    } catch (error) {
      failures.push({ name, error });
    }
  }

  if (failures.length > 0) {
    const messages = failures.map(({ name, error }) =>
      `${failureLabel(name)}：${error instanceof Error ? error.message : String(error)}`
    );
    throw new AggregateError(
      failures.map(({ error }) => error),
      `数据库更新未全部完成：${messages.join("；")}`,
    );
  }

  return results;
}

export function validateLocalInstallation(environment = process.env) {
  const config = inspectGatewayConfiguration(environment);
  const state = validateStateDatabaseStructure(environment);
  const metrics = validateMetricsDatabaseStructure(environment);
  return { config, state, metrics };
}

export async function waitForCoreServices(environment = process.env, options = {}) {
  return waitForCoreServiceTarget("all", environment, options);
}

export async function waitForCoreServiceTarget(
  target,
  environment = process.env,
  options = {},
) {
  if (target !== "gateway" && target !== "app-server" && target !== "all") {
    throw new Error(`核心服务就绪目标无效：${String(target)}`);
  }
  const requiresAppServer = target === "app-server" || target === "all";
  const requiresGateway = target === "gateway" || target === "all";
  const { configPath, dataDir } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const descriptor = resolveAppServerRuntime(document, dataDir, environment);
  const timeoutMs = options.timeoutMs ?? defaultCoreServiceReadinessTimeoutMs;
  const intervalMs = options.intervalMs ?? 100;
  const stableMs = options.stableMs ?? 500;
  const now = options.now ?? Date.now;
  const sleep = options.sleep
    ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const inspectSupervisor = options.inspectSupervisor ?? inspectAppServerSupervisor;
  const socketHealthy = options.socketHealthy ?? appServerSocketAcceptsWebSocket;
  const gatewayHealthy = options.gatewayHealthy ?? gatewayOwnerIsReady;
  const deadline = now() + timeoutMs;
  let healthySince;
  while (now() < deadline) {
    let appServerReady = true;
    if (requiresAppServer) {
      const supervisor = await inspectSupervisor(descriptor.primarySocketPath);
      const primarySocketHealthy = await socketHealthy(descriptor.primarySocketPath);
      appServerReady = sameAppServerTopology(supervisor, descriptor.topology)
        && primarySocketHealthy;
    }
    const gatewayReady = !requiresGateway || await gatewayHealthy(configPath);
    const healthy = appServerReady && gatewayReady;
    if (healthy) {
      healthySince ??= now();
      if (now() - healthySince >= stableMs) return;
    } else {
      healthySince = undefined;
    }
    await sleep(intervalMs);
  }
  const label = target === "all"
    ? "Codex App Server 与 Gateway"
    : target === "app-server"
      ? "Codex App Server"
      : "Gateway";
  throw new Error(
    `${label} 未能及时就绪；请运行 codexc service status ${target}，`
    + `并查看 codexc service logs ${target}`,
  );
}

async function stopCoreServices(stopServices, startServices, waitForServices) {
  try {
    stopServices();
  } catch (stopError) {
    let startError;
    try {
      startServices();
      await waitForServices();
    } catch (error) {
      startError = error;
    }
    if (startError !== undefined) {
      throw new AggregateError(
        [stopError, startError],
        "本地更新前停止核心服务失败，且核心服务未能恢复运行",
        { cause: stopError },
      );
    }
    throw stopError;
  }
}

function runCoreServiceAction(action, environment) {
  const cli = resolve(import.meta.dirname, "../bin/codexc.mjs");
  const result = spawnSync(
    process.execPath,
    [cli, "service", action, "all"],
    { env: environment, stdio: "inherit" },
  );
  assertSynchronousChildSuccess(result, { failureReportedByChild: true });
}

function failureLabel(name) {
  if (name === "state") return "状态数据库";
  if (name === "metrics") return "指标数据库";
  return "核心服务恢复";
}

function printDatabaseResult(name, result) {
  const label = name === "state" ? "状态数据库" : "指标数据库";
  const version = name === "state" ? result.version : result.schemaVersion;
  if (version === null) {
    writeCliMessage("note", `${label}尚未创建，无需更新。`);
    console.log(`数据库：${result.databasePath}`);
    return;
  }
  if (!result.changed) {
    writeCliMessage("note", `${label}已是 Schema ${version}。`);
    console.log(`数据库：${result.databasePath}`);
    return;
  }
  writeCliMessage("success", `${label}已更新到 Schema ${version}。`);
  console.log(`数据库：${result.databasePath}`);
  console.log(`更新前备份：${result.backupPath}`);
}

function printInspection({ state, metrics }) {
  writeCliMessage("note", "数据库版本预检通过。");
  console.log(`状态数据库：${versionTransition(
    state.exists ? state.schemaVersion : null,
    state.targetSchemaVersion,
  )}`);
  console.log(`指标数据库：${versionTransition(
    metrics.exists ? metrics.schemaVersion : null,
    modelRequestMetricsSchemaVersion,
  )}`);
}

function versionTransition(current, target) {
  if (current === null) return `尚未创建 → Schema ${target}`;
  if (current === target) return `Schema ${target}（已兼容）`;
  return `Schema ${current} → Schema ${target}`;
}

function backupTimestamp(date) {
  return date.toISOString().replaceAll(/[:.]/gu, "-");
}

function missingConfigPaths(current, defaults, prefix = "") {
  const paths = [];
  for (const [key, value] of Object.entries(defaults)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(current, key)) {
      if (isRecord(value)) {
        paths.push(...missingConfigPaths({}, value, path));
      } else {
        paths.push(path);
      }
      continue;
    }
    const currentValue = current[key];
    if (isRecord(currentValue) && isRecord(value)) {
      paths.push(...missingConfigPaths(currentValue, value, path));
    }
  }
  return paths;
}

function isRecord(value) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(value instanceof Date);
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await updateLocalInstallation(process.env, {
      onInspected: ({ config, services }) => {
        writeCliMessage("note", "本地更新预检通过。");
        console.log(`配置：${config.configPath}`);
        console.log(config.missingSafeDefaults.length === 0
          ? "配置参数：已兼容"
          : `待补齐安全参数：${config.missingSafeDefaults.join("、")}`);
        if (config.removedPaths.length > 0) {
          console.log(`待移除旧配置：${config.removedPaths.join("、")}`);
        }
        if (!services.installed) {
          writeCliMessage("note", "核心后台服务未安装，本次只离线更新配置与数据库。");
        }
      },
      updateConfig: () => {
        const result = updateGatewayConfiguration(process.env);
        if (result.changed) {
          writeCliMessage("success", "config.toml 缺失的安全参数已补齐。");
          console.log(`配置：${result.configPath}`);
          if (result.addedPaths.length > 0) {
            console.log(`已补齐参数：${result.addedPaths.join("、")}`);
          }
          if (result.removedPaths.length > 0) {
            console.log(`已移除旧配置：${result.removedPaths.join("、")}`);
          }
          console.log(`更新前备份：${result.backupPath}`);
        } else {
          writeCliMessage("note", "config.toml 已兼容，无需更新。");
        }
        return result;
      },
      updateProviderFiles: () => {
        const result = backupAndMigrateProviderFiles(process.env, { apply: true });
        if (result.status === "migrated") {
          if (result.layout.changed) {
            writeCliMessage(
              "success",
              `第三方 Provider 文件已迁移（${result.layout.moved.length} 项）。`,
            );
          }
          if (result.settings.changed) {
            writeCliMessage(
              "success",
              `第三方模型设置已迁移为逐模型配置（${result.settings.updated.length} 个文件）。`,
            );
          }
          console.log(`迁移前备份：${result.backupDirectory}`);
        }
        return result;
      },
      updateProviderCatalogs: async () => {
        let downloaded;
        const downloadCatalog = async () => {
          downloaded ??= await downloadDeepseekCatalog(globalThis.fetch);
          return downloaded;
        };
        const deepseek = await refreshDeepseekCatalogForUpdate(process.env, { downloadCatalog });
        if (deepseek.status === "updated") {
          writeCliMessage(
            "success",
            `DeepSeek 官方模型目录已更新（${deepseek.modelCount} 个模型）。`,
          );
          console.log(`当前默认选择保持：${deepseek.selectedModel}`);
        }
        const opencodeGo = await refreshOpencodeGoCatalogForUpdate(process.env, {
          downloadCatalog,
        });
        if (opencodeGo.status === "updated") {
          writeCliMessage(
            "success",
            `OpenCode Go 官方模型目录已更新（${opencodeGo.modelCount} 个模型）。`,
          );
          if (opencodeGo.migratedProviders.length > 0) {
            console.log(
              `已切换旧默认模型：${opencodeGo.migratedProviders.join("、")} → ${opencodeGoProviderDefinition.defaultModel}`,
            );
          } else {
            console.log("OpenCode Go 当前默认选择均已保留。");
          }
        }
        return { deepseek, opencodeGo };
      },
      databaseOptions: {
        onInspected: printInspection,
        onUpdated: printDatabaseResult,
      },
    });
    writeCliMessage(
      "success",
      result.servicesRestored
        ? "本地配置、模型目录与数据库更新完成，App Server 与 Gateway 已恢复运行。"
        : "本地配置、模型目录与数据库更新完成；核心后台服务未安装，未执行启动。",
    );
  } catch (error) {
    if (
      !(error instanceof ReportedChildExitError)
      && !(error instanceof ForwardedChildSignalError)
    ) {
      writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    }
    if (error instanceof ReportedChildExitError) {
      process.exitCode = error.exitCode;
    } else if (!(error instanceof ForwardedChildSignalError)) {
      process.exitCode = 1;
    }
  }
}
