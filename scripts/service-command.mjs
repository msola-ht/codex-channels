import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { runAppServerService } from "../runtime/app-server-service-runtime.mjs";
import { writeCliMessage as printCliMessage } from "../runtime/cli-presentation.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { runGatewayService } from "../runtime/gateway-service-runtime.mjs";
import { assertSynchronousChildSuccess } from "../runtime/process-lifecycle.mjs";
import {
  defaultServiceTarget,
  parseServiceTarget,
  serviceTargetIncludes,
  serviceTargetUsage,
} from "../runtime/service-targets.mjs";
import { applyTerminalIdentityFromEnvironment } from "./config-management.mjs";
import { packageDir } from "./package-path.mjs";
import {
  configuredEnvironment,
  serviceControlEnvironment,
} from "./runtime-environment.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const nodeExperimentalWarningOption = "--disable-warning=ExperimentalWarning";

export const serviceCommandActions = Object.freeze([
  "install",
  "uninstall",
  "start",
  "stop",
  "reload",
  "restart",
  "status",
  "logs",
]);

export const serviceCommandUsage = Object.freeze({
  install: "用法：codexc service install",
  uninstall: "用法：codexc service uninstall",
  start: `用法：codexc service start [${serviceTargetUsage}]`,
  stop: `用法：codexc service stop [${serviceTargetUsage}]`,
  reload: "用法：codexc service reload",
  restart: `用法：codexc service restart [${serviceTargetUsage}]`,
  status: `用法：codexc service status [${serviceTargetUsage}] [--json]`,
  logs: `用法：codexc service logs [${serviceTargetUsage}] [-f|--follow] [-n|--lines 行数]`,
});

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

/**
 * 安装服务时按运行命令的终端补入缺失的 `[codex].terminal_identity`：App Server 由服务进程
 * 启动、自身没有终端，只有用户直接运行的安装命令能探测到其实际使用的终端。已配置或探测不到终端
 * 时保持配置原样；补入失败只提示并继续，不阻塞安装。更新与配置时机分别由 `local-update.mjs`
 * 与 `config-system-menu.mjs` 处理。
 */
function recordInstalledTerminalIdentity(environment) {
  let terminalIdentity;
  try {
    terminalIdentity = applyTerminalIdentityFromEnvironment(environment);
  } catch (error) {
    printCliMessage(
      "failure",
      `未写入模型上游终端标识，服务操作继续：${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (terminalIdentity === null) return;
  printCliMessage("note", `已按当前终端记录模型上游终端标识：${terminalIdentity}`);
}

export async function runServiceCommand(args) {
  const [action, ...rest] = args;
  if (!serviceCommandActions.includes(action)) {
    throw new Error("用法：codexc service <install|uninstall|start|stop|reload|restart|status|logs>");
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
    const runtime = configuredEnvironment();
    recordInstalledTerminalIdentity(runtime.environment);
    const { prepareServiceInstall } = await import(
      "./service-install-management.mjs"
    );
    const task = prepareServiceInstall(runtime.environment, {
      onProgress: ({ stage, status }) => {
        if (status === "completed" && stage === "validate-config") {
          console.log("Gateway 配置校验通过。");
        }
        if (status === "completed" && stage === "write-definitions") {
          for (const managedService of task.preview.services) {
            console.log(`生成：${managedService.destination}`);
          }
          printCliMessage(
            "success",
            task.preview.serviceManager === "systemd"
              ? "systemd 用户服务配置已生成。"
              : task.preview.serviceManager === "launchd"
                ? "launchd 配置已生成。"
                : "Windows 当前用户计划任务配置已生成。",
          );
        }
      },
    });
    await task.execute();
    printCliMessage("success", coreServiceReadyMessage("all"));
    return;
  }
  const controlEnvironment = serviceActionAllowsInvalidConfig(action)
    ? serviceControlEnvironment()
    : configuredEnvironment().environment;
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
    throw new Error("codexc service 当前支持 macOS launchd、Linux systemd 与 Windows 计划任务");
  }
  const readinessTarget = coreServiceReadinessTarget(action, serviceArgs);
  if (readinessTarget) {
    await waitForManagedServiceReadiness(readinessTarget);
    printCliMessage("success", coreServiceReadyMessage(readinessTarget));
  } else if (action === "start" || action === "restart") {
    const httpTarget = serviceArgs[0] === "webui" ? "webui" : undefined;
    if (httpTarget !== undefined) {
      await waitForHttpServiceReadiness(httpTarget, controlEnvironment);
      printCliMessage("success", "WebUI 已就绪。");
    }
  }
}

function serviceControllerReportsFailure(action) {
  return action === "status" || action === "reload";
}

function serviceActionAllowsInvalidConfig(action) {
  return new Set(["uninstall", "stop", "reload", "status", "logs"]).has(action);
}

function coreServiceReadinessTarget(action, serviceArgs) {
  if (action === "install") return "all";
  if (action !== "start" && action !== "restart") return undefined;
  const target = serviceArgs[0];
  return target === "gateway" || target === "app-server" || target === "all"
    ? target
    : undefined;
}

export async function waitForManagedServiceReadiness(
  target,
  environment = process.env,
  options = undefined,
) {
  const { waitForCoreServiceTarget } = await import("./local-update.mjs");
  await waitForCoreServiceTarget(target, environment, options);
}

async function waitForHttpServiceReadiness(target, environment) {
  const configPath = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  if (!configPath) throw new Error("缺少 Gateway 配置路径，无法确认服务就绪");
  const document = readGatewayConfig(configPath);
  const section = document.webui;
  if (section === undefined) return;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        ...(typeof section?.token === "string"
          ? { headers: { authorization: `Bearer ${section.token}` } }
          : {}),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
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
    const invocation = ["codexc", "service", action, ...serviceArgs].join(" ");
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
      if (!Number.isSafeInteger(lines) || lines <= 0 || lines > 10_000) {
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
