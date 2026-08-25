import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  parseServiceTarget,
  serviceDefinitionsForTarget,
} from "../runtime/service-targets.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";

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
  } else {
    throw new Error("codexc service status --json 当前支持 macOS launchd 与 Linux systemd");
  }
  return {
    platform: servicePlatform,
    target: resolvedTarget,
    healthy: services.every((service) => service.running),
    services,
  };
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
    const result = inspectManagedServiceStatus({ target: process.argv[2] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.healthy) process.exitCode = 1;
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
