import { spawn } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  appServerSocketAcceptsWebSocket,
  inspectAppServerSupervisor,
  sameAppServerTopology,
} from "../runtime/app-server-supervisor.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  childProcessIsRunning,
  installProcessSignalHandlers,
  signalChildProcesses,
} from "../runtime/process-lifecycle.mjs";
import { packageDir, runtimeConfig } from "./runtime-config.mjs";

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
chmodSync(runtimeDir, 0o700);

const appServerSupervisors = [];
try {
  await ensureAppServerTopology(appServerRuntime.topology);
} catch (error) {
  signalChildProcesses(appServerSupervisors, "SIGTERM");
  throw error;
}

let stopping = false;
let gateway;
const stop = () => {
  if (stopping) {
    signalChildProcesses(appServerSupervisors, "SIGTERM");
    return;
  }
  stopping = true;
  signalChildProcesses(
    [...(gateway ? [gateway] : []), ...appServerSupervisors],
    "SIGTERM",
  );
};
installProcessSignalHandlers({ SIGINT: stop, SIGTERM: stop });

for (const supervisor of appServerSupervisors) {
  supervisor.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`Codex App Server 意外退出：code=${code} signal=${signal}`);
      stop();
      process.exitCode = 1;
    }
  });
}

while (!stopping) {
  gateway = spawn(process.execPath, gatewayEntry, {
    cwd: runtime.dataDir,
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_CONNECT_CONFIG_FILE: runtime.configPath,
      CODEX_CONNECT_GATEWAY_SUPERVISED: "1",
      CODEX_CONNECT_SERVICE_ROLE: "gateway",
    },
  });
  const result = await waitForGateway(gateway);
  gateway = undefined;
  if (stopping) {
    break;
  }
  if (result.code === 75) {
    console.log("Gateway 配置需要重建连接，正在保持 App Server 并重启 Gateway...");
    continue;
  }
  if (result.error) {
    console.error(`Gateway 启动失败：${result.error.message}`);
  }
  process.exitCode = result.code ?? (result.signal || result.error ? 1 : 0);
  stop();
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

async function ensureAppServerTopology(topology) {
  const paths = topology.socketPaths;
  const existingSupervisor = await inspectAppServerSupervisor(socketPath);
  if (existingSupervisor) {
    if (!sameAppServerTopology(existingSupervisor, topology)) {
      throw new Error(
        "现有 App Server Provider 拓扑与当前配置不一致；"
        + "请先运行 codexc service stop all，再重试",
      );
    }
    for (const path of paths) {
      await waitForSocket(undefined, path, 10_000);
      console.log(`检测到现有 App Server Socket，将直接复用：${path}`);
    }
    return;
  }
  const healthy = await Promise.all(paths.map((path) => appServerSocketAcceptsWebSocket(path)));
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
    [join(projectDir, "bin", "codexc.mjs"), "service-app-server"],
    {
      cwd: runtime.dataDir,
      stdio: "inherit",
      env: {
        ...process.env,
        CODEX_CONNECT_CONFIG_FILE: runtime.configPath,
      },
    },
  );
  appServerSupervisors.push(supervisor);
  for (const path of paths) {
    await waitForSocket(supervisor, path, 10_000);
  }
  console.log("Codex App Server 与模型统计代理已启动。");
}

async function waitForSocket(child, path, timeoutMs) {
  const startedAt = Date.now();
  while (!(await appServerSocketAcceptsWebSocket(path))) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `App Server 在 WebSocket 就绪前退出：exit=${child.exitCode} signal=${child.signalCode}`,
      );
    }
    if (Date.now() - startedAt >= timeoutMs) {
      if (childProcessIsRunning(child)) signalChildProcesses([child], "SIGTERM");
      throw new Error(`等待 Codex App Server WebSocket 就绪超时：${path}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}
