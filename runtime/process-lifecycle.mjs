import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Only children spawned as detached process-group leaders may be registered.
// Callers check that the leader is still running before signaling its group.
const childProcessGroups = new WeakSet();

// Control readiness is separate from service readiness: even a starting service
// must be able to accept cancellation. Parents retain commands until this handshake.
export function installServiceControlHandler(handler) {
  const requests = new Map();
  let stopping = false;
  const cancelAll = () => { for (const controller of requests.values()) controller.abort(); };
  const requestStop = (message = { type: "codexc-stop" }) => {
    if (stopping) return;
    stopping = true;
    cancelAll();
    try { void Promise.resolve(handler(message)).catch(() => { process.exitCode = 1; }); }
    catch { process.exitCode = 1; }
  };
  const reply = (id, ok) => {
    if (!process.connected || !process.send) return;
    try { process.send({ type: "codexc-control-result", id, ok }, () => undefined); }
    catch { /* The parent can no longer receive confirmation. */ }
  };
  const listener = (message) => {
    if (message?.type === "codexc-control-cancel") {
      requests.get(message.id)?.abort();
      return;
    }
    if (message?.type === "codexc-stop") {
      requestStop(message);
      return;
    }
    if (message?.type !== "codexc-reload" || typeof message.id !== "string" || message.id.length > 64) return;
    const { id, deadline } = message;
    if (stopping || !Number.isSafeInteger(deadline) || deadline <= Date.now() || requests.has(id) || requests.size >= 32) {
      reply(id, false);
      return;
    }
    const controller = new AbortController();
    requests.set(id, controller);
    const timer = setTimeout(() => controller.abort(), Math.min(deadline - Date.now(), 5_000));
    void Promise.resolve().then(() => {
      if (controller.signal.aborted || Date.now() >= deadline) return false;
      return handler({ type: message.type, deadline, signal: controller.signal });
    }).then(result => reply(id, !controller.signal.aborted && Date.now() < deadline && result !== false), () => reply(id, false))
      .finally(() => { clearTimeout(timer); requests.delete(id); });
  };
  // This is only the spawning parent's Node IPC channel, never an App Server
  // client connection. Losing its owner must close the same owned service.
  const onDisconnect = () => requestStop();
  process.on("message", listener);
  process.on("disconnect", onDisconnect);
  if (process.connected && process.send) {
    try { process.send({ type: "codexc-control-ready" }, () => undefined); }
    catch { /* A disconnected parent cannot receive readiness. */ }
  }
  return () => {
    cancelAll();
    process.off("message", listener);
    process.off("disconnect", onDisconnect);
  };
}

export function createChildServiceControl(child) {
  let ready = false;
  let closed = false;
  let stopping = false;
  const pending = new Map();
  const dispatch = (entry) => {
    if (entry.sent || closed || !ready) return;
    if (Date.now() >= entry.deadline || entry.signal?.aborted) { entry.finish(false); return; }
    entry.sent = true;
    try {
      child.send({ type: entry.type, id: entry.id, deadline: entry.deadline }, (error) => {
        if (error || entry.type === "codexc-stop") entry.finish(!error);
      });
    }
    catch { entry.finish(false); }
  };
  const onMessage = (message) => {
    if (message?.type === "codexc-control-result") {
      const entry = pending.get(message.id);
      if (entry?.sent && entry.type === "codexc-reload") {
        entry.finish(message.ok === true && Date.now() < entry.deadline && !entry.signal?.aborted);
      }
      return;
    }
    if (message?.type !== "codexc-control-ready") return;
    ready = true;
    for (const entry of pending.values()) dispatch(entry);
  };
  const close = () => {
    closed = true;
    child.off("message", onMessage);
    child.off("exit", close);
    child.off("disconnect", close);
    child.off("error", close);
    for (const entry of pending.values()) entry.finish(false);
  };
  child.on("message", onMessage);
  child.once("exit", close);
  child.once("disconnect", close);
  child.once("error", close);
  return {
    send(type, { deadline = Date.now() + 5_000, signal } = {}) {
      if (type !== "codexc-stop" && type !== "codexc-reload") throw new Error("不支持的服务控制消息");
      if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || signal?.aborted) return Promise.resolve(false);
      if (closed || !child.connected || !childProcessIsRunning(child)) return Promise.resolve(false);
      if (type === "codexc-reload" && stopping) return Promise.resolve(false);
      if (type === "codexc-stop") {
        stopping = true;
        for (const entry of pending.values()) if (entry.type === "codexc-reload") entry.finish(false);
        const existing = [...pending.values()].find(entry => entry.type === "codexc-stop");
        if (existing) return existing.promise;
      }
      if (pending.size >= 32) return Promise.resolve(false);
      const id = randomUUID();
      let resolveSend;
      const promise = new Promise(resolve => { resolveSend = resolve; });
      const entry = {
        id, type, deadline, signal, promise, sent: false,
        finish(ok) {
          if (pending.get(id) !== entry) return;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          pending.delete(id);
          if (!ok && entry.sent && type === "codexc-reload" && child.connected) {
            try { child.send({ type: "codexc-control-cancel", id }, () => undefined); }
            catch { /* Disconnection already makes the result unconfirmed. */ }
          }
          resolveSend(ok);
        },
      };
      // A failed handshake/send is bounded; successful delivery never sleeps.
      const abort = () => entry.finish(false);
      const timer = setTimeout(abort, Math.min(deadline - Date.now(), 5_000));
      pending.set(id, entry);
      signal?.addEventListener("abort", abort, { once: true });
      dispatch(entry);
      return promise;
    },
    close,
  };
}

