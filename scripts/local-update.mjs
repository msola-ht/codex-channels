import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
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
import { applyTerminalIdentityFromEnvironment } from "./config-management.mjs";
import {
  appServerSocketAcceptsWebSocket,
  inspectAppServerSupervisorState,
  sameAppServerTopology,
} from "../runtime/app-server-supervisor.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import {
  gatewayOwnerIsActive,
  gatewayOwnerIsReady,
} from "../runtime/gateway-owner.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { resolveExecutable } from "../runtime/executable.mjs";
import {
  securePrivateFileSync,
  writePrivateFileAtomicSync,
} from "../runtime/private-file.mjs";
import { codexHomePath } from "../runtime/codex-home.mjs";
import { codexProxyFields, readCodexProxySnapshot, renderCodexProxySettings } from "../runtime/codex-proxy-env.mjs";
import { updateCodexUserConfig } from "./codex-user-config.mjs";
import {
  assertManagedModelProviderCapabilities,
  managedModelProviderDefinitions,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
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
import { packageDir } from "./package-path.mjs";
import { requireUserConfig, resolveConfiguredPath } from "./runtime-config.mjs";
import { backupAndMigrateProviderFiles } from "./backup-provider-migration.mjs";
import {
  downloadDeepseekCatalog,
  refreshDeepseekCatalogForUpdate,
} from "./deepseek-setup.mjs";
import { refreshOpencodeGoCatalogForUpdate } from "./opencode-go-setup.mjs";

const defaultCoreServiceReadinessTimeoutMs = 150_000;
const sessionDisplayCacheSchemaVersion = 1;
const obsoleteServiceDefinitions = Object.freeze([
  Object.freeze({
    id: "metrics-center",
    target: "center",
    systemd: "codex-connect-center.service",
    launchd: "com.hegenai.codex-center",
    windows: "Codex Connect Metrics Center",
  }),
]);

export function inspectSessionDisplayCache(environment = process.env) {
  const databasePath = resolveSessionDisplayCachePath(environment);
  if (!existsSync(databasePath)) {
    return {
      compatible: true,
      databasePath,
      exists: false,
      schemaVersion: null,
      targetSchemaVersion: sessionDisplayCacheSchemaVersion,
      updateable: true,
    };
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    return {
      compatible: version === sessionDisplayCacheSchemaVersion,
      databasePath,
      exists: true,
      schemaVersion: version,
      targetSchemaVersion: sessionDisplayCacheSchemaVersion,
      updateable: true,
    };
  } finally {
    database.close();
  }
}

/**
 * The session display cache is derived data, so an incompatible version is
 * rebuilt rather than migrated. Keep the old file as a private backup.
 */
export function updateSessionDisplayCache(environment = process.env) {
  const databasePath = resolveSessionDisplayCachePath(environment);
  if (!existsSync(databasePath)) {
    return { changed: false, databasePath, schemaVersion: null };
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let version;
  try {
    version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
  } finally {
    database.close();
  }
  if (version === sessionDisplayCacheSchemaVersion) {
    return { changed: false, databasePath, schemaVersion: version };
  }
  const backupPath = `${databasePath}.v${version || "unknown"}.${backupTimestamp(new Date())}.bak`;
  if (existsSync(backupPath)) {
    throw new Error(`会话展示缓存备份已存在：${backupPath}`);
  }
  copyFileSync(databasePath, backupPath);
  securePrivateFileSync(backupPath);
  unlinkSync(databasePath);
  return {
    changed: true,
    databasePath,
    schemaVersion: sessionDisplayCacheSchemaVersion,
    backupPath,
  };
}

export function updateGatewayConfiguration(environment = process.env, options = {}) {
  const { configPath } = requireUserConfig(environment);
  const before = readFileSync(configPath, "utf8");
  const now = options.now ?? (() => new Date());
  const backupPath = `${configPath}.pre-update.${backupTimestamp(now())}.bak`;
  if (existsSync(backupPath)) {
    throw new Error(`配置备份已存在：${backupPath}`);
  }
  copyFileSync(configPath, backupPath);
  securePrivateFileSync(backupPath);
  let proxyMigration;
  let proxyWritten = false;
  let proxyBackupPath;
  try {
    const document = readGatewayConfig(configPath);
    proxyMigration = planProxyMigration(document, environment);
    const removedPaths = removeObsoleteGatewayConfig(document);
    validateGatewayConfigDocument(document);
    if (proxyMigration?.changed) {
      if (proxyMigration.content !== null) {
        const candidate = `${proxyMigration.path}.pre-update.${backupTimestamp(now())}.bak`;
        if (existsSync(candidate)) throw new Error("Codex .env 迁移备份已存在");
        writePrivateFileAtomicSync(candidate, proxyMigration.content);
        proxyBackupPath = candidate;
      }
      writePrivateFileAtomicSync(proxyMigration.path, proxyMigration.nextContent);
      proxyWritten = true;
    }
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
    if (proxyWritten) {
      if (proxyMigration.content === null) unlinkSync(proxyMigration.path);
      else writePrivateFileAtomicSync(proxyMigration.path, proxyMigration.content);
    }
    if (proxyBackupPath && existsSync(proxyBackupPath)) unlinkSync(proxyBackupPath);
    if (readFileSync(configPath, "utf8") !== before) {
      copyFileSync(backupPath, configPath);
      securePrivateFileSync(configPath);
    }
    unlinkSync(backupPath);
    throw error;
  }
}

export function inspectGatewayConfiguration(environment = process.env) {
  const { configPath } = requireUserConfig(environment);
  const content = readFileSync(configPath, "utf8");
  const source = parseGatewayConfig(content, configPath);
  planProxyMigration(source, environment);
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

export async function updateReasoningSummaryOnce(environment = process.env, options = {}) {
  const markerPath = join(codexHomePath(environment), ".codexc-reasoning-summary-0.155.1");
  if (existsSync(markerPath)) {
    if (readFileSync(markerPath, "utf8") !== "completed\n") {
      throw new Error("Codex 0.155.1 推理摘要更新标记无效");
    }
    return { changed: false };
  }
  let changed = false;
  await updateCodexUserConfig(environment, (config) => {
    changed = config.model_reasoning_summary !== "none";
    return changed ? [{ keyPath: "model_reasoning_summary", value: "none" }] : [];
  }, options);
  writePrivateFileAtomicSync(markerPath, "completed\n");
  return { changed };
}

export async function updateLocalInstallation(environment = process.env, options = {}) {
  const completedStages = [];
  let activeStage = "inspect";
  const runStage = async (stage, operation) => {
    activeStage = stage;
    emitLocalUpdateProgress(options, stage, "started", completedStages);
    try {
      const result = await operation();
      completedStages.push(stage);
      emitLocalUpdateProgress(options, stage, "completed", completedStages);
      return result;
    } catch (error) {
      emitLocalUpdateProgress(options, stage, "failed", completedStages);
      throw error;
    }
  };
  let inspection;
  try {
    inspection = await runStage("inspect", async () => {
      const current = await inspectLocalUpdatePlan(environment, options);
      assertLocalUpdateRevision(options.expectedRevision, current.revision);
      return current;
    });
  } catch (error) {
    throw annotateLocalUpdateFailure(error, {
      stage: "inspect",
      completedStages,
      services: "not-needed",
    });
  }
  const configInspection = inspection.config;
  const databaseInspection = inspection.databases;
  const serviceInspection = inspection.services;
  notifySafely(options.onInspected, {
    config: configInspection,
    databases: databaseInspection,
    services: serviceInspection,
  });
  const stopServices = options.stopServices
    ?? (() => runCoreServiceAction("stop", environment));
  const startServices = options.startServices
    ?? (() => {
      recordTerminalIdentityBeforeServiceRestart(environment);
      return runCoreServiceAction("start", environment);
    });
  const waitForServices = options.waitForServices
    ?? (() => waitForCoreServices(environment));
  const databaseOptions = {
    ...options.databaseOptions,
    inspect: options.databaseOptions?.inspect ?? (() => databaseInspection),
  };
  if (serviceInspection.installed) {
    try {
      await runStage(
        "stop-services",
        () => stopCoreServices(stopServices, startServices, waitForServices),
      );
    } catch (error) {
      throw annotateLocalUpdateFailure(error, {
        stage: "stop-services",
        completedStages,
        services: error instanceof AggregateError ? "failed" : "restored",
      });
    }
  }

  let config;
  let databases;
  let obsoleteServices;
  let providerCatalogs;
  let updateError;
  let updateFailureStage;
  try {
    if ((serviceInspection.obsoleteServices?.length ?? 0) > 0) {
      obsoleteServices = await runStage("obsolete-services", () =>
        (options.removeObsoleteServices
          ?? (() => removeObsoleteServiceInstallations(environment)))());
    }
    await runStage("provider-files", () =>
      (options.updateProviderFiles
        ?? (() => backupAndMigrateProviderFiles(environment, { apply: true })))());
    providerCatalogs = await runStage("provider-catalogs", () =>
      (options.updateProviderCatalogs
        ?? (() => refreshManagedProviderCatalogsForUpdate(environment)))());
    await runStage("codex-settings", () =>
      (options.updateCodexSettings ?? (async () => {
        const result = await updateReasoningSummaryOnce(environment);
        if (result.changed) writeCliMessage("success", "首次更新已将 Codex 推理摘要设为关闭；后续更新保留用户选择。");
        return result;
      }))());
    config = await runStage("config", () =>
      (options.updateConfig
        ?? (() => updateGatewayConfiguration(environment)))());
    databases = await runStage("databases", () =>
      (options.updateDatabases
        ?? (() => updateDatabases(environment, databaseOptions)))());
    await runStage("validate-offline", () =>
      (options.validateOffline
        ?? (() => validateLocalInstallation(environment)))());
  } catch (error) {
    updateError = error;
    updateFailureStage = activeStage;
  }

  let startError;
  if (serviceInspection.installed) {
    try {
      await runStage("restore-services", async () => {
        startServices();
        await waitForServices();
      });
    } catch (error) {
      startError = error;
    }
  }
  if (updateError !== undefined && startError !== undefined) {
    throw annotateLocalUpdateFailure(new AggregateError(
      [updateError, startError],
      "本地更新失败，且核心服务未能恢复就绪",
      { cause: updateError },
    ), {
      stage: "restore-services",
      completedStages,
      services: "failed",
    });
  }
  if (updateError !== undefined) {
    throw annotateLocalUpdateFailure(updateError, {
      stage: updateFailureStage ?? activeStage,
      completedStages,
      services: serviceInspection.installed ? "restored" : "not-needed",
    });
  }
  if (startError !== undefined) {
    throw annotateLocalUpdateFailure(startError, {
      stage: "restore-services",
      completedStages,
      services: "failed",
    });
  }
  return {
    config,
    databases,
    ...(obsoleteServices === undefined ? {} : { obsoleteServices }),
    providerCatalogs,
    servicesRestored: serviceInspection.installed,
  };
}

export function getLocalUpdateFailure(error) {
  return error instanceof Error && error.localUpdateFailure
    ? error.localUpdateFailure
    : undefined;
}

export async function inspectLocalUpdatePlan(
  environment = process.env,
  options = {},
) {
  if (
    environment.CODEX_CONNECT_SERVICE_ROLE === "app-server"
    || environment.CODEX_CONNECT_SERVICE_ROLE === "gateway"
  ) {
    throw new Error("不能在运行中的 Codex 服务内执行更新；请在本机终端运行 codexc update");
  }
  const config = (options.inspectConfig
    ?? (() => inspectGatewayConfiguration(environment)))();
  const databases = (options.inspectDatabases
    ?? (() => inspectDatabaseUpdates(environment)))();
  const services = (options.inspectServices
    ?? (() => inspectCoreServiceInstallation(environment)))();
  const gatewayIsActive = options.gatewayIsActive ?? gatewayOwnerIsActive;
  if (!services.installed && await gatewayIsActive(config.configPath)) {
    throw new Error(
      "核心后台服务未安装，但检测到前台 Gateway 正在运行；"
      + "请在运行 codexc start 的终端按 Ctrl-C，确认退出后再重试 codexc update",
    );
  }
  const steps = [
    "inspect",
    ...(services.installed ? ["stop-services"] : []),
    ...((services.obsoleteServices?.length ?? 0) > 0 ? ["obsolete-services"] : []),
    "provider-files",
    "provider-catalogs",
    "codex-settings",
    "config",
    "databases",
    "validate-offline",
    ...(services.installed ? ["restore-services"] : []),
  ];
  const plan = {
    operation: "local-update",
    config,
    databases,
    services,
    requiresServiceInterruption:
      services.installed || (services.obsoleteServices?.length ?? 0) > 0,
    steps,
  };
  return {
    ...plan,
    revision: createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex"),
  };
}

function assertLocalUpdateRevision(expected, current) {
  if (expected === undefined) return;
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected)) {
    throw new Error("本地更新计划修订值无效");
  }
  if (expected !== current) {
    throw new Error("本地更新预检状态已变化，请重新生成更新计划");
  }
}

export async function refreshManagedProviderCatalogsForUpdate(
  environment = process.env,
  options = {},
) {
  const definitions = options.definitions ?? managedModelProviderDefinitions;
  const updateAdapters = options.updateAdapters ?? {
    deepseek: (targetEnvironment, adapterOptions) =>
      refreshDeepseekCatalogForUpdate(targetEnvironment, adapterOptions),
    "opencode-go": (targetEnvironment, adapterOptions) =>
      refreshOpencodeGoCatalogForUpdate(targetEnvironment, adapterOptions),
  };
  const catalogDownloaders = options.catalogDownloaders ?? {
    "deepseek-official": () => downloadDeepseekCatalog(globalThis.fetch),
  };
  const downloads = new Map();
  const results = {};
  for (const definition of definitions) {
    const capabilities = assertManagedModelProviderCapabilities(definition);
    const adapter = capabilities.catalogUpdateAdapter;
    if (adapter === "none") {
      results[definition.id] = { status: "not-applicable" };
      continue;
    }
    const update = updateAdapters[adapter];
    if (typeof update !== "function") {
      throw new Error(`未知受管 Provider 目录更新适配器：${adapter}`);
    }
    const source = capabilities.catalogSource;
    const downloader = catalogDownloaders[source];
    if (typeof downloader !== "function") {
      throw new Error(`未知受管 Provider 模型目录来源：${source}`);
    }
    const downloadCatalog = () => {
      let pending = downloads.get(source);
      if (!pending) {
        pending = Promise.resolve().then(() => downloader());
        downloads.set(source, pending);
      }
      return pending;
    };
    const result = await update(environment, { definition, downloadCatalog });
    results[definition.id] = result;
    options.onUpdated?.({ definition, result });
  }
  return results;
}

function removeObsoleteGatewayConfig(document) {
  const removedPaths = [];
  if (Object.hasOwn(document, "network")) {
    delete document.network;
    removedPaths.push("network");
  }
  // 旧 Schema 会由运行中的 Gateway 补入空数组；非空注册表仍交给严格校验拒绝。
  if (Array.isArray(document.api_providers) && document.api_providers.length === 0) {
    delete document.api_providers;
    removedPaths.push("api_providers");
  }
  if (Object.hasOwn(document, "vision")) {
    delete document.vision;
    removedPaths.push("vision");
  }
  const display = document.display;
  if (display !== null && typeof display === "object" && !Array.isArray(display)) {
    for (const key of ["price_currency", "price_currency_by_provider"]) {
      if (Object.hasOwn(display, key)) {
        delete display[key];
        removedPaths.push(`display.${key}`);
      }
    }
  }
  const metrics = document.metrics;
  if (metrics !== null && typeof metrics === "object" && !Array.isArray(metrics)) {
    for (const key of ["sync", "center", "view"]) {
      if (Object.hasOwn(metrics, key)) {
        delete metrics[key];
        removedPaths.push(`metrics.${key}`);
      }
    }
  }
  return removedPaths;
}

function planProxyMigration(document, environment) {
  if (!Object.hasOwn(document, "network")) return undefined;
  const legacy = document.network;
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)
    || Object.keys(legacy).some((field) => !codexProxyFields.includes(field))) {
    throw new Error("旧 network 代理配置无效，无法迁移");
  }
  const snapshot = readCodexProxySnapshot(environment);
  const changes = {};
  for (const [field, value] of Object.entries(legacy)) {
    if (typeof value !== "string") throw new Error("旧 network 代理值必须是文本");
    if (value.trim() === "") continue;
    const current = snapshot.settings[field];
    if (current !== undefined && current !== value.trim()) {
      throw new Error(`旧 network.${field} 与 Codex .env 冲突，请统一后重试；未覆盖任何代理值`);
    }
    if (current === undefined) changes[field] = value.trim();
  }
  const nextContent = renderCodexProxySettings(snapshot, changes);
  return { ...snapshot, nextContent, changed: nextContent !== (snapshot.content ?? "") };
}

