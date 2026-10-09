import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  appServerSocketAcceptsWebSocket,
  ensureAppServerProvider,
  inspectAppServerSupervisor,
  sameAppServerTopology,
} from "../runtime/app-server-supervisor.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { securePrivateDirectorySync } from "../runtime/private-file.mjs";
import {
  childProcessIsRunning,
  createChildServiceControl,
  installProcessSignalHandlers,
  installServiceControlHandler,
  ReportedChildExitError,
  terminateChildProcess,
} from "../runtime/process-lifecycle.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { packageDir, runtimeConfig } from "./runtime-config.mjs";
import { serviceGracefulStopTimeoutMs } from "../runtime/shutdown-budget.mjs";

class DevAllStoppedError extends Error {}

await runDevAll().catch((error) => {
  if (!(error instanceof ReportedChildExitError)) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
  }
  process.exitCode = error instanceof ReportedChildExitError ? error.exitCode : 1;
});

async function runDevAll() {
  const projectDir = packageDir;
  const runtime = runtimeConfig();
  const document = readGatewayConfig(runtime.configPath);
  const appServerRuntime = resolveAppServerRuntime(document, runtime.dataDir);
  const socketPath = appServerRuntime.primarySocketPath;
  const runtimeDir = dirname(socketPath);
  const gatewayEntry = process.env.CODEX_CONNECT_GATEWAY_ENTRY === "dist"
    ? [join(projectDir, "dist/main.js")]
    : [join(projectDir, "node_modules", "tsx", "dist", "cli.mjs"), "src/main.ts"];

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  securePrivateDirectorySync(runtimeDir);

  const appServerSupervisors = [];
  const childControls = new WeakMap();
  let stopping = false;
  let stopTask;
  let gateway;
  const stop = () => {
    if (stopTask) return stopTask;
    stopping = true;
    stopTask = stopForegroundChildren(
      [...(gateway ? [gateway] : []), ...appServerSupervisors], childControls,
    );
    return stopTask;
  };
  const requestStop = () => { void stop().catch(() => undefined); };
  const cleanupSignals = installProcessSignalHandlers({ SIGINT: requestStop, SIGTERM: requestStop });
  const onControlMessage = (message) => {
    if (message?.type === "codexc-stop") requestStop();
  };
  const cleanupControl = installServiceControlHandler(onControlMessage);

  try {
    await ensureAppServerTopology({
      appServerRuntime,
      appServerSupervisors,
      runtime,
      socketPath,
      childControls,
      isStopping: () => stopping,
    });
    for (const supervisor of appServerSupervisors) {
      const onExit = (code, signal) => {
        if (!stopping) {
          writeCliMessage("failure", `Codex App Server 意外退出：code=${code} signal=${signal}`);
          requestStop();
          process.exitCode = 1;
        }
      };
      supervisor.once("exit", onExit);
      if (!childProcessIsRunning(supervisor)) onExit(supervisor.exitCode, supervisor.signalCode);
    }
    while (!stopping) {
      gateway = spawn(process.execPath, gatewayEntry, {
        cwd: runtime.dataDir,
        stdio: process.platform === "win32"
          ? ["inherit", "inherit", "inherit", "ipc"]
          : "inherit",
        env: {
          ...process.env,
          CODEX_CONNECT_CONFIG_FILE: runtime.configPath,
          CODEX_CONNECT_GATEWAY_SUPERVISED: "1",
          CODEX_CONNECT_SERVICE_ROLE: "gateway",
        },
      });
      childControls.set(gateway, createChildServiceControl(gateway));
      const result = await waitForGateway(gateway);
      childControls.get(gateway)?.close();
      gateway = undefined;
      if (stopping) break;
      if (result.code === 75) {
        console.log("Gateway 配置需要重建连接，正在保持 App Server 并重启 Gateway...");
        continue;
      }
      await stop();
      if (result.error) {
        throw new Error(`Gateway 启动失败：${result.error.message}`);
      }
      if (result.code !== 0 || result.signal) {
        throw new Error(
          `Gateway 意外退出：code=${result.code} signal=${result.signal}`,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof DevAllStoppedError)) throw error;
  } finally {
    try { await stop(); } finally {
      cleanupSignals();
      cleanupControl();
      for (const supervisor of appServerSupervisors) childControls.get(supervisor)?.close();
      if (gateway) childControls.get(gateway)?.close();
    }
  }
}

async function stopForegroundChildren(children, childControls) {
  const results = await Promise.allSettled(children.map(async child => {
    if (!childProcessIsRunning(child)) return;
    const deadline = Date.now() + serviceGracefulStopTimeoutMs;
    try {
      if (process.platform === "win32" && await childControls.get(child)?.send("codexc-stop")) {
        await new Promise(resolve => {
          let timer;
          const finish = () => {
            clearTimeout(timer);
            child.off("exit", finish);
            resolve();
          };
          child.once("exit", finish);
          timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
          if (!childProcessIsRunning(child)) finish();
        });
      }
    } finally {
      await terminateChildProcess(child, process.platform === "win32"
        ? undefined
        : { gracePeriodMs: serviceGracefulStopTimeoutMs });
    }
  }));
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, "前台服务子进程未能完全停止");
}