export function registerChildProcessGroup(child) {
  if (process.platform === "win32") {
    throw new Error("独立子进程组只支持 Unix");
  }
  childProcessGroups.add(child);
}

export class ReportedChildExitError extends Error {
  constructor(exitCode, message = `子命令执行失败：exit=${exitCode}`) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class ForwardedChildSignalError extends Error {
  constructor(signal) {
    super(`子命令被信号终止：${signal}`);
    this.signal = signal;
  }
}

export function assertSynchronousChildSuccess(result, {
  failureMessage = (exitCode) => `子命令执行失败：exit=${exitCode}`,
  failureReportedByChild = false,
  signalTarget = process,
} = {}) {
  if (result.error) throw result.error;
  if (result.signal) {
    signalTarget.kill(signalTarget.pid, result.signal);
    throw new ForwardedChildSignalError(result.signal);
  }
  if (result.status !== 0) {
    const exitCode = result.status ?? 1;
    if (failureReportedByChild) {
      throw new ReportedChildExitError(exitCode, failureMessage(exitCode));
    }
    throw new Error(failureMessage(exitCode));
  }
}

export function childProcessIsRunning(child) {
  return child !== undefined
    && child.exitCode === null
    && child.signalCode === null;
}

export function signalChildProcesses(children, signal) {
  for (const child of children) {
    if (!childProcessIsRunning(child)) continue;
    if (process.platform === "win32" && windowsTreeTerminationSignal(signal)) {
      const force = signal === "SIGKILL";
      const signaled = signalWindowsProcessTree(child, force);
      if (!signaled && !force && childProcessIsRunning(child)) {
        signalWindowsProcessTree(child, true);
      }
      continue;
    }
    signalChildProcess(child, signal);
  }
}

export async function terminateChildProcess(child, {
  gracePeriodMs = 5_000,
  forcePeriodMs = 1_000,
} = {}) {
  if (!childProcessIsRunning(child)) return;
  if (process.platform === "win32") {
    const signaled = signalWindowsProcessTree(child, false);
    if (!signaled && childProcessIsRunning(child)) {
      signalWindowsProcessTree(child, true);
      if (await childExitedWithin(child, forcePeriodMs)) return;
      throw new Error("子进程在强制终止后仍未退出");
    }
  } else {
    signalChildProcess(child, "SIGTERM");
  }
  if (await childExitedWithin(child, gracePeriodMs)) return;
  if (childProcessIsRunning(child)) {
    if (process.platform === "win32") {
      signalWindowsProcessTree(child, true);
    } else {
      signalChildProcess(child, "SIGKILL");
    }
  }
  if (await childExitedWithin(child, forcePeriodMs)) return;
  throw new Error("子进程在强制终止后仍未退出");
}

function signalChildProcess(child, signal) {
  if (!childProcessGroups.has(child) || child.pid === undefined) {
    return child.kill(signal);
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function installProcessSignalHandlers(handlers, source = process) {
  const entries = Object.entries(handlers).filter((entry) =>
    typeof entry[1] === "function");
  for (const [signal, handler] of entries) source.on(signal, handler);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    for (const [signal, handler] of entries) source.off(signal, handler);
  };
}

function childExitedWithin(child, timeoutMs) {
  if (!childProcessIsRunning(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let timer;
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      resolveWait(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    if (!childProcessIsRunning(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(!childProcessIsRunning(child)), timeoutMs);
  });
}

function windowsTreeTerminationSignal(signal) {
  return signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGKILL";
}

function signalWindowsProcessTree(child, force) {
  if (child.pid === undefined) {
    return child.kill(force ? "SIGKILL" : "SIGTERM");
  }
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot) {
    throw new Error("Windows 进程树终止需要 SystemRoot");
  }
  const result = spawnSync(
    join(systemRoot, "System32", "taskkill.exe"),
    ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
    { stdio: "ignore", windowsHide: true, timeout: 2_000 },
  );
  if (result.error?.code === "ETIMEDOUT") {
    throw Object.assign(new Error(`Windows 子进程树终止超过 2 秒，尚未确认全部退出：pid=${child.pid}`), {
      code: "ETIMEDOUT",
    });
  }
  if (result.error) throw result.error;
  if (result.status !== 0 && !windowsProcessExists(child.pid)) {
    return true;
  }
  if (force && result.status !== 0 && childProcessIsRunning(child)) {
    throw new Error(`Windows 子进程树终止失败：pid=${child.pid} exit=${result.status ?? 1}`);
  }
  return result.status === 0;
}

function windowsProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