export function inspectCoreServiceInstallation(
  environment = process.env,
  platform = process.platform,
) {
  const { definitionsDirectory, identifierKey } = serviceDefinitionContext(
    environment,
    platform,
  );
  const paths = serviceDefinitionsForTarget("all").flatMap((definition) => {
    const definitionPath = join(
      definitionsDirectory,
      platform === "darwin"
        ? `${definition[identifierKey]}.plist`
        : platform === "win32"
          ? `${definition.target}.json`
          : definition[identifierKey],
    );
    return platform === "win32"
      ? [definitionPath, join(definitionsDirectory, `${definition.target}.vbs`)]
      : [definitionPath];
  });
  const existingPaths = paths.filter((path) => existsSync(path));
  const obsoleteServices = inspectObsoleteServiceInstallations(
    environment,
    platform,
  );
  if (existingPaths.length === 0) {
    return obsoleteServices.length === 0
      ? { installed: false }
      : { installed: false, obsoleteServices };
  }
  if (existingPaths.length !== paths.length) {
    throw new Error("核心后台服务安装不完整；请先运行 codexc service install");
  }
  return obsoleteServices.length === 0
    ? { installed: true }
    : { installed: true, obsoleteServices };
}

export function inspectObsoleteServiceInstallations(
  environment = process.env,
  platform = process.platform,
) {
  const context = serviceDefinitionContext(environment, platform);
  return obsoleteServiceDefinitions
    .filter((definition) => obsoleteServicePaths(definition, context, platform)
      .some((path) => existsSync(path)))
    .map((definition) => definition.id);
}

