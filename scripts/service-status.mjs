import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import {
  parseServiceTarget,
  serviceDefinitionsForTarget,
} from "../runtime/service-targets.mjs";
import { appServerSocketAcceptsWebSocket } from "../runtime/app-server-supervisor.mjs";
import { gatewayOwnerIsReady } from "../runtime/gateway-owner.mjs";
import { runtimeConfig } from "./runtime-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { packageDir } from "./package-path.mjs";

export function inspectManagedServiceStatus({
  environment = process.env,
  platform = process.platform,
  run = spawnSync,
  target = "all",
  userId = typeof process.getuid === "function" ? process.getuid() : undefined,
} = {}) {
  const resolvedTarget = parseServiceTarget(target);
  const definitions = serviceDefinitionsForTarget(resolvedTarget);
  let services;
  let servicePlatform;
  if (platform === "linux") {
    servicePlatform = "systemd";
    services = definitions.map((definition) =>
      inspectSystemdService(definition, environment, run));
  } else if (platform === "darwin") {
    if (!Number.isSafeInteger(userId) || userId < 0) {
      throw new Error("无法确定当前用户 ID，不能查询 launchd 服务状态");
    }
    servicePlatform = "launchd";
    services = definitions.map((definition) =>
      inspectLaunchdService(definition, environment, run, userId));
  } else if (platform === "win32") {
    return inspectWindowsServices(resolvedTarget, environment, run);
  } else {
    throw new Error("codexc service status --json 当前支持 macOS launchd、Linux systemd 与 Windows 计划任务");
  }
  return {
    platform: servicePlatform,
    target: resolvedTarget,
    healthy: services.every((service) => service.running),
    services,
  };
}

export async function inspectManagedServiceStatusAsync({
  environment = process.env,
  platform = process.platform,
  run = runServiceCommand,
  target = "all",
  userId = typeof process.getuid === "function" ? process.getuid() : undefined,
} = {}) {
  const resolvedTarget = parseServiceTarget(target);
  const definitions = serviceDefinitionsForTarget(resolvedTarget);
  let services;
  let servicePlatform;
  if (platform === "linux") {
    servicePlatform = "systemd";
    services = await Promise.all(definitions.map(async (definition) =>
      parseSystemdServiceResult(definition, await run(
        environment.SYSTEMCTL_BINARY?.trim() || "systemctl",
        ["--user", "show", definition.systemd, "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=MainPID", "--no-pager"],
        { encoding: "utf8", env: environment },
      ))));
  } else if (platform === "darwin") {
    if (!Number.isSafeInteger(userId) || userId < 0) {
      throw new Error("无法确定当前用户 ID，不能查询 launchd 服务状态");
    }
    servicePlatform = "launchd";
    services = await Promise.all(definitions.map(async (definition) =>
      parseLaunchdServiceResult(definition, await run(
        environment.LAUNCHCTL_BINARY?.trim() || "launchctl",
        ["print", `gui/${userId}/${definition.launchd}`],
        { encoding: "utf8", env: environment },
      ))));
  } else if (platform === "win32") {
    const dataDir = environment.CODEX_CONNECT_HOME?.trim();
    if (!dataDir) {
      throw new Error("Windows 后台服务状态查询需要 CODEX_CONNECT_HOME");
    }
    const result = await run(process.execPath, [
      join(packageDir, "scripts", "windows-service-control.mjs"),
      "status",
      resolvedTarget,
      "--json",
      "--definitions",
      join(dataDir, "services"),
    ], { encoding: "utf8", env: environment, windowsHide: true });
    services = parseWindowsServiceResult(result);
    servicePlatform = "windows";
  } else {
    throw new Error("codexc service status --json 当前支持 macOS launchd、Linux systemd 与 Windows 计划任务");
  }
  return {
    platform: servicePlatform,
    target: resolvedTarget,
    healthy: services.every((service) => service.running),
    services,
  };
}

const runServiceCommand = async (command, args, options) => {
  const result = await promisify(execFile)(command, args, {
    ...options,
    timeout: 3_000,
    maxBuffer: 1_024 * 1_024,
  }).then(({ stdout, stderr }) => ({ status: 0, stdout, stderr }))
    .catch((error) => ({
      error: typeof error?.code === "number" ? undefined : error,
      status: typeof error?.code === "number" ? error.code : null,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
    }));
  return result;
};

function parseWindowsServiceResult(result) {
  if (result.error) throw result.error;
  const json = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .findLast((line) => line.trim().startsWith("{"));
  if (!json || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`无法查询 Windows 计划任务：${safeProcessError(result)}`);
  }
  try {
    return JSON.parse(json).services;
  } catch (error) {
    throw new Error("Windows 计划任务状态响应无效", { cause: error });
  }
}

/**
 * Add process and protocol reachability checks to the platform service status.
 * The existing synchronous inspector remains available for callers that only
 * need supervisor state; this async view is used by user-facing diagnostics.
 */
