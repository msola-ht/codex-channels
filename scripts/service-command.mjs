import { restartCommandUsage, serviceCommandActions, serviceCommandUsage } from "./cli-command-usage.mjs";
export { serviceCommandActions, serviceCommandUsage } from "./cli-command-usage.mjs";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { runAppServerService } from "../runtime/app-server-service-runtime.mjs";
import { writeCliMessage as printCliMessage } from "../runtime/cli-presentation.mjs";
import {
  readGatewayConfig,
  validateGatewayConfigDocument,
  validateWebuiConfigDocument,
  webuiServiceEnabled,
} from "../runtime/gateway-config.mjs";
import { runGatewayService } from "../runtime/gateway-service-runtime.mjs";
import { assertSynchronousChildSuccess, ForwardedChildSignalError, installServiceControlHandler, registerChildProcessGroup, terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import {
  defaultServiceTarget,
  serviceTargetIncludes,
  serviceCommandTarget,
  serviceDefinitions,
  serviceTargetUsage as internalServiceTargetUsage,
} from "../runtime/service-targets.mjs";
import { applyTerminalIdentityFromEnvironment } from "./config-management.mjs";
import { packageDir } from "./package-path.mjs";
import {
  configuredEnvironment,
  serviceControlEnvironment,
} from "./runtime-environment.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";
import { serviceControlDefinitions, serviceDefinitionPath, waitForSelectedRelay } from "./service-selection.mjs";
import { inspectManagedServiceStatusAsync } from "./service-status.mjs";
import { withCliProgress, writeCliSection } from "./cli-operation-progress.mjs";
import { supervisedCliInvocation } from "./cli-command-worker.mjs";

const nodeExperimentalWarningOption = "--disable-warning=ExperimentalWarning";

// Public spelling is independent of installed service identifiers and file names.
const serviceTargetUsage = internalServiceTargetUsage.split("|").map(serviceCommandTarget).join("|");
function parseServiceTarget(value) {
  if (value === "appserver") return "app-server";
  if (value === "relay") return "model-relay";
  if (value !== "model-relay" && value !== "app-server" && internalServiceTargetUsage.split("|").includes(value)) return value;
  throw new Error(`服务目标必须是 ${serviceTargetUsage.replaceAll("|", "、")}：${value}`);
}

export async function runGatewayServiceCommand(args) {
  if (args.length > 0) throw new Error("用法：codexc gateway");
  const runtime = configuredEnvironment();
  await runGatewayService(
    runtime,
    join(packageDir, "dist/main.js"),
    waitForManagedServiceReadiness,
  );
}

export async function runAppServerServiceCommand(args) {
  if (args.length > 0) throw new Error("内部服务入口不接受参数");
  const runtime = configuredEnvironment();
  await runAppServerService(
    runtime,
    () => readWorkspaceConfig(runtime.document).defaultWorkspace,
  );
}

export async function runModelRelayServiceCommand(args) {
  if (args.length > 0) throw new Error("内部服务入口不接受参数");
  let stop;
  let stopping = false;
  const stopped = new Promise(resolve => { stop = () => { stopping = true; resolve(); }; });
  const controlFromParent = message => { if (message?.type === "codexc-stop") stop(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const cleanupControl = installServiceControlHandler(controlFromParent);
  let service;
  try {
    const { locateUserConfig } = await import("./runtime-config.mjs");
    const { startModelRelayService } = await import("../runtime/model-relay-service.mjs");
    if (stopping) return;
    const { configPath } = locateUserConfig(process.env);
    service = await startModelRelayService(configPath, process.env);
    await stopped;
  }
  finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    cleanupControl();
    await service?.close();
  }
}

/**
 * 安装服务时按运行命令的终端补入缺失的 `[codex].terminal_identity`：App Server 由服务进程
 * 启动、自身没有终端，只有用户直接运行的安装命令能探测到其实际使用的终端。已配置或探测不到终端
 * 时保持配置原样；补入失败只提示并继续，不阻塞安装。日常配置由 `config-system-menu.mjs` 处理，
 * 更新器不补入终端标识。
 */
function recordInstalledTerminalIdentity(environment, writeMessage = printCliMessage) {
  let terminalIdentity;
  try {
    terminalIdentity = applyTerminalIdentityFromEnvironment(environment);
  } catch (error) {
    writeMessage(
      "failure",
      `未写入模型上游终端标识，服务操作继续：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (terminalIdentity === null) return;
  writeMessage("note", `已按当前终端记录模型上游终端标识：${terminalIdentity}`);
}

async function timedServiceStep(action, definition, environment) {
  const label = `${action === "stop" ? "停止" : "启动并确认就绪"} ${definition.displayName}`;
  await withCliProgress(label, async progress => {
    await runServiceController(action, [definition.target], environment, progress);
    progress.signal.throwIfAborted();
    if (action === "start") {
      progress.message(`等待 ${definition.displayName} 就绪`);
      await waitForServiceReadiness(definition.target, environment, progress.signal);
    }
  });
}

export async function runRestartCommand(args = []) {
  if (args.length > 1) throw new Error(restartCommandUsage);
  const target = parseServiceTarget(args[0] ?? "all");
  rejectUnsafeAppServerServiceAction("restart", [target], process.env);
  writeCliSection("重启检查");
  const { runtime, stopping, steps } = await withCliProgress("重启预检", async progress => {
    const runtime = configuredEnvironment();
    const document = validateGatewayConfigDocument(runtime.document);
    const platform = { linux: "systemd", darwin: "launchd", win32: "windows" }[process.platform];
    if (!platform) throw new Error("codexc restart 当前支持 macOS launchd、Linux systemd 与 Windows 计划任务");
    if (serviceTargetIncludes(target, "gateway") || serviceTargetIncludes(target, "app-server")) {
      const { loadConfigDocument } = await import("../dist/config/index.js");
      loadConfigDocument(readFileSync(runtime.configPath, "utf8"), dirname(runtime.configPath), { environment: runtime.environment });
    }
    const selected = (target === "all" ? ["webui", "model-relay", "gateway", "app-server"] : [target])
      .map(value => serviceDefinitions.find(definition => definition.target === value));
    const windowsStatus = platform === "windows"
      ? await (await import("./windows-service-control.mjs")).inspectWindowsServiceStatus({
          target, environment: runtime.environment,
          definitionsDirectory: join(runtime.dataDir, "services"),
        })
      : undefined;
    const stopping = [];
    for (const definition of selected) {
      progress.signal.throwIfAborted();
      progress.message(`检查 ${definition.displayName} 服务定义与状态`);
      if (!existsSync(serviceDefinitionPath(platform, definition, runtime.environment))) {
        if (target !== "all" || definition.core) {
          throw new Error(`${definition.displayName} 后台服务未安装；请先运行 codexc install。尚未停止任何服务。`);
        }
        progress.log(`跳过 ${definition.displayName}：未安装后台服务。`);
        continue;
      }
      const status = windowsStatus ?? await inspectManagedServiceStatusAsync({ target: definition.target, environment: runtime.environment });
      if (platform !== "launchd" && status.services.find(service => service.target === definition.target)?.loaded !== true) {
        throw new Error(`${definition.displayName} 服务定义未被服务管理器加载；请运行 codexc install。尚未停止任何服务。`);
      }
      stopping.push(definition);
    }
    progress.signal.throwIfAborted();
    if (platform === "launchd") await runServiceController("check-install", [], runtime.environment, progress);
    const starting = [...stopping].reverse().filter(definition => {
      if (target === "all" && definition.target === "model-relay" && document.model_relay?.enabled !== true) {
        progress.log("Model Relay 未启用：仅停止，不重新启动。");
        return false;
      }
      if (target === "all" && definition.target === "webui" && webuiServiceEnabled(document) === false) {
        progress.log("WebUI 已在配置中关闭：仅停止，不重新启动。");
        return false;
      }
      return true;
    });
    const steps = [
      ...stopping.map(definition => ({ action: "stop", definition })),
      ...starting.map(definition => ({ action: "start", definition })),
    ];
    return { runtime, stopping, steps };
  });
  const label = step => `${step.action === "stop" ? "停止" : "启动并确认就绪"} ${step.definition.displayName}`;
  const completed = [];
  let previousAction;
  for (const [index, step] of steps.entries()) {
    if (step.action !== previousAction) {
      writeCliSection(step.action === "stop" ? "停止服务" : "启动与就绪确认");
      previousAction = step.action;
    }
    try {
      await timedServiceStep(step.action, step.definition, runtime.environment);
      completed.push(label(step));
    } catch (error) {
      if (error instanceof ForwardedChildSignalError) throw error;
      const failure = new Error(
        `重启中止：${label(step)}失败。\n已完成：${completed.join("；") || "无"}。`
        + `\n未执行：${steps.slice(index + 1).map(label).join("；") || "无"}。`
        + "\n未自动回滚；请用 codexc status 和 codexc status webui 检查状态，排除问题后重试。"
        + `\n原因：${error instanceof Error ? error.message : "服务操作失败"}`,
        { cause: error },
      );
      if (error?.exitCode === 130 || error?.exitCode === 143) {
        printCliMessage("failure", failure.message);
        throw error;
      }
      throw failure;
    }
  }
  writeCliSection("重启结果");
  printCliMessage("success", `${target === "all" ? "全部已选后台服务" : stopping[0].displayName}重启完成。`);
}

export async function runServiceCommand(args) {
  const [action, ...rest] = args;
  if (!serviceCommandActions.includes(action)) {
    throw new Error("未知后台服务操作");
  }
  const serviceArgs = parseServiceArguments(action, rest);
  rejectUnsafeAppServerServiceAction(action, serviceArgs, process.env);
  if (action === "status" && serviceArgs[1] === "--json") {
    runNodeScript(
      "service-status.mjs",
      [serviceArgs[0]],
      serviceControlEnvironment(),
    );
    return;
  }
  if (action === "install") {
    writeCliSection("安装后台服务");
    await withCliProgress("安装并确认核心服务就绪", async progress => {
      const runtime = configuredEnvironment();
      recordInstalledTerminalIdentity(runtime.environment, (kind, text) => progress.log(text, { stream: kind === "failure" ? "stderr" : "stdout" }));
      const { prepareServiceInstall } = await import("./service-install-management.mjs");
      const labels = {
        "validate-config": "检查 Gateway 配置",
        preflight: "检查服务安装环境",
        "write-definitions": "写入服务定义",
        "activate-core": "安装并启动核心服务",
        "verify-core": "等待核心服务就绪",
      };
      const task = prepareServiceInstall(runtime.environment, {
        signal: progress.signal,
        onProgress: ({ stage, status }) => {
          if (status === "started") progress.message(labels[stage]);
          if (status === "failed") progress.message("安装中止，正在处理服务定义恢复");
        },
        onOutput: (text, options) => {
          const redundant = [
            "[提示] Codex App Server 与 Gateway systemd 用户服务已安装，启动操作已完成，正在确认就绪状态。",
            "[提示] Codex App Server 与 Gateway 已安装，启动操作已完成，正在确认就绪状态。",
            "[提示] Codex App Server 与 Gateway Windows 计划任务已安装并启动，正在确认就绪状态。",
          ];
          if (options.stream === "stderr" || !redundant.includes(text.trim())) progress.log(text, options);
        },
      });
      try { await task.execute(); }
      catch (error) {
        if (progress.signal.aborted) {
          progress.log(error.message, { stream: "stderr" });
          throw progress.signal.reason;
        }
        throw error;
      }
    });
    writeCliSection("安装结果");
    printCliMessage("success", coreServiceReadyMessage("all"));
    return;
  }
  const runtime = serviceActionAllowsInvalidConfig(action) ? undefined : configuredEnvironment();
  const controlEnvironment = runtime?.environment ?? serviceControlEnvironment();
  if (action === "uninstall") {
    writeCliSection("卸载后台服务");
    await withCliProgress("停止并移除后台服务", progress =>
      runProgressServiceController(action, serviceArgs, controlEnvironment, progress, { waitOnCancel: true }));
    printCliMessage("note", "程序与用户数据已保留。");
    return;
  }
  if (action === "start" || action === "stop") {
    writeCliSection(action === "start" ? "启动与就绪确认" : "停止服务");
    const platform = { linux: "systemd", darwin: "launchd", win32: "windows" }[process.platform];
    if (!platform) throw new Error("不支持的后台服务平台");
    const selected = serviceControlDefinitions(platform, serviceArgs[0], action, controlEnvironment);
    if (action === "start" && serviceArgs[0] === "all" && runtime !== undefined) {
      printSkippedOptionalServiceNotes(platform, selected, controlEnvironment, runtime.document);
    }
    const failures = [];
    for (const definition of selected) {
      try {
        await timedServiceStep(action, definition, controlEnvironment);
      } catch (error) {
        // Unix controllers historically attempt every selected stop before
        // reporting failure. Timing must not turn this into fail-fast behavior.
        if (error instanceof ForwardedChildSignalError || error?.exitCode === 130 || error?.exitCode === 143
          || action !== "stop" || serviceArgs[0] !== "all" || platform === "windows") throw error;
        failures.push({ definition, error });
      }
    }
    if (failures.length > 0) throw new AggregateError(
      failures.map(failure => failure.error),
      `停止服务失败：${failures.map(failure => failure.definition.displayName).join("、")}；已尝试其余所选服务，请运行 codexc status。`,
    );
    if (serviceArgs[0] === "all") printCliMessage("success", action === "start" ? "全部已选后台服务已就绪。" : "全部已选后台服务已停止。");
    return;
  }
  await runServiceController(action, serviceArgs, controlEnvironment);
}

async function runServiceController(action, serviceArgs, controlEnvironment, progress) {
  if (process.platform === "win32" && (action === "start" || action === "stop")) {
    const { controlWindowsServices } = await import("./windows-service-control.mjs");
    await controlWindowsServices({
      action, target: serviceArgs[0], environment: controlEnvironment,
      definitionsDirectory: join(controlEnvironment.CODEX_CONNECT_HOME, "services"),
      quiet: progress !== undefined,
      signal: progress?.signal,
    });
    return;
  }
  if (progress && (process.platform === "darwin" || process.platform === "linux")) {
    await runProgressServiceController(action, serviceArgs, controlEnvironment, progress);
    return;
  }
  if (process.platform === "darwin") {
    runSynchronous(
      "/bin/zsh",
      [join(packageDir, "scripts/launchd-control.sh"), action, ...serviceArgs],
      controlEnvironment,
      undefined,
      { failureReportedByChild: serviceControllerReportsFailure(action) },
    );
  } else if (process.platform === "linux") {
    runSynchronous(
      "/bin/sh",
      [join(packageDir, "scripts/systemd-control.sh"), action, ...serviceArgs],
      controlEnvironment,
      undefined,
      { failureReportedByChild: serviceControllerReportsFailure(action) },
    );
  } else if (process.platform === "win32") {
    runSynchronous(
      process.execPath,
      [
        join(packageDir, "scripts/windows-service-control.mjs"),
        action,
        ...serviceArgs,
        "--definitions",
        join(controlEnvironment.CODEX_CONNECT_HOME, "services"),
      ],
      controlEnvironment,
      undefined,
      { failureReportedByChild: serviceControllerReportsFailure(action) },
    );
  } else {
    throw new Error("codexc 后台服务命令当前支持 macOS launchd、Linux systemd 与 Windows 计划任务");
  }
}

async function waitForServiceReadiness(target, environment, signal) {
  const readinessTarget = target === "gateway" || target === "app-server" || target === "all" ? target : undefined;
  await waitForSelectedRelay(target, environment, { signal });
  if (readinessTarget) {
    await waitForManagedServiceReadiness(readinessTarget, environment, { signal });
  } else if (target === "webui") {
    await waitForHttpServiceReadiness(environment, signal);
  }
}

function serviceControllerReportsFailure(action) {
  return action === "status" || action === "reload";
}

function serviceActionAllowsInvalidConfig(action) {
  return new Set(["uninstall", "stop", "reload", "status", "logs"]).has(action);
}

/** 启动 all 时说明按配置跳过的可选服务，避免与启动失败混淆。 */
function printSkippedOptionalServiceNotes(platform, selected, environment, document) {
  const selectedTargets = new Set(selected.map(definition => definition.target));
  const optionalServices = [
    {
      target: "webui",
      enabled: webuiServiceEnabled(document) !== false,
      note: "WebUI 已在配置中关闭：跳过启动。",
    },
    {
      target: "model-relay",
      enabled: document.model_relay?.enabled === true,
      note: "Model Relay 未启用：跳过启动。",
    },
  ];
  for (const service of optionalServices) {
    if (service.enabled || selectedTargets.has(service.target)) continue;
    const definition = serviceDefinitions.find(candidate => candidate.target === service.target);
    if (definition === undefined) continue;
    if (!existsSync(serviceDefinitionPath(platform, definition, environment))) continue;
    printCliMessage("note", service.note);
  }
}

export async function waitForManagedServiceReadiness(
  target,
  environment = process.env,
  options = undefined,
) {
  const { waitForCoreServiceTarget } = await import("./local-installation.mjs");
  await waitForCoreServiceTarget(target, environment, options);
}

async function waitForHttpServiceReadiness(environment, signal) {
  const configPath = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  if (!configPath) throw new Error("缺少 Gateway 配置路径，无法确认服务就绪");
  const document = readGatewayConfig(configPath);
  const section = validateWebuiConfigDocument(document);
  const host = section?.host === "0.0.0.0" ? "127.0.0.1" : section?.host;
  const port = section?.port;
  if (typeof host !== "string" || !Number.isInteger(port)) {
    throw new Error("WebUI 配置无效，无法确认服务就绪");
  }
  const healthPath = "/api/v1/health";
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}${healthPath}`;
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      const response = await fetch(url, {
        signal: signal ? globalThis.AbortSignal.any([controller.signal, signal]) : controller.signal,
        redirect: "error",
        ...(typeof section?.token === "string"
          ? { headers: { authorization: `Bearer ${section.token}` } }
          : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("WebUI 健康响应缺少正文");
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024) throw new Error("WebUI 健康响应超过上限");
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel();
      }
      let health;
      try {
        health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("WebUI 健康响应不是有效 JSON");
      }
      if (health?.ok !== true || health?.service !== "webui"
        || !Number.isSafeInteger(health.pid) || health.pid <= 0
        || !Number.isSafeInteger(health.parentPid) || health.parentPid <= 0) {
        throw new Error("WebUI 健康响应身份无效");
      }
      const status = await inspectManagedServiceStatusAsync({ target: "webui", environment });
      signal?.throwIfAborted();
      const service = status.services.find(candidate => candidate.target === "webui");
      if (service?.running !== true || service.pid === null
        || (service.pid !== health.pid && service.pid !== health.parentPid)) {
        throw new Error("健康端点不属于正在运行的受管 WebUI 服务");
      }
      return;
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `WebUI 启动后未就绪：${lastError instanceof Error ? lastError.message : "健康检查超时"}`,
  );
}

/** Fold only controller-owned success lines; unknown output and diagnostics remain visible. */
async function runProgressServiceController(action, serviceArgs, environment, progress, { waitOnCancel = false } = {}) {
  progress.signal.throwIfAborted();
  const definition = serviceDefinitions.find(value => value.target === serviceArgs[0]);
  const normalMessages = new Set(definition ? [
    `[成功] ${definition.displayName}已停止。`,
    `[成功] ${definition.displayName} 已停止。`,
    `[成功] ${definition.displayName}已启动。`,
    `[成功] ${definition.displayName} 已启动。`,
    `[提示] ${definition.displayName} 启动操作已完成，正在确认就绪状态。`,
  ] : []);
  if (action === "uninstall") {
    for (const manager of ["systemd 用户服务", "launchd 服务", "Windows 计划任务"]) {
      normalMessages.add(`[成功] Codex App Server、Gateway 与 WebUI ${manager}已卸载。`);
    }
    normalMessages.add("[提示] 用户配置与运行数据保留在 ~/.codex-connect。");
    normalMessages.add("[提示] 用户配置与运行数据保留在 CODEX_CONNECT_HOME。");
  }
  const windows = process.platform === "win32";
  if (!["linux", "darwin", "win32"].includes(process.platform)) throw new Error("不支持的后台服务平台");
  const invocation = supervisedCliInvocation({
    file: windows ? process.execPath : process.platform === "darwin" ? "/bin/zsh" : "/bin/sh",
    args: [join(packageDir, windows ? "scripts/windows-service-control.mjs"
      : process.platform === "darwin" ? "scripts/launchd-control.sh" : "scripts/systemd-control.sh"), action, ...serviceArgs,
    ...(windows ? ["--definitions", join(environment.CODEX_CONNECT_HOME, "services")] : [])],
  });
  const child = spawn(
    invocation.file, invocation.args,
    { env: environment, stdio: ["inherit", "pipe", "pipe"], detached: waitOnCancel || !windows, windowsHide: true },
  );
  if (!windows) registerChildProcessGroup(child);
  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  stdout.on("line", line => {
    if (!normalMessages.has(line)) progress.log(line);
  });
  stderr.on("line", line => progress.log(line, { stream: "stderr" }));
  let cleanup;
  let abort;
  const stopped = new Promise((resolve, reject) => {
    abort = () => {
      if (waitOnCancel) return;
      cleanup ??= terminateChildProcess(child).catch(error => {
        child.unref();
        throw Object.assign(new Error("后台服务控制命令终止未获确认，请检查服务状态", { cause: error }), {
          exitCode: progress.signal.reason?.exitCode ?? 1,
        });
      }).finally(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      });
      void cleanup.then(() => reject(progress.signal.reason), reject);
    };
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
    progress.signal.addEventListener("abort", abort, { once: true });
    if (progress.signal.aborted) abort();
  });
  try {
    // Cleanup remains owned and awaited even if the child closes while cancelling.
    const result = await stopped;
    if (cleanup) await cleanup;
    progress.signal.throwIfAborted();
    assertSynchronousChildSuccess(result, { failureReportedByChild: action === "uninstall" });
  } finally {
    progress.signal.removeEventListener("abort", abort);
    stdout.close();
    stderr.close();
    if (cleanup) await cleanup;
  }
}

function coreServiceReadyMessage(target) {
  if (target === "gateway") {
    return "Gateway 已就绪；Codex App Server 保持运行。";
  }
  if (target === "app-server") {
    return "Codex App Server 已就绪；Gateway 将自动重连。";
  }
  return "Codex App Server 与 Gateway 已就绪。";
}

function rejectUnsafeAppServerServiceAction(action, serviceArgs, environment) {
  if (environment.CODEX_CONNECT_SERVICE_ROLE !== "app-server") return;
  const target = serviceArgs[0];
  const stopsCoreService = action === "stop"
    && (
      serviceTargetIncludes(target, "gateway")
      || serviceTargetIncludes(target, "app-server")
    );
  const restartsAppServer = action === "restart"
    && serviceTargetIncludes(target, "app-server");
  if (action === "install" || action === "uninstall" || stopsCoreService || restartsAppServer) {
    const invocation = ["codexc", action, ...(action === "uninstall" ? ["--services"] : serviceArgs.map(serviceCommandTarget))].join(" ");
    throw new Error(
      "不能在 Codex App Server 内执行会中断当前渠道的服务操作；"
      + `请在本机终端运行 ${invocation}。渠道内只允许重启 Gateway 或管理独立的 WebUI 服务。`,
    );
  }
}

function parseServiceLogOptions(args) {
  const remaining = [...args];
  const result = [];
  if (remaining[0] && !remaining[0].startsWith("-")) {
    result.push(parseServiceTarget(remaining.shift()));
  } else {
    result.push("gateway");
  }
  for (let index = 0; index < remaining.length; index += 1) {
    const option = remaining[index];
    if (option === "--follow" || option === "-f") {
      result.push("--follow");
      continue;
    }
    if (option === "--lines" || option === "-n") {
      const value = remaining[index + 1];
      const lines = Number(value);
      if (typeof value !== "string" || !/^\d+$/u.test(value) || !Number.isSafeInteger(lines) || lines <= 0 || lines > 10_000) {
        throw new Error("日志行数必须是 1 到 10000 之间的整数");
      }
      result.push("--lines", String(lines));
      index += 1;
      continue;
    }
    throw new Error(
      `未知日志参数：${option}\n`
      + serviceCommandUsage.logs,
    );
  }
  return result;
}

function parseServiceArguments(action, args) {
  if (action === "logs") {
    return parseServiceLogOptions(args);
  }
  if (action === "install" || action === "uninstall" || action === "reload") {
    if (args.length > 0) {
      throw new Error(serviceCommandUsage[action]);
    }
    return [];
  }
  if (action === "status") {
    const json = args.at(-1) === "--json";
    const positional = json ? args.slice(0, -1) : args;
    if (positional.length > 1) {
      throw new Error(serviceCommandUsage.status);
    }
    const target = parseServiceTarget(positional[0] ?? defaultServiceTarget(action));
    return json ? [target, "--json"] : [target];
  }
  if (args.length > 1) {
    throw new Error(serviceCommandUsage[action]);
  }
  const defaultTarget = defaultServiceTarget(action);
  return [parseServiceTarget(args[0] ?? defaultTarget)];
}

function runNodeScript(relativePath, args, environment) {
  runSynchronous(
    process.execPath,
    [join(packageDir, "scripts", relativePath), ...args],
    environment,
    process.cwd(),
    { failureReportedByChild: true },
  );
}

function runSynchronous(executable, args, environment, cwd, options = {}) {
  const result = spawnSync(
    executable,
    executable === process.execPath
      ? [nodeExperimentalWarningOption, ...args]
      : args,
    {
      stdio: "inherit",
      env: environment,
      ...(cwd ? { cwd } : {}),
    },
  );
  assertSynchronousChildSuccess(result, options);
}