export function removeObsoleteServiceInstallations(
  environment = process.env,
  options = {},
) {
  const platform = options.platform ?? process.platform;
  const context = serviceDefinitionContext(environment, platform);
  const installed = options.installed
    ?? inspectObsoleteServiceInstallations(environment, platform);
  const definitions = obsoleteServiceDefinitions.filter((definition) =>
    installed.includes(definition.id));
  if (definitions.length === 0) return { changed: false, removedServices: [] };

  for (const definition of definitions) {
    removeObsoleteService(definition, context, environment, platform, options);
  }
  return {
    changed: true,
    removedServices: definitions.map((definition) => definition.id),
  };
}

function serviceDefinitionContext(environment, platform) {
  const home = platform === "win32" ? environment.USERPROFILE : environment.HOME;
  if (!home) {
    throw new Error(`无法检查后台服务安装状态：${platform === "win32" ? "USERPROFILE" : "HOME"} 未设置`);
  }
  if (platform === "linux") {
    const configHome = environment.XDG_CONFIG_HOME?.trim() || join(home, ".config");
    return {
      definitionsDirectory: join(configHome, "systemd", "user"),
      identifierKey: "systemd",
    };
  }
  if (platform === "darwin") {
    return {
      definitionsDirectory: join(home, "Library", "LaunchAgents"),
      identifierKey: "launchd",
    };
  }
  if (platform === "win32") {
    return {
      definitionsDirectory: join(requireUserConfig(environment).dataDir, "services"),
      identifierKey: "windows",
    };
  }
  throw new Error("codexc update 当前支持 macOS launchd、Linux systemd 与 Windows 计划任务");
}

