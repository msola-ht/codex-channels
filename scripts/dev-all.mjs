import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

import WebSocket from "ws";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { packageDir, resolveConfiguredPath, runtimeConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const projectDir = packageDir;
const runtime = runtimeConfig();
const document = readGatewayConfig(runtime.configPath);
const codex = table(document.codex);
const { defaultWorkspace } = readWorkspaceConfig(document);
const workdir = defaultWorkspace.cwd;
const socketPath = resolveConfiguredPath(
  stringValue(codex.socket_path),
  runtime.dataDir,
  join(runtime.dataDir, "runtime", "codex-app-server.sock"),
);
const runtimeDir = dirname(socketPath);
const codexBinary = resolveExecutable(stringValue(codex.binary) || "codex");
const gatewayEntry = process.env.CODEX_CONNECT_GATEWAY_ENTRY === "dist"
  ? [join(projectDir, "dist/main.js")]
  : [join(projectDir, "node_modules", "tsx", "dist", "cli.mjs"), "src/main.ts"];

mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
chmodSync(runtimeDir, 0o700);

let appServer;
let ownsAppServer = false;
if (await socketAcceptsWebSocket(socketPath)) {
  console.log(`检测到现有 App Server Socket，将直接复用：${socketPath}`);
} else {
  preserveStaleSocket(socketPath, runtimeDir);
  ownsAppServer = true;
  appServer = spawn(codexBinary, ["app-server", "--listen", `unix://${socketPath}`], {
    cwd: workdir,
    stdio: "inherit",
  });
  await waitForSocket(appServer, socketPath, 10_000);
  console.log(`Codex App Server 已启动：${socketPath}`);
}

let stopping = false;
let gateway;
const stop = () => {
  if (stopping) {
    return;
  }
  stopping = true;
  if (gateway?.exitCode === null) {
    gateway.kill("SIGTERM");
  }
  if (ownsAppServer && appServer?.exitCode === null) {
    appServer.kill("SIGTERM");
  }
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

if (appServer) {
  appServer.once("exit", (code, signal) => {
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

function resolveExecutable(command) {
  if (isAbsolute(command)) {
    return realpathSync(command);
  }
  return execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim();
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function waitForSocket(child, path, timeoutMs) {
  const startedAt = Date.now();
  while (!existsSync(path)) {
    if (child.exitCode !== null) {
      throw new Error(`Codex App Server 启动失败：exit=${child.exitCode}`);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      child.kill("SIGTERM");
      throw new Error(`等待 Codex App Server Socket 超时：${path}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function socketAcceptsWebSocket(path) {
  if (!existsSync(path)) {
    return false;
  }
  return new Promise((resolveCheck) => {
    const socket = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      createConnection: () => createConnection(path),
    });
    let settled = false;
    const finish = (healthy) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      } else {
        socket.terminate();
      }
      resolveCheck(healthy);
    };
    const timer = setTimeout(() => finish(false), 1_500);
    socket.once("open", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function preserveStaleSocket(path, directory) {
  if (!existsSync(path)) {
    return;
  }
  try {
    const preserved = join(directory, `codex-app-server.stale-${Date.now()}.sock`);
    renameSync(path, preserved);
    console.warn(`检测到无效 Socket，已保留为：${preserved}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}
