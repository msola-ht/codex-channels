import { spawn } from "node:child_process";
import {
  closeSync,
  openSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PrivateIpcServer,
} from "../runtime/private-ipc.mjs";
import {
  childProcessIsRunning,
  installProcessSignalHandlers,
  terminateChildProcess,
} from "../runtime/process-lifecycle.mjs";
import {
  readPrivateFileSync,
  securePrivateFileSync,
} from "../runtime/private-file.mjs";

const definitionLimitBytes = 64 * 1024;
const requestLimitBytes = 1_024;
const gracefulStopTimeoutMs = 10_000;

export async function runWindowsServiceHost(definitionPath) {
  if (process.platform !== "win32") {
    throw new Error("Windows 服务宿主只支持 Windows");
  }
  const definition = readDefinition(definitionPath);
  let stdout;
  let stderr;
  let child;
  let server;
  let cleanupSignals;
  let stopping = false;
  let stopPromise;
  let reportStopFailure;
  const stopFailure = new Promise((resolveFailure) => { reportStopFailure = resolveFailure; });
  let operationError;
  const cleanupErrors = [];
  const stop = () => {
    stopping = true;
    stopPromise ??= stopChild(child);
    // Signal and IPC callbacks cannot await, but the owner below observes failure.
    void stopPromise.catch((error) => reportStopFailure({ error }));
    return stopPromise;
  };
  try {
    stdout = openPrivateLog(definition.stdoutLog);
    stderr = openPrivateLog(definition.stderrLog);
    child = spawn(definition.nodeBinary, definition.arguments, {
      cwd: definition.workingDirectory,
      env: { ...process.env, ...definition.environment },
      stdio: ["ignore", stdout, stderr, "ipc"],
      windowsHide: true,
    });
    const resultPromise = childResult(child);
    server = new PrivateIpcServer(definition.controlPath, (socket) => {
      handleControlConnection(socket, definition, child, stop);
    });
    cleanupSignals = installProcessSignalHandlers({
      SIGINT: () => void stop(),
      SIGTERM: () => void stop(),
    });
    await server.start(`${definition.displayName} Windows 服务宿主已在运行`);
    const result = await Promise.race([resultPromise, stopFailure]);
    if (stopPromise) await stopPromise;
    if (result.error) throw result.error;
    if (!stopping && (result.code !== 0 || result.signal)) {
      throw new Error(
        `${definition.displayName} 意外退出：${result.signal ? `signal=${result.signal}` : `exit=${result.code ?? 1}`}`,
      );
    }
  } catch (error) {
    operationError = error;
  } finally {
    cleanupSignals?.();
    try { if (childProcessIsRunning(child)) await stop(); }
    catch (error) { cleanupErrors.push(error); }
    try { await server?.close(); }
    catch (error) { cleanupErrors.push(error); }
    for (const descriptor of [stdout, stderr]) {
      try { if (descriptor !== undefined) closeSync(descriptor); }
      catch (error) { cleanupErrors.push(error); }
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([
      ...(operationError === undefined ? [] : [operationError]), ...cleanupErrors,
    ], "Windows 服务宿主失败且资源清理未完成", { cause: operationError ?? cleanupErrors[0] });
  }
  if (operationError !== undefined) throw operationError;
}

function handleControlConnection(socket, definition, child, stop) {
  const chunks = [];
  let bytes = 0;
  let handled = false;
  socket.on("error", () => undefined);
  socket.setTimeout(2_000, () => socket.destroy());
  socket.on("data", (chunk) => {
    if (handled) return;
    bytes += chunk.length;
    if (bytes > requestLimitBytes) {
      socket.destroy();
      return;
    }
    chunks.push(chunk);
    if (!chunk.includes(0x0a)) return;
    handled = true;
    socket.pause();
    let request;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
    } catch {
      socket.destroy();
      return;
    }
    if (request?.action === "inspect") {
      socket.end(`${JSON.stringify({
        version: 1,
        target: definition.target,
        pid: process.pid,
        childPid: child.pid ?? null,
        running: childProcessIsRunning(child),
      })}\n`);
      return;
    }
    if (request?.action === "reload" && definition.target === "gateway") {
      const sent = sendControlMessage(child, { type: "codexc-reload" });
      socket.end(`${JSON.stringify({ version: 1, ok: sent })}\n`);
      return;
    }
    if (request?.action === "stop") {
      socket.end(`${JSON.stringify({ version: 1, ok: true })}\n`);
      void stop();
      return;
    }
    socket.end(`${JSON.stringify({ version: 1, ok: false })}\n`);
  });
  socket.on("end", () => {
    if (!handled) socket.end();
  });
}

async function stopChild(child) {
  if (!childProcessIsRunning(child)) return;
  if (sendControlMessage(child, { type: "codexc-stop" })) {
    if (await childExitedWithin(child, gracefulStopTimeoutMs)) return;
  }
  await terminateChildProcess(child);
}

function sendControlMessage(child, message) {
  if (!child.connected || !childProcessIsRunning(child)) return false;
  try {
    child.send(message);
    return true;
  } catch {
    return false;
  }
}

function childResult(child) {
  return new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({ error }));
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
}

function childExitedWithin(child, timeoutMs) {
  if (!childProcessIsRunning(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveWait(!childProcessIsRunning(child));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveWait(true);
    };
    child.once("exit", onExit);
  });
}

function openPrivateLog(path) {
  const descriptor = openSync(path, "a", 0o600);
  try { securePrivateFileSync(path); }
  catch (error) { closeSync(descriptor); throw error; }
  return descriptor;
}

function readDefinition(path) {
  let definition;
  try {
    definition = JSON.parse(readPrivateFileSync(resolve(path), definitionLimitBytes));
  } catch (error) {
    throw new Error(`Windows 服务定义无效：${path}`, { cause: error });
  }
  if (
    definition?.version !== 1
    || !["gateway", "app-server", "webui", "model-relay"].includes(definition.target)
    || typeof definition.displayName !== "string"
    || typeof definition.nodeBinary !== "string"
    || !Array.isArray(definition.arguments)
    || !definition.arguments.every((value) => typeof value === "string")
    || typeof definition.workingDirectory !== "string"
    || !definition.environment
    || typeof definition.environment !== "object"
    || Array.isArray(definition.environment)
    || typeof definition.controlPath !== "string"
    || typeof definition.stdoutLog !== "string"
    || typeof definition.stderrLog !== "string"
  ) {
    throw new Error(`Windows 服务定义无效：${path}`);
  }
  return definition;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("用法：windows-service-host.mjs <服务定义路径>");
    }
    await runWindowsServiceHost(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