function obsoleteServicePaths(definition, context, platform) {
  if (platform === "linux") {
    return [join(context.definitionsDirectory, definition.systemd)];
  }
  if (platform === "darwin") {
    return [join(context.definitionsDirectory, `${definition.launchd}.plist`)];
  }
  return [
    join(context.definitionsDirectory, `${definition.target}.json`),
    join(context.definitionsDirectory, `${definition.target}.vbs`),
  ];
}

function removeObsoleteService(definition, context, environment, platform, options) {
  if (platform === "linux") {
    runObsoleteServiceCommand(
      environment.SYSTEMCTL_BINARY || "systemctl",
      ["--user", "disable", "--now", definition.systemd],
      environment,
      options,
      definition.id,
    );
    removeObsoleteServiceFiles(definition, context, platform);
    runObsoleteServiceCommand(
      environment.SYSTEMCTL_BINARY || "systemctl",
      ["--user", "daemon-reload"],
      environment,
      options,
      definition.id,
    );
    return;
  }
  if (platform === "darwin") {
    const launchctl = environment.LAUNCHCTL_BINARY || "launchctl";
    const uid = options.uid
      ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    const domainTarget = `gui/${uid}/${definition.launchd}`;
    const inspection = spawnObsoleteServiceCommand(
      launchctl,
      ["print", domainTarget],
      environment,
      options,
    );
    if (inspection.status === 0) {
      runObsoleteServiceCommand(
        launchctl,
        ["bootout", domainTarget],
        environment,
        options,
        definition.id,
      );
    }
    removeObsoleteServiceFiles(definition, context, platform);
    return;
  }

  const pwsh = options.pwshExecutable ?? resolveExecutable("pwsh.exe", environment);
  const taskScript = join(packageDir, "scripts", "windows-scheduled-task.ps1");
  for (const action of ["stop", "unregister"]) {
    runObsoleteServiceCommand(
      pwsh,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        taskScript,
        "-Action",
        action,
        "-TaskName",
        definition.windows,
      ],
      environment,
      options,
      definition.id,
    );
  }
  removeObsoleteServiceFiles(definition, context, platform);
}

