import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "dotenv";
import WebSocket from "ws";
import { readWorkspaceConfig } from "./workspace-config.mjs";

const projectDir = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const env = parse(readFileSync(join(projectDir, ".env")));
const { defaultWorkspace } = readWorkspaceConfig(env);
const workdir = defaultWorkspace.cwd;
const socketPath = resolve(env.CODEX_SOCKET_PATH || join(projectDir, ".runtime/codex-app-server.sock"));
const runtimeDir = dirname(socketPath);
const codexBinary = resolveExecutable(env.CODEX_BINARY || "codex");
const tsxEntry = join(projectDir, "node_modules", "tsx", "dist", "cli.mjs");

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

const gateway = spawn(process.execPath, [tsxEntry, "gateway/src/main.ts"], {
  cwd: projectDir,
  stdio: "inherit",
  env: process.env,
});

let stopping = false;
const stop = () => {
  if (stopping) {
    return;
  }
  stopping = true;
  if (gateway.exitCode === null) {
    gateway.kill("SIGTERM");
  }
  if (ownsAppServer && appServer?.exitCode === null) {
    appServer.kill("SIGTERM");
  }
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

gateway.once("error", (error) => {
  console.error(`Gateway 启动失败：${error.message}`);
  stop();
});
gateway.once("exit", (code, signal) => {
  stop();
  process.exitCode = code ?? (signal ? 1 : 0);
});
if (appServer) {
  appServer.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`Codex App Server 意外退出：code=${code} signal=${signal}`);
      stop();
      process.exitCode = 1;
    }
  });
}

await new Promise((resolveExit) => gateway.once("exit", resolveExit));

function resolveExecutable(command) {
  if (isAbsolute(command)) {
    return realpathSync(command);
  }
  return execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim();
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
