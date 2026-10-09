import { spawn } from "node:child_process";
import { Worker, parentPort, workerData } from "node:worker_threads";

const timeoutMs = 2_000;
const startupTimeoutMs = 5_000;
const maximumPending = 16;
let worker;
let nextId = 0;
const pending = new Set();
const readyWorkers = new WeakSet();
let operationDeadline;

/** Bound synchronous ACL work by its owning operation's absolute deadline. */
export function withWindowsAclDeadline(deadline, operation) {
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw fail("ETIMEDOUT");
  const previous = operationDeadline;
  operationDeadline = previous === undefined ? deadline : Math.min(previous, deadline);
  try { return operation(); }
  finally { operationDeadline = previous; }
}

function fail(code) {
  return Object.assign(new Error("Windows ACL helper failed"), { code });
}

function request(invocation, input, maximumBytes) {
  if (operationDeadline !== undefined && operationDeadline <= Date.now()) throw fail("ETIMEDOUT");
  if (pending.size >= maximumPending) throw fail("EBUSY");
  if (!worker) {
    const instance = new Worker(new URL(import.meta.url), {
      workerData: { windowsAclBridge: true, invocation }, execArgv: [],
    });
    worker = instance;
    const stopped = () => {
      if (worker === instance) worker = undefined;
      for (const entry of pending) {
        if (entry.worker === instance && Atomics.compareExchange(entry.state, 0, 0, -1) === 0) Atomics.notify(entry.state, 0);
      }
    };
    instance.on("error", stopped);
    instance.on("exit", stopped);
    instance.unref();
  }
  const state = new Int32Array(new SharedArrayBuffer(8));
  const output = new Uint8Array(new SharedArrayBuffer(maximumBytes));
  const maximumBudget = readyWorkers.has(worker) ? timeoutMs : startupTimeoutMs;
  const budget = operationDeadline === undefined ? maximumBudget : Math.max(0, Math.min(maximumBudget, operationDeadline - Date.now()));
  const entry = { id: ++nextId, state, output, worker, asynchronous: false, budget };
  pending.add(entry);
  worker.postMessage({ id: entry.id, input, state, output, deadline: Date.now() + budget });
  return entry;
}

function finish(entry, waitResult) {
  pending.delete(entry);
  const status = Atomics.load(entry.state, 0);
  if (status === -4) throw fail("ECANCELED");
  if (waitResult === "timed-out" || status !== 1) {
    // Do not reuse a helper whose request may still be in flight.
    entry.worker.postMessage({ stop: true });
    if (worker === entry.worker) worker = undefined;
    throw fail(waitResult === "timed-out" || status === -2 ? "ETIMEDOUT" : status === -3 ? "ENOBUFS" : status === -5 ? "ERR_WINDOWS_NATIVE_LOAD" : "EIO");
  }
  const length = Atomics.load(entry.state, 1);
  if (length < 0 || length > entry.output.length) throw fail("ENOBUFS");
  readyWorkers.add(entry.worker);
  return Buffer.from(entry.output.subarray(0, length)).toString("utf8");
}

/** Reuse a process, never an ACL verdict. Every request inspects the current path. */
export function invokeWindowsAclSync(invocation, input, maximumBytes) {
  const entry = request(invocation, input, maximumBytes);
  return finish(entry, Atomics.wait(entry.state, 0, 0, entry.budget + 100));
}

export async function invokeWindowsAcl(invocation, input, maximumBytes, signal) {
  signal?.throwIfAborted();
  const entry = request(invocation, input, maximumBytes);
  entry.asynchronous = true;
  entry.worker.ref();
  const cancel = () => entry.worker.postMessage({ cancel: entry.id });
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const waiting = Atomics.waitAsync(entry.state, 0, 0, entry.budget + 100);
    const result = finish(entry, await waiting.value);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (![...pending].some(other => other.worker === entry.worker && other.asynchronous)) entry.worker.unref();
  }
}

if (workerData?.windowsAclBridge === true) {
  const invocation = workerData.invocation;
  const child = spawn(invocation.file, [...invocation.args, "-Persistent"], {
    stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const queue = [];
  let current;
  let timer;
  let chunks = [];
  let length = 0;
  let stopped = false;
  const respond = (entry, status, bytes) => {
    if (bytes) {
      entry.output.set(bytes);
      Atomics.store(entry.state, 1, bytes.length);
    }
    Atomics.store(entry.state, 0, status);
    Atomics.notify(entry.state, 0);
  };
  const stop = (status) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    child.kill();
    if (current) respond(current, status);
    for (const entry of queue) respond(entry, status);
    current = undefined;
    queue.length = 0;
    parentPort.close();
  };
  const next = () => {
    if (current || stopped) return;
    current = queue.shift();
    if (!current) return;
    const remaining = current.deadline - Date.now();
    if (remaining <= 0) { stop(-2); return; }
    chunks = [];
    length = 0;
    timer = setTimeout(() => stop(-2), remaining);
    child.stdin.write(`${JSON.stringify(current.input)}\n`);
  };
  child.on("error", () => stop(-1));
  // Wait for closed streams so an early stdin EPIPE cannot mask the reserved
  // native-loader failure code. Other failures still use bounded request time.
  child.on("close", (code) => stop(code === 78 ? -5 : -1));
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop(-1); });
  child.stdout.on("data", (chunk) => {
    if (!current || stopped) { stop(-1); return; }
    length += chunk.length;
    if (length > current.output.length) { stop(-3); return; }
    chunks.push(chunk);
    if (chunk.includes(10)) {
      const response = Buffer.concat(chunks, length);
      if (response.indexOf(10) !== response.length - 1) { stop(-1); return; }
      clearTimeout(timer);
      respond(current, current.cancelled ? -4 : 1, current.cancelled ? undefined : response);
      current = undefined;
      next();
    }
  });
  parentPort.on("message", (message) => {
    if (message.stop) { stop(-2); return; }
    if (message.cancel) {
      // Drain an in-flight read before releasing its slot and locked file handle.
      // Its original deadline remains in force; cancellation never kills peers.
      if (current?.id === message.cancel) current.cancelled = true;
      else {
        const index = queue.findIndex(entry => entry.id === message.cancel);
        if (index >= 0) respond(queue.splice(index, 1)[0], -4);
      }
      return;
    }
    if (stopped) { respond(message, -1); return; }
    if (queue.length >= maximumPending) { respond(message, -1); return; }
    queue.push(message);
    next();
  });
  parentPort.on("close", () => { child.kill(); });
}