function removeObsoleteServiceFiles(definition, context, platform) {
  for (const path of obsoleteServicePaths(definition, context, platform)) {
    if (existsSync(path)) unlinkSync(path);
  }
}

function spawnObsoleteServiceCommand(command, args, environment, options) {
  const runCommand = options.spawnCommand ?? spawnSync;
  const result = runCommand(command, args, {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function runObsoleteServiceCommand(
  command,
  args,
  environment,
  options,
  serviceId,
) {
  const result = spawnObsoleteServiceCommand(command, args, environment, options);
  if (result.status === 0) return;
  const detail = String(result.stderr ?? result.stdout ?? "")
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.trim();
  throw new Error(
    `旧后台服务移除失败：${serviceId}${detail ? `（${detail}）` : ""}`,
  );
}

export function inspectDatabaseUpdates(environment = process.env, options = {}) {
  const state = (options.inspectState ?? (() => inspectStateDatabase(environment)))();
  const metrics = (options.inspectMetrics ?? (() => inspectMetricsDatabase(environment)))();
  const sessionDisplayCache = options.inspectSessionDisplayCache
    ? options.inspectSessionDisplayCache()
    : undefined;
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
  if (
    state.scheduledTasks?.exists
    && !state.scheduledTasks.compatible
    && !state.scheduledTasks.updateable
  ) {
    failures.push(
      `计划任务数据库 Schema ${state.scheduledTasks.schemaVersion ?? "unknown"} 无法直接更新到 ${state.scheduledTasks.targetSchemaVersion}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`数据库版本预检失败：${failures.join("；")}`);
  }
  (options.validateMetrics
    ?? (() => validateMetricsDatabaseStructure(environment, { allowUpgradeable: true })))();
  return sessionDisplayCache === undefined
    ? { state, metrics }
    : { state, metrics, sessionDisplayCache };
}

export function updateDatabases(environment = process.env, options = {}) {
  const updateState = options.updateState
    ?? (() => upgradeStateDatabase(environment, { allowMissing: true }));
  const updateMetrics = options.updateMetrics
    ?? (() => upgradeMetricsDatabase(environment));
  const updateSessionDisplayCache = options.updateSessionDisplayCache;
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
  if (updateSessionDisplayCache) {
    try {
      results["session-display-cache"] = updateSessionDisplayCache();
      onUpdated("session-display-cache", results["session-display-cache"]);
    } catch (error) {
      failures.push({ name: "session-display-cache", error });
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
  const inspectSupervisor = options.inspectSupervisor;
  const inspectSupervisorState = options.inspectSupervisorState
    ?? inspectAppServerSupervisorState;
  const socketHealthy = options.socketHealthy ?? appServerSocketAcceptsWebSocket;
  const gatewayHealthy = options.gatewayHealthy ?? gatewayOwnerIsReady;
  const deadline = now() + timeoutMs;
  let healthySince;
  while (now() < deadline) {
    let appServerReady = true;
    if (requiresAppServer) {
      let supervisor;
      let primarySocketHealthy = false;
      let protocolMismatch = false;
      try {
        if (inspectSupervisor) {
          supervisor = await inspectSupervisor(descriptor.primarySocketPath);
        } else {
          const state = await inspectSupervisorState(descriptor.primarySocketPath);
          protocolMismatch = state.status === "incompatible";
          supervisor = state.status === "ready" ? state.topology : undefined;
        }
        primarySocketHealthy = await socketHealthy(descriptor.primarySocketPath);
      } catch {
        // Windows IPC descriptors can be briefly absent or mid-write while the service starts.
      }
      if (protocolMismatch) {
        throw new Error(
          "App Server 监管协议版本不匹配；请运行 codexc service restart all 后重试",
        );
      }
      const topologyMatches = sameAppServerTopology(supervisor, descriptor.topology);
      // 空闲释放后的主 App Server 是合法状态，服务仍视为就绪；首次使用会按需启动。
      const primaryReleased = supervisor?.releasedProviders.includes(
        descriptor.topology.primaryProvider,
      ) === true;
      appServerReady = topologyMatches && (primarySocketHealthy || primaryReleased);
    }
    let gatewayReady = !requiresGateway;
    if (requiresGateway) {
      try {
        gatewayReady = await gatewayHealthy(configPath);
      } catch {
        // Treat a transient Windows owner descriptor rewrite as not ready yet.
      }
    }
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

/**
 * 本地更新真正重启核心服务之前，按运行更新命令的终端补入缺失的 `[codex].terminal_identity`，
 * 使记录下来的值在下一次 App Server 启动时立即生效。已配置或探测不到终端时不做修改；补入失败
 * 只提示并继续，不阻塞更新恢复服务。
 */
function recordTerminalIdentityBeforeServiceRestart(environment) {
  let terminalIdentity;
  try {
    terminalIdentity = applyTerminalIdentityFromEnvironment(environment);
  } catch (error) {
    writeCliMessage(
      "failure",
      `未写入模型上游终端标识，更新继续：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (terminalIdentity === null) return;
  writeCliMessage("note", `已按当前终端记录模型上游终端标识：${terminalIdentity}`);
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
  if (name === "session-display-cache") return "会话展示缓存";
  return "核心服务恢复";
}

function emitLocalUpdateProgress(options, stage, status, completedStages) {
  notifySafely(options.onProgress, {
    operation: "local-update",
    stage,
    status,
    completedStages: [...completedStages],
  });
}

function notifySafely(listener, value) {
  if (typeof listener !== "function") return;
  try {
    listener(value);
  } catch {
    // 观察者和展示适配器不得中断本地更新事务。
  }
}

function annotateLocalUpdateFailure(error, details) {
  const target = error instanceof Error ? error : new Error(String(error));
  if (target.localUpdateFailure) return target;
  const mutationStages = [
    "obsolete-services",
    "provider-files",
    "provider-catalogs",
    "codex-settings",
    "config",
    "databases",
    "validate-offline",
  ];
  const completedMutationStages = mutationStages.filter((stage) =>
    details.completedStages.includes(stage));
  const completedAllRegularMutationStages = mutationStages
    .filter((stage) => stage !== "obsolete-services")
    .every((stage) => details.completedStages.includes(stage));
  const changes = completedMutationStages.length === 0
    ? "unchanged"
    : completedAllRegularMutationStages
      ? "applied"
      : "partial";
  Object.defineProperty(target, "localUpdateFailure", {
    configurable: false,
    enumerable: true,
    value: {
      operation: "local-update",
      code: "local-update-failed",
      stage: details.stage,
      completedStages: [...details.completedStages],
      recovery: { changes, services: details.services },
      recommendation: details.services === "failed"
        ? "运行 codexc service status all 检查后，再执行 codexc service start all"
        : "修复失败原因后重新运行 codexc update",
    },
    writable: false,
  });
  return target;
}

function printDatabaseResult(name, result) {
  const labels = {
    state: "状态数据库",
    metrics: "指标数据库",
    "session-display-cache": "会话展示缓存",
  };
  const label = labels[name] ?? name;
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

function printInspection({ state, metrics, sessionDisplayCache }) {
  writeCliMessage("note", "数据库版本预检通过。");
  console.log(`状态数据库：${versionTransition(
    state.exists ? state.schemaVersion : null,
    state.targetSchemaVersion,
  )}`);
  console.log(`指标数据库：${versionTransition(
    metrics.exists ? metrics.schemaVersion : null,
    modelRequestMetricsSchemaVersion,
  )}`);
  if (sessionDisplayCache) {
    console.log(`会话展示缓存：${versionTransition(
      sessionDisplayCache.exists ? sessionDisplayCache.schemaVersion : null,
      sessionDisplayCache.targetSchemaVersion,
    )}`);
  }
}

function versionTransition(current, target) {
  if (current === null) return `尚未创建 → Schema ${target}`;
  if (current === target) return `Schema ${target}（已兼容）`;
  return `Schema ${current} → Schema ${target}`;
}

function resolveSessionDisplayCachePath(environment) {
  const { configPath, dataDir } = requireUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const storage = isRecord(document.storage) ? document.storage : {};
  const databasePath = resolveConfiguredPath(
    typeof storage.database_path === "string" ? storage.database_path : undefined,
    dataDir,
    "data/gateway.sqlite3",
  );
  return join(dirname(databasePath), "session-display-cache.sqlite3");
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
        if ((services.obsoleteServices?.length ?? 0) > 0) {
          console.log(`待移除旧后台服务：${services.obsoleteServices.join("、")}`);
        }
        if (!services.installed) {
          writeCliMessage(
            "note",
            (services.obsoleteServices?.length ?? 0) > 0
              ? "核心后台服务未安装；本次会移除旧后台服务，并离线更新配置与数据库。"
              : "核心后台服务未安装，本次只离线更新配置与数据库。",
          );
        }
      },
      removeObsoleteServices: () => {
        const result = removeObsoleteServiceInstallations(process.env);
        if (result.changed) {
          writeCliMessage(
            "success",
            `旧后台服务已移除：${result.removedServices.join("、")}。`,
          );
        }
        return result;
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
      updateProviderCatalogs: () => refreshManagedProviderCatalogsForUpdate(
        process.env,
        {
          onUpdated: ({ definition, result }) => {
            if (result.status !== "updated") return;
            writeCliMessage(
              "success",
              `${definition.displayName} 官方模型目录已更新（${result.modelCount} 个模型）。`,
            );
            if (definition.id === "deepseek") {
              console.log(result.modelMigrated
                ? `已切换旧默认模型：deepseek → ${result.selectedModel}`
                : `当前默认选择保持：${result.selectedModel}`);
              return;
            }
            if (definition.id === opencodeGoProviderDefinition.id) {
              if (result.migratedProviders.length > 0) {
                console.log(
                  `已切换旧默认模型：${result.migratedProviders.join("、")} → ${opencodeGoProviderDefinition.defaultModel}`,
                );
              } else {
                console.log("OpenCode Go 当前默认选择均已保留。");
              }
            }
          },
        },
      ),
      inspectDatabases: () => inspectDatabaseUpdates(process.env, {
        inspectSessionDisplayCache: () => inspectSessionDisplayCache(process.env),
      }),
      databaseOptions: {
        inspect: () => inspectDatabaseUpdates(process.env, {
          inspectSessionDisplayCache: () => inspectSessionDisplayCache(process.env),
        }),
        onInspected: printInspection,
        onUpdated: printDatabaseResult,
        updateSessionDisplayCache: () => updateSessionDisplayCache(process.env),
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
