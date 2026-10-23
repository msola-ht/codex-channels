import { spawn } from "node:child_process";
import { ownedProcessInvocation } from "./owned-process.mjs";
import { supervisedCliInvocation } from "./owned-command-worker.mjs";
import { registerChildProcessGroup, terminateChildProcess } from "./process-lifecycle.mjs";

const runners = new Set();
let closing = false;

export async function closeOwnedCommandRunners() {
  closing = true;
  const results = await Promise.allSettled([...runners].map(runner => runner.close()));
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "自有辅助命令关闭未确认");
}

export function waitForOwnedCommandRunnersExit() {
  return Promise.all([...runners].map(runner => runner.waitForExit())).then(() => undefined);
}

export class OwnedCommandError extends Error {
  constructor(reason, options) {
    super(`自有辅助命令未完成：${reason}`, options);
    this.reason = reason;
  }
}

/** Bounded operations retain their child owner until physical cleanup is confirmed. */
export class OwnedCommandRunner {
  #closed = false;
  #entries = new Set();
  constructor() { runners.add(this); }

  run(invocation, { timeoutMs, signal, input, environment = process.env, maxOutputBytes = 65_536 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      return Promise.reject(new OwnedCommandError("invalid-budget"));
    }
    if (closing || this.#closed || signal?.aborted) return Promise.reject(new OwnedCommandError("cancelled"));
    if (this.#entries.size >= 32) return Promise.reject(new OwnedCommandError("overloaded"));
    let child;
    try {
      const owned = supervisedCliInvocation(ownedProcessInvocation(invocation, environment), { forwardInput: input !== undefined });
      child = spawn(owned.file, owned.args, {
        env: environment, detached: process.platform !== "win32", windowsHide: true,
        windowsVerbatimArguments: owned.windowsVerbatimArguments,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      if (process.platform !== "win32") registerChildProcessGroup(child);
    } catch { return Promise.reject(new OwnedCommandError("spawn")); }
    let accept, reject;
    const promise = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
    let confirmExit;
    const exited = new Promise(resolve => { confirmExit = resolve; });
    const entry = { promise, exited, cancel: () => finish("cancelled") };
    this.#entries.add(entry);
    let stdout = [], stderr = [], outputBytes = 0, finished = false, timer;
    const forget = () => {
      this.#entries.delete(entry);
      confirmExit();
      if (this.#closed && this.#entries.size === 0) runners.delete(this);
    };
    const confirmLater = () => {
      // Once the leader exited, terminateChildProcess only observes its registered
      // group. Never signal a numeric group ID after its leader may be recycled.
      const observe = async () => {
        try { await terminateChildProcess(child, { gracePeriodMs: 0, forcePeriodMs: 0 }); forget(); }
        catch { setTimeout(observe, 100); }
      };
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) void observe();
      else child.once("close", () => { void observe(); });
    };
    const finish = (reason, code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void (async () => {
        let cleanupFailed = false;
        try {
          // Separate cleanup allowance: Windows tree termination can add two
          // bounded taskkill calls to grace + final confirmation.
          await terminateChildProcess(child, { gracePeriodMs: 500, forcePeriodMs: 1_000 });
          forget();
        } catch { cleanupFailed = true; confirmLater(); }
        if (cleanupFailed) reject(new OwnedCommandError("cleanup-unconfirmed", {
          ...(reason ? { cause: new OwnedCommandError(reason) } : {}),
        }));
        else if (reason) reject(new OwnedCommandError(reason));
        else accept({ status: code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
        stdout = []; stderr = [];
      })();
    };
    const abort = () => finish("cancelled");
    const collect = destination => chunk => {
      if (finished) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { finish("output-limit"); return; }
      destination.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", () => finish("spawn"));
    child.once("close", code => finish(undefined, code));
    child.stdin?.on("error", () => finish("stdin"));
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (!finished && input !== undefined) child.stdin.end(input);
    return promise;
  }

  cancel() {
    this.#closed = true;
    for (const entry of this.#entries) entry.cancel();
    if (this.#entries.size === 0) runners.delete(this);
  }

  async close() {
    this.cancel();
    await Promise.allSettled([...this.#entries].map(entry => entry.promise));
    if (this.#entries.size) throw new OwnedCommandError("cleanup-unconfirmed");
    // Cancelled operations are expected during close; ownership is the criterion.
  }

  waitForExit() {
    return Promise.all([...this.#entries].map(entry => entry.exited)).then(() => undefined);
  }
}