function waitForGateway(child) {
  return new Promise((resolveExit) => {
    let error;
    child.once("error", (failure) => {
      error = failure;
    });
    child.once("close", (code, signal) => resolveExit({ code, signal, error }));
  });
}

async function ensureAppServerTopology({
  appServerRuntime,
  appServerSupervisors,
  runtime,
  socketPath,
  childControls,
  isStopping,
}) {
  const assertRunning = () => { if (isStopping()) throw new DevAllStoppedError(); };
  assertRunning();
  const document = readGatewayConfig(runtime.configPath);
  const environment = { ...process.env, CODEX_BINARY: document.codex?.binary ?? process.env.CODEX_BINARY ?? "codex" };
  const topology = appServerRuntime.topology;
  const paths = topology.socketPaths;
  const primaryPath = appServerRuntime.primarySocketPath;
  const existingSupervisor = await inspectAppServerSupervisor(socketPath);
  assertRunning();
  if (existingSupervisor) {
    if (!sameAppServerTopology(existingSupervisor, topology)) {
      throw new Error(
        "现有 App Server Provider 拓扑与当前配置不一致；"
        + "请先运行 codexc stop all，再重试",
      );
    }
    await ensureAppServerProvider(socketPath, existingSupervisor.primaryProvider);
    assertRunning();
    await waitForSocket(undefined, primaryPath, 10_000, environment, isStopping);
    assertRunning();
    console.log(`检测到现有主 App Server Socket，将直接复用：${primaryPath}`);
    return;
  }
  const healthy = await Promise.all(paths.map((path) => appServerSocketAcceptsWebSocket(path, environment)));
  assertRunning();
  if (healthy.every(Boolean)) {
    throw new Error(
      "现有 App Server 不属于 codexc 统一监管入口；请先停止现有 App Server 后重试",
    );
  }
  if (healthy.some(Boolean)) {
    throw new Error(
      "检测到部分 App Server 正在运行，无法安全补启动完整统计代理链路；"
      + "请先停止现有 App Server 后重试",
    );
  }
  const supervisor = spawn(
    process.execPath,
    [join(packageDir, "bin", "codexc.mjs"), "service-app-server"],
    {
      cwd: runtime.dataDir,
      stdio: process.platform === "win32"
        ? ["inherit", "inherit", "inherit", "ipc"]
        : "inherit",
      env: {
        ...process.env,
        CODEX_CONNECT_CONFIG_FILE: runtime.configPath,
      },
    },
  );
  appServerSupervisors.push(supervisor);
  childControls.set(supervisor, createChildServiceControl(supervisor));
  await waitForSocket(supervisor, primaryPath, 10_000, environment, isStopping);
  assertRunning();
  console.log("Codex App Server 与模型统计代理已启动。");
}

async function waitForSocket(child, path, timeoutMs, environment, isStopping) {
  const startedAt = Date.now();
  while (!(await appServerSocketAcceptsWebSocket(path, environment))) {
    if (isStopping()) throw new DevAllStoppedError();
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      if (child.exitCode === 0 || child.signalCode !== null) {
        throw new Error(
          `App Server 在 WebSocket 就绪前退出：exit=${child.exitCode} signal=${child.signalCode}`,
        );
      }
      throw new ReportedChildExitError(child.exitCode ?? 1);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待 Codex App Server WebSocket 就绪超时：${path}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}
