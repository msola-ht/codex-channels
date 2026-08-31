import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { resolveExecutable } from "../runtime/executable.mjs";
import {
  appServerSocketAcceptsWebSocket,
  appServerSupervisorSocketPath,
  inspectAppServerSupervisorState,
} from "../runtime/app-server-supervisor.mjs";
import {
  createPrivateIpcConnection,
  privateIpcEndpointExists,
} from "../runtime/private-ipc.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import {
  parseServiceTarget,
  serviceDefinitions,
  serviceDefinitionsForTarget,
} from "../runtime/service-targets.mjs";
import { packageDir } from "./package-path.mjs";

const definitionLimitBytes = 64 * 1024;
const hostStartTimeoutMs = 15_000;
const hostStopTimeoutMs = 15_000;
const pollIntervalMs = 100;

export function windowsServiceDefinitionsDirectory(environment = process.env) {
  const dataDir = stringValue(environment.CODEX_CONNECT_HOME);
  if (!dataDir) {
    throw new Error("Windows 后台服务控制需要 CODEX_CONNECT_HOME");
  }
  return join(resolve(dataDir), "services");
}

export async function controlWindowsServices({
  action,
  target = action === "restart" || action === "logs" ? "gateway" : "all",
  definitionsDirectory = windowsServiceDefinitionsDirectory(),
  environment = process.env,
  follow = false,
  lines = 100,
  json = false,
} = {}) {
  if (process.platform !== "win32") {
    throw new Error("Windows 计划任务控制器只支持 Windows");
  }
  if (action === "preflight") {
    preflight(environment);
    return;
  }
  if (action === "install") {
    preflight(environment);
    for (const definition of serviceDefinitions) {
      const file = definitionPath(definitionsDirectory, definition.target);
      const value = readDefinition(file);
      runTaskPrimitive("register", definition.windows, environment, file, value.pwshBinary);
    }
    await startDefinitions("all", definitionsDirectory, environment);
    writeCliMessage("note", "Codex App Server 与 Gateway Windows 计划任务已安装并启动，正在确认就绪状态。");
    writeCliMessage("note", "WebUI 与指标中心计划任务已生成，可按需单独启动。");
    return;
  }
  if (action === "uninstall") {
    for (const definition of [
      ...serviceDefinitionsForTarget("all", "stop"),
      ...serviceDefinitions.filter((candidate) => !candidate.core),
    ]) {
      await stopDefinition(definition, definitionsDirectory, environment);
      runTaskPrimitive("unregister", definition.windows, environment);
      const file = definitionPath(definitionsDirectory, definition.target);
      if (existsSync(file)) unlinkSync(file);
    }
    writeCliMessage("success", "Codex App Server、Gateway、WebUI 与指标中心 Windows 计划任务已卸载。");
    writeCliMessage("note", "用户配置与运行数据保留在 CODEX_CONNECT_HOME。");
    return;
  }
  const parsedTarget = parseServiceTarget(target);
  if (action === "start") {
    await startDefinitions(parsedTarget, definitionsDirectory, environment);
    printLifecycleResult("start", parsedTarget);
    return;
  }
  if (action === "stop") {
    for (const definition of serviceDefinitionsForTarget(parsedTarget, "stop")) {
      await stopDefinition(definition, definitionsDirectory, environment);
    }
    printLifecycleResult("stop", parsedTarget);
    return;
  }
  if (action === "restart") {
    for (const definition of serviceDefinitionsForTarget(parsedTarget, "stop")) {
      await stopDefinition(definition, definitionsDirectory, environment);
    }
    await startDefinitions(parsedTarget, definitionsDirectory, environment);
    printLifecycleResult("restart", parsedTarget);
    return;
  }
  if (action === "reload") {
    const definition = readDefinition(definitionPath(definitionsDirectory, "gateway"));
    const result = await requestHost(definition.controlPath, { action: "reload" });
    if (result?.version !== 1 || result.ok !== true) {
      throw new Error("Gateway 尚未运行或无法接收重新加载请求，请先执行 codexc service start gateway");
    }
    writeCliMessage("success", "已通知 Gateway 重新读取配置；App Server 配置变化仍需重新安装服务。");
    return;
  }
  if (action === "status") {
    const status = await inspectWindowsServiceStatus({
      target: parsedTarget,
      definitionsDirectory,
      environment,
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    } else {
      for (const service of status.services) {
        const pid = service.pid ? ` pid=${service.pid}` : "";
        console.log(`${service.name}: ${service.state}${pid}`);
      }
    }
    if (!status.healthy) process.exitCode = 1;
    return status;
  }
  if (action === "logs") {
    showLogs(parsedTarget, definitionsDirectory, environment, { follow, lines });
    return;
  }
  throw new Error(`不支持的 Windows 服务操作：${String(action)}`);
}

export async function inspectWindowsServiceStatus({
  target = "all",
  definitionsDirectory = windowsServiceDefinitionsDirectory(),
  environment = process.env,
} = {}) {
  const parsedTarget = parseServiceTarget(target);
  const services = [];
  for (const service of serviceDefinitionsForTarget(parsedTarget)) {
    const task = queryTask(service.windows, environment);
    const file = definitionPath(definitionsDirectory, service.target);
    let host;
    if (existsSync(file)) {
      const definition = readDefinition(file);
      host = await inspectHost(definition.controlPath);
    }
    const running = task.exists && host?.version === 1 && host.running === true;
    services.push({
      target: service.target,
      name: service.displayName,
      identifier: service.windows,
      loaded: task.exists,
      running,
      state: task.exists
        ? running ? "running" : String(task.state ?? "unknown").toLowerCase()
        : "missing",
      pid: running && Number.isSafeInteger(host.childPid) ? host.childPid : null,
    });
  }
  return {
    platform: "windows",
    target: parsedTarget,
    healthy: services.every((service) => service.running),
    services,
  };
}

async function startDefinitions(target, definitionsDirectory, environment) {
  for (const service of serviceDefinitionsForTarget(target, "start")) {
    const definition = readDefinition(definitionPath(definitionsDirectory, service.target));
    const host = await inspectHost(definition.controlPath);
    if (host?.version === 1 && host.running === true) {
      if (service.target === "app-server") await waitForAppServer(definition.socketPath);
      continue;
    }
    const task = queryTask(service.windows, environment);
    if (task.exists && String(task.state).toLowerCase() === "running") {
      await waitForHost(definition.controlPath, true, hostStartTimeoutMs);
      if (service.target === "app-server") await waitForAppServer(definition.socketPath);
      continue;
    }
    runTaskPrimitive("start", service.windows, environment, undefined, definition.pwshBinary);
    await waitForHost(definition.controlPath, true, hostStartTimeoutMs);
    if (service.target === "app-server") {
      await waitForAppServer(definition.socketPath);
    }
  }
}

async function waitForAppServer(socketPath) {
  if (typeof socketPath !== "string" || socketPath.length === 0) return;
  const deadline = Date.now() + hostStartTimeoutMs;
  while (Date.now() < deadline) {
    if (await appServerSocketAcceptsWebSocket(socketPath)) {
      await waitForAppServerSupervisor(appServerSupervisorSocketPath(socketPath), deadline);
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
  throw new Error(`等待 Codex App Server 就绪超时：${socketPath}`);
}

async function waitForAppServerSupervisor(socketPath, deadline) {
  while (Date.now() < deadline) {
    try {
      if ((await inspectAppServerSupervisorState(socketPath)).status === "ready") return;
    } catch {
      // The descriptor may be absent or mid-write while App Server finishes startup.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
  throw new Error(`等待 App Server 监管入口就绪超时：${socketPath}`);
}

async function stopDefinition(service, definitionsDirectory, environment) {
  const file = definitionPath(definitionsDirectory, service.target);
  if (existsSync(file)) {
    const definition = readDefinition(file);
    const host = await inspectHost(definition.controlPath);
    if (host?.version === 1) {
      await requestHost(definition.controlPath, { action: "stop" });
      if (await waitForHost(definition.controlPath, false, hostStopTimeoutMs, false)) return;
    }
  }
  runTaskPrimitive("stop", service.windows, environment);
  if (existsSync(file)) {
    const definition = readDefinition(file);
    await waitForHost(definition.controlPath, false, hostStopTimeoutMs);
  }
}

function preflight(environment) {
  const pwsh = resolveExecutable("pwsh.exe", environment);
  const result = spawnSync(pwsh, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Command Get-ScheduledTask,Register-ScheduledTask,Start-ScheduledTask,Stop-ScheduledTask,Unregister-ScheduledTask -ErrorAction Stop | Out-Null",
  ], { env: environment, stdio: "ignore", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("PowerShell ScheduledTasks 模块不可用，无法管理 Windows 后台服务");
  }
}

function runTaskPrimitive(action, taskName, environment, definition, preferredPwsh) {
  const pwsh = preferredPwsh || resolveExecutable("pwsh.exe", environment);
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(packageDir, "scripts", "windows-scheduled-task.ps1"),
    "-Action",
    action,
    "-TaskName",
    taskName,
    ...(definition ? ["-DefinitionPath", definition] : []),
  ];
  const result = spawnSync(pwsh, args, {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = firstNonemptyLine(result.stderr) || `exit=${result.status ?? 1}`;
    throw new Error(`Windows 计划任务操作失败：${taskName}（${detail}）`);
  }
  return String(result.stdout ?? "").trim();
}

function queryTask(taskName, environment) {
  const output = runTaskPrimitive("query", taskName, environment);
  const json = output.split(/\r?\n/u).findLast((line) => line.trim().startsWith("{"));
  if (!json) throw new Error(`Windows 计划任务状态无效：${taskName}`);
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`Windows 计划任务状态无效：${taskName}`, { cause: error });
  }
}

async function inspectHost(controlPath) {
  if (!privateIpcEndpointExists(controlPath)) return undefined;
  try {
    return await requestHost(controlPath, { action: "inspect" });
  } catch {
    return undefined;
  }
}

function requestHost(controlPath, request) {
  return new Promise((resolveResponse, rejectResponse) => {
    let socket;
    try {
      socket = createPrivateIpcConnection(controlPath);
    } catch (error) {
      rejectResponse(error);
      return;
    }
    const chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectResponse(error);
    };
    socket.setTimeout(2_000, () => fail(new Error("Windows 服务宿主请求超时")));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", fail);
    socket.once("end", () => {
      if (settled) return;
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
        settled = true;
        resolveResponse(response);
      } catch (error) {
        fail(new Error("Windows 服务宿主响应无效", { cause: error }));
      }
    });
  });
}

async function waitForHost(controlPath, expected, timeoutMs, throwOnTimeout = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = (await inspectHost(controlPath))?.running === true;
    if (active === expected) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
  }
  if (!throwOnTimeout) return false;
  throw new Error(`等待 Windows 服务宿主${expected ? "启动" : "停止"}超时：${controlPath}`);
}

