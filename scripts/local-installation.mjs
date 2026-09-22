import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { appServerSocketAcceptsWebSocket, inspectAppServerSupervisorState, sameAppServerTopology } from "../runtime/app-server-supervisor.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { gatewayOwnerIsReady } from "../runtime/gateway-owner.mjs";
import { serviceDefinitionsForTarget } from "../runtime/service-targets.mjs";
import { loadConfigDocument } from "../dist/config/index.js";
import { sessionDisplayCacheSchemaVersion } from "../dist/storage/index.js";
import { validateMetricsDatabaseStructure } from "./metrics-database-access.mjs";
import { validateStateDatabaseStructure } from "./state-database.mjs";
import { requireUserConfig, resolveConfiguredPath } from "./runtime-config.mjs";

const defaultCoreServiceReadinessTimeoutMs = 150_000;

export function inspectGatewayConfiguration(environment = process.env) {
  const { configPath } = requireUserConfig(environment);
  loadConfigDocument(readFileSync(configPath, "utf8"), dirname(configPath), {
    environment,
    detectSystemProxy: true,
  });
  return { configPath };
}

export function inspectDatabaseUpdates(environment = process.env) {
  const state = validateStateDatabaseStructure(environment);
  const metrics = validateMetricsDatabaseStructure(environment);
  const sessionDisplayCache = inspectSessionDisplayCache(environment);
  if (!sessionDisplayCache.compatible) {
    throw new Error("会话展示缓存版本不兼容；请停止服务并备份后重建缓存");
  }
  return { required: false, state, metrics, sessionDisplayCache };
}

// Stable candidate-owned entry point. Future Schema changes add their explicit
// backup, migration and target validation here; this baseline never writes data.
export function applyDatabaseUpdates(environment = process.env) {
  inspectDatabaseUpdates(environment);
}

export function inspectSessionDisplayCache(environment = process.env) {
  const databasePath = resolveSessionDisplayCachePath(environment);
  if (!existsSync(databasePath)) {
    return {
      compatible: true,
      databasePath,
      exists: false,
      schemaVersion: null,
      targetSchemaVersion: sessionDisplayCacheSchemaVersion,
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
    };
  } finally {
    database.close();
  }
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
  if (existingPaths.length === 0) return { installed: false };
  if (existingPaths.length !== paths.length) {
    throw new Error("核心后台服务安装不完整；请先运行 codexc service install");
  }
  return { installed: true };
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

function isRecord(value) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && !(value instanceof Date);
}