export async function inspectManagedServiceHealth(options = {}) {
  const status = inspectManagedServiceStatus(options);
  if (status.platform !== "windows") return status;
  let configDocument;
  const environment = options.environment ?? process.env;
  const paths = runtimeConfig(environment);
  try {
    configDocument = readGatewayConfig(paths.configPath);
  } catch {
    configDocument = undefined;
  }
  const services = await Promise.all(status.services.map(async (service) => {
    const processAlive = service.pid !== null;
    let rpcReachable = service.target === "gateway" || service.target === "app-server"
      ? false
      : null;
    if (service.running && processAlive && configDocument) {
      try {
        if (service.target === "gateway") {
          rpcReachable = await gatewayOwnerIsReady(paths.configPath);
        } else if (service.target === "app-server") {
          rpcReachable = await appServerSocketAcceptsWebSocket(
            resolvePrimaryAppServerSocketPath(configDocument, paths.dataDir),
          );
        }
      } catch {
        rpcReachable = false;
      }
    }
    return {
      ...service,
      processAlive,
      rpcReachable,
    };
  }));
  return {
    ...status,
    healthy: services.every((service) => {
      if (!service.running) return false;
      return service.rpcReachable === null || service.rpcReachable === true;
    }),
    services,
  };
}

function inspectWindowsServices(target, environment, run) {
  const dataDir = environment.CODEX_CONNECT_HOME?.trim();
  if (!dataDir) {
    throw new Error("Windows 后台服务状态查询需要 CODEX_CONNECT_HOME");
  }
  const result = run(process.execPath, [
    join(packageDir, "scripts", "windows-service-control.mjs"),
    "status",
    target,
    "--json",
    "--definitions",
    join(dataDir, "services"),
  ], {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const json = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .findLast((line) => line.trim().startsWith("{"));
  if (!json || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`无法查询 Windows 计划任务：${safeProcessError(result)}`);
  }
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error("Windows 计划任务状态响应无效", { cause: error });
  }
}

function inspectSystemdService(definition, environment, run) {
  const executable = environment.SYSTEMCTL_BINARY?.trim() || "systemctl";
  const result = run(executable, [
    "--user",
    "show",
    definition.systemd,
    "--property=LoadState",
    "--property=ActiveState",
    "--property=SubState",
    "--property=MainPID",
    "--no-pager",
  ], {
    encoding: "utf8",
    env: environment,
  });
  return parseSystemdServiceResult(definition, result);
}

function parseSystemdServiceResult(definition, result) {
  if (result.error) {
    throw new Error(`无法查询 systemd 服务 ${definition.systemd}：${result.error.message}`);
  }
  const properties = keyValueLines(result.stdout);
  if (result.status !== 0 && properties.LoadState !== "not-found") {
    throw new Error(
      `无法查询 systemd 服务 ${definition.systemd}：${safeProcessError(result)}`,
    );
  }
  const loadState = properties.LoadState ?? "unknown";
  const activeState = properties.ActiveState ?? "unknown";
  const subState = properties.SubState ?? "unknown";
  const loaded = loadState !== "not-found" && loadState !== "unknown";
  return {
    target: definition.target,
    name: definition.displayName,
    identifier: definition.systemd,
    loaded,
    running: loaded && activeState === "active",
    state: loaded ? `${activeState}/${subState}` : loadState,
    pid: positiveIntegerOrNull(properties.MainPID),
  };
}

function inspectLaunchdService(definition, environment, run, userId) {
  const executable = environment.LAUNCHCTL_BINARY?.trim() || "launchctl";
  const result = run(
    executable,
    ["print", `gui/${userId}/${definition.launchd}`],
    { encoding: "utf8", env: environment },
  );
  return parseLaunchdServiceResult(definition, result);
}

function parseLaunchdServiceResult(definition, result) {
  if (result.error) {
    throw new Error(`无法查询 launchd 服务 ${definition.launchd}：${result.error.message}`);
  }
  if (result.status === 113) {
    return {
      target: definition.target,
      name: definition.displayName,
      identifier: definition.launchd,
      loaded: false,
      running: false,
      state: "missing",
      pid: null,
    };
  }
  if (result.status !== 0) {
    throw new Error(
      `无法查询 launchd 服务 ${definition.launchd}：${safeProcessError(result)}`,
    );
  }
  const state = launchdValue(result.stdout, "state") ?? "loaded";
  return {
    target: definition.target,
    name: definition.displayName,
    identifier: definition.launchd,
    loaded: true,
    running: state === "running",
    state,
    pid: positiveIntegerOrNull(launchdValue(result.stdout, "pid")),
  };
}

function keyValueLines(value) {
  const result = {};
  for (const line of String(value ?? "").split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function launchdValue(value, key) {
  const pattern = new RegExp(`^\\s*${key.replaceAll(" ", "\\s+")}\\s*=\\s*(.+?)\\s*$`, "mu");
  return pattern.exec(String(value ?? ""))?.[1];
}

function positiveIntegerOrNull(value) {
  if (!/^[0-9]+$/u.test(value ?? "")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeProcessError(result) {
  const message = String(result.stderr ?? "").trim().split(/\r?\n/u, 1)[0];
  return message || `exit=${result.status ?? 1}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("用法：codexc service status [gateway|app-server|webui|center|all] [--json]");
    }
    const result = await inspectManagedServiceHealth({ target: process.argv[2] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.healthy) process.exitCode = 1;
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