function showLogs(target, definitionsDirectory, environment, { follow, lines }) {
  const paths = [];
  for (const service of serviceDefinitionsForTarget(target)) {
    const definition = readDefinition(definitionPath(definitionsDirectory, service.target));
    for (const path of [definition.stdoutLog, definition.stderrLog]) {
      if (existsSync(path)) paths.push(path);
    }
  }
  if (paths.length === 0) {
    throw new Error("尚未找到 Windows 后台日志；请先启动服务并检查状态");
  }
  if (!follow) {
    for (const path of paths) {
      console.log(`==> ${path} <==`);
      console.log(tailLines(readFileSync(path, "utf8"), lines));
    }
    return;
  }
  const pwsh = resolveExecutable("pwsh.exe", environment);
  const result = spawnSync(pwsh, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(packageDir, "scripts", "windows-log-follow.ps1"),
    "-Lines",
    String(lines),
    "-PathsJson",
    JSON.stringify(paths),
  ], { env: environment, stdio: "inherit", windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows 日志跟随失败：exit=${result.status ?? 1}`);
}

function readDefinition(path) {
  let definition;
  try {
    definition = JSON.parse(readPrivateFileSync(path, definitionLimitBytes));
  } catch (error) {
    throw new Error(`Windows 服务定义缺失或无效：${path}；请运行 codexc service install`, { cause: error });
  }
  if (
    definition?.version !== 1
    || typeof definition.taskName !== "string"
    || typeof definition.pwshBinary !== "string"
    || typeof definition.controlPath !== "string"
  ) {
    throw new Error(`Windows 服务定义缺失或无效：${path}；请运行 codexc service install`);
  }
  return definition;
}

function definitionPath(directory, target) {
  return join(directory, `${target}.json`);
}

function printLifecycleResult(action, target) {
  const label = target === "all"
    ? "Codex App Server 与 Gateway"
    : serviceDefinitions.find((service) => service.target === target)?.displayName ?? target;
  const verb = action === "start" ? "已启动" : action === "stop" ? "已停止" : "已重启";
  writeCliMessage(action === "start" || action === "restart" ? "note" : "success", `${label}${verb}。`);
}

function tailLines(value, count) {
  return value.replace(/\r\n/gu, "\n").split("\n").slice(-count).join("\n");
}

function firstNonemptyLine(value) {
  return String(value ?? "").split(/\r?\n/u).find((line) => line.trim())?.trim();
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseArguments(args) {
  const remaining = [...args];
  const action = remaining.shift();
  let target;
  let definitionsDirectory;
  let follow = false;
  let json = false;
  let lines = 100;
  while (remaining.length > 0) {
    const value = remaining.shift();
    if (value === "--definitions") {
      definitionsDirectory = remaining.shift();
      continue;
    }
    if (value === "--follow") {
      follow = true;
      continue;
    }
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--lines") {
      lines = Number(remaining.shift());
      continue;
    }
    if (!target) {
      target = value;
      continue;
    }
    throw new Error(`未知 Windows 服务参数：${value}`);
  }
  return { action, target, definitionsDirectory, follow, lines, json };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await controlWindowsServices({
      ...options,
      environment: process.env,
      definitionsDirectory: options.definitionsDirectory
        || windowsServiceDefinitionsDirectory(process.env),
    });
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
