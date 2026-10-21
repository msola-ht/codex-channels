import { serviceCommandTarget } from "../runtime/service-targets.mjs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { webuiLogger } from "./webui-logger.mjs";
import { supervisedCliInvocation } from "./cli-command-worker.mjs";

import { isPrunableMetricsProviderId } from "./metrics-command-options.mjs";
import { ownedProcessInvocation } from "../runtime/owned-process.mjs";
import { registerChildProcessGroup, terminateChildProcess } from "../runtime/process-lifecycle.mjs";

const targets = new Set(["gateway", "app-server", "webui", "model-relay", "all"]);
const serviceActions = new Set(["install", "uninstall", "start", "stop", "reload", "restart"]);
const maintenanceActions = new Set(["cleanup", "prune", "reset"]);
const metricsRequireStoppedGateway = new Set(["cleanup", "reset"]);
const maximumTaskHistory = 32;
const defaultCancellationGraceMs = 10_000;

export class ManagementTaskInputError extends Error {}

export class WebuiManagementTaskRunner {
  #tasks = new Map();
  #now;
  #onEvent;
  #listeners = new Set();
  #cancellationGraceMs;
  #closed = false;
  #closeTask;
  constructor({ now = Date.now, onEvent = null, cancellationGraceMs = defaultCancellationGraceMs } = {}) {
    this.#now = now;
    this.#onEvent = typeof onEvent === "function" ? onEvent : null;
    if (!Number.isSafeInteger(cancellationGraceMs) || cancellationGraceMs <= 0) {
      throw new Error("任务取消宽限期无效");
    }
    this.#cancellationGraceMs = cancellationGraceMs;
  }

  preview(input) {
    const normalized = normalizeTaskInput(input);
    const command = normalized.operation === "service"
      ? `codexc ${serviceTaskArguments(normalized).join(" ")}`
      : normalized.operation === "traffic"
        ? "codexc cleanup traffic --confirm"
        : `codexc ${metricsTaskArguments(normalized).join(" ")}`;
    const metrics = normalized.operation === "metrics";
    const traffic = normalized.operation === "traffic";
    return {
      operation: normalized.operation,
      action: normalized.action,
      target: normalized.target ?? null,
      effects: [`执行 ${command}`],
      preconditions: traffic
        ? ["全部 App Server 与 Relay 必须已停止"]
        : metrics && metricsRequireStoppedGateway.has(normalized.action)
          ? ["Gateway 必须已停止，且指标 Socket 不可用"]
          : [],
      recovery: traffic
        ? "traffic_irreversible"
        : metrics
        ? normalized.action === "prune"
          ? "metrics_restore"
          : "metrics_backup"
        : "service_check",
      activation: traffic
        ? "不会自动启动已停止的 App Server"
        : metrics && normalized.action === "prune"
        ? "按操作前状态恢复 Gateway"
        : metrics
          ? "不会自动启动已停止的 Gateway"
          : "由服务管理器直接应用",
      requiresConfirmation: true,
    };
  }

  start(input, { owner, environment = process.env, auditMetadata = null, trafficConfirmation = null } = {}) {
    if (this.#closed) throw new ManagementTaskInputError("管理任务正在停止，不再接受新任务");
    const normalized = normalizeTaskInput(input);
    if (normalized.operation === "traffic" && (!trafficConfirmation
      || typeof trafficConfirmation.directory !== "string"
      || !/^[a-f0-9]{64}$/u.test(trafficConfirmation.fingerprint))) {
      throw new ManagementTaskInputError("调用记录清理缺少已确认范围");
    }
    this.#pruneTerminalTasks();
    if (this.#tasks.size >= maximumTaskHistory) throw new ManagementTaskInputError("管理任务数量已达上限，请先等待当前任务结束");
    if ([...this.#tasks.values()].some((task) => task.owner === owner
      && (task.cleanupPending || ["queued", "running", "cancelling"].includes(task.state)))) {
      throw new ManagementTaskInputError("已有管理任务运行中，请等待完成或取消后重试");
    }
    const id = randomUUID();
    const task = {
      id,
      owner,
      operation: normalized.operation,
      action: normalized.action,
      target: normalized.target ?? null,
      state: "queued",
      createdAt: new Date(this.#now()).toISOString(),
      updatedAt: new Date(this.#now()).toISOString(),
      error: null,
      result: null,
      errorCode: null,
      process: null,
      cancelTask: null,
      cancelFailed: false,
      cleanupPending: false,
      auditMetadata,
      auditStatus: null,
    };
    this.#tasks.set(id, task);
    this.#emitAudit(task, "started", "queued", "retry-task");
    this.#notify(task);
    // The runner must never leak a rejected promise into the WebUI process.
    // Resolution failures (missing executable, invalid Windows shell, etc.)
    // are represented as a failed task instead.
    task.run = Promise.resolve()
      .then(() => this.#run(task, normalized, environment, trafficConfirmation))
      .catch((error) => this.#fail(task, error));
    return publicTask(task);
  }

  close() {
    this.#closed = true;
    this.#closeTask ??= (async () => {
      const tasks = [...this.#tasks.values()];
      for (const task of tasks) this.cancel(task.id, task.owner);
      await Promise.all(tasks.map(task => task.cancelTask));
      if (tasks.some(task => task.cancelFailed)) throw new Error("管理任务退出未确认，保留自有进程归属");
      await Promise.all(tasks.map(task => task.run));
    })();
    return this.#closeTask;
  }

  async waitForExit() {
    await Promise.all([...this.#tasks.values()].map(task => task.run));
    for (const task of this.#tasks.values()) {
      // A failed group termination remains owned even after its leader exits.
      while (task.cleanupPending) {
        try {
          await terminateChildProcess(task.process, { gracePeriodMs: this.#cancellationGraceMs });
          task.cleanupPending = false;
          task.process = null;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
    }
  }

  get(id, owner) {
    const task = this.#tasks.get(id);
    if (!task || task.owner !== owner) return null;
    return publicTask(task);
  }

  list(owner) {
    return [...this.#tasks.values()].filter((task) => task.owner === owner).map(publicTask);
  }

  watch(owner, signal, receive) {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let heartbeat;
      const cleanup = () => {
        clearInterval(heartbeat);
        this.#listeners.delete(listener);
        signal.removeEventListener("abort", close);
      };
      const close = () => { cleanup(); resolve(); };
      const send = (type) => {
        try { receive(type); } catch (error) { cleanup(); reject(error); }
      };
      const listener = { owner, notify: () => send("changed") };
      this.#listeners.add(listener);
      signal.addEventListener("abort", close, { once: true });
      heartbeat = setInterval(() => send("heartbeat"), 15_000);
      heartbeat.unref?.();
      // Subscribe before the initial invalidation so reads cannot miss a transition.
      send("changed");
    });
  }

  #notify(task) {
    for (const listener of this.#listeners) {
      if (listener.owner === task.owner) listener.notify();
    }
  }

  cancel(id, owner) {
    const task = this.#tasks.get(id);
    if (!task || task.owner !== owner) return null;
    if (task.state === "cancelling") return publicTask(task);
    if (task.state === "queued") {
      task.state = "cancelled";
      task.result = { commitState: "not_started", failurePhases: [] };
      task.updatedAt = new Date(this.#now()).toISOString();
      this.#emitTerminal(task, "cancelled", "cancelled", "none");
    } else if ((task.state === "running" || task.cleanupPending) && task.process) {
      task.state = "cancelling";
      task.error = null;
      task.cancelFailed = false;
      task.updatedAt = new Date(this.#now()).toISOString();
      task.cancelTask = new Promise(resolve => {
        const child = task.process;
        const finished = () => {
          clearTimeout(timer);
          child.off("close", finished);
          task.cleanupPending = false;
          if (task.exited) {
            task.process = null;
            task.state = "failed";
            task.error = "任务进程已退出，请核对实际执行结果后再操作";
            task.errorCode = "result_unconfirmed";
            task.updatedAt = new Date(this.#now()).toISOString();
            this.#notify(task);
          }
          resolve(true);
        };
        const timer = setTimeout(async () => {
          child.off("close", finished);
          task.cancelFailed = true;
          task.cleanupPending = true;
          try {
            // Every task controller inherits this owned group/Job. Escalation
            // never targets independently supervised services themselves.
            await terminateChildProcess(child, { gracePeriodMs: 0 });
            task.cleanupPending = false;
          } catch { /* Keep ownership until actual exit can be confirmed. */ }
          if (task.state === "cancelling") {
            // Retain ownership and block overlapping tasks until the child exits.
            // Returning to running makes cancellation retryable without inventing success.
            task.state = "running";
            task.error = "取消未完成，进程状态尚未确认；可重试取消，请勿重复执行任务";
            task.errorCode = "cancellation_unconfirmed";
            task.updatedAt = new Date(this.#now()).toISOString();
            this.#notify(task);
          }
          webuiLogger.error({ event: "task.cancel_failed", taskId: task.id }, "管理任务取消未完成");
          resolve(false);
        }, this.#cancellationGraceMs);
        child.once("close", finished);
        // Give commit/recovery a cooperative grace period before the bounded
        // tree-wide escalation. An interrupted operation requires readback.
        if (child.exitCode !== null || child.signalCode !== null) {
          terminateChildProcess(child, { gracePeriodMs: 0 }).then(finished, () => {});
        } else if (!child.stdin.destroyed) child.stdin.write("cancel\n", () => {});
      });
      this.#notify(task);
    }
    return publicTask(task);
  }

  async #run(task, normalized, environment, trafficConfirmation) {
    if (task.state !== "queued") return;
    task.state = "running";
    task.updatedAt = new Date(this.#now()).toISOString();
    this.#notify(task);
    // Invoke the package's maintenance entry directly: an extra CLI launcher
    // would create a detached child outside this runner's Unix process group.
    const resultNonce = randomUUID();
    const args = [fileURLToPath(new URL("./webui-management-task-command.mjs", import.meta.url)), JSON.stringify(normalized), resultNonce,
      ...(normalized.operation === "traffic" ? ["--confirm", "--dir", trafficConfirmation.directory,
        "--expected-fingerprint", trafficConfirmation.fingerprint] : [])];
    const invocation = supervisedCliInvocation(ownedProcessInvocation({ file: process.execPath, args }, environment), { forwardInput: true });
    await new Promise((resolve) => {
      const child = spawn(invocation.file, invocation.args, {
        env: { ...environment, CODEX_CONNECT_MANAGEMENT_TASK: "1" },
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      if (process.platform !== "win32") registerChildProcessGroup(child);
      task.process = child;
      child.stdin.on("error", () => {});
      let outcome = null;
      let pendingLine = "";
      let discardingLine = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        for (const part of chunk.split(/(?<=\n)/u)) {
          if (!discardingLine && pendingLine.length + part.length <= 4_096) pendingLine += part;
          else { discardingLine = true; pendingLine = ""; }
          if (!part.endsWith("\n")) continue;
          if (!discardingLine) outcome = parseTaskOutcome(pendingLine, resultNonce) ?? outcome;
          pendingLine = "";
          discardingLine = false;
        }
      });
      let settled = false;
      const finish = (state, error, resultCode, recovery) => {
        if (settled) return;
        settled = true;
        task.cancelTask = null;
        if (!task.cleanupPending) task.process = null;
        task.state = state;
        task.error = error === null ? null : sanitizeTaskText(error);
        if (task.result === null) task.result = { commitState: "not_started", failurePhases: [] };
        task.updatedAt = new Date(this.#now()).toISOString();
        this.#emitTerminal(task, state, resultCode, recovery);
        resolve();
      };
      child.once("error", () => {
        task.errorCode = "start_failed";
        // Do not expose the platform error text: it can contain executable
        // paths or environment-specific details that are not actionable here.
        finish("failed", "任务启动失败", "failed", "retry-task");
      });
      child.once("close", async (code) => {
        if (task.cancelTask) await task.cancelTask;
        task.exited = true;
        try {
          await terminateChildProcess(child, { gracePeriodMs: 0 });
          task.cleanupPending = false;
          task.cancelFailed = false;
        } catch { task.cleanupPending = true; task.cancelFailed = true; }
        if (task.cancelFailed) {
          task.errorCode = "process_cleanup_unconfirmed";
          task.result = { commitState: outcome?.commitState ?? "unknown", failurePhases: outcome?.failurePhases ?? [] };
          finish("failed", "任务进程已退出，但未确认全部子进程停止；请检查实际状态后再操作", "failed", "none");
          return;
        }
        task.result = { commitState: outcome?.commitState ?? "unknown", failurePhases: outcome?.failurePhases ?? [] };
        const state = outcome === null ? "failed" : outcome.status === "completed" && code === 0 ? "completed"
          : outcome.status === "cancelled" ? "cancelled" : "failed";
        task.errorCode = outcome === null ? "result_unconfirmed" : state === "failed" ? "execution_failed" : null;
        const error = state === "failed" ? `任务失败（退出码 ${code === null ? "未知" : String(code)}）` : null;
        // Command output is intentionally neither retained nor returned: even
        // after redaction a third-party command may include credentials or paths.
        finish(state, error, state === "cancelled" ? "cancelled" : state, state === "completed" ? "none" : "check-state");
      });
    });
  }

  #fail(task, error) {
    if (["completed", "failed", "cancelled"].includes(task.state)) return;
    task.cancelTask = null;
    task.process = null;
    task.state = "failed";
    task.error = "任务启动失败，请检查服务状态及运行环境";
    task.errorCode = "start_failed";
    webuiLogger.error({ event: "task.start_failed", taskId: task.id, err: error }, "管理任务启动失败");
    task.result = null;
    task.updatedAt = new Date(this.#now()).toISOString();
    this.#emitTerminal(task, "failed", "failed", "retry-task");
  }

  #emitTerminal(task, state, resultCode, recovery) {
    this.#emitAudit(task, state, resultCode, recovery);
    this.#notify(task);
  }

  #emitAudit(task, phase, resultCode, recovery) {
    if (this.#onEvent === null || task.auditMetadata === null) return;
    try {
      this.#onEvent({ ...task.auditMetadata, task: publicTask(task), phase, resultCode, recovery });
      if (task.auditStatus !== "degraded") task.auditStatus = "recorded";
    } catch (error) {
      task.auditStatus = "degraded";
      webuiLogger.error({ module: "audit", event: "task.audit_failed", taskId: task.id, phase, err: error }, "管理任务审计失败");
    }
  }

  #pruneTerminalTasks() {
    if (this.#tasks.size < maximumTaskHistory) return;
    for (const [id, task] of this.#tasks) {
      if (!task.cleanupPending && !["queued", "running", "cancelling"].includes(task.state)) {
        this.#tasks.delete(id);
        this.#notify(task);
      }
      if (this.#tasks.size < maximumTaskHistory) return;
    }
  }
}

function metricsTaskArguments(input) {
  return ["cleanup", "metrics", ...(input.action === "cleanup" ? [] : [input.action]), ...(input.target === undefined ? [] : [input.target])];
}

function parseTaskOutcome(line, nonce) {
  const prefix = `codexc-management-result:${nonce}:`;
  if (!line.startsWith(prefix)) return null;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    const phases = ["commit", "vacuum", "count", "close", "lock-release", "gateway-restart"];
    if (!["completed", "cancelled", "failed"].includes(value?.status)
      || !["not_started", "unchanged", "committed", "not_committed", "unknown"].includes(value.commitState)
      || !Array.isArray(value.failurePhases) || value.failurePhases.length > phases.length
      || !value.failurePhases.every(phase => phases.includes(phase))) return null;
    return { status: value.status, commitState: value.commitState, failurePhases: [...new Set(value.failurePhases)] };
  } catch { return null; }
}

function serviceTaskArguments(input) {
  return [input.action, ...(input.action === "uninstall" ? ["--services"]
    : input.target === undefined ? [] : [serviceCommandTarget(input.target)])];
}

export function normalizeTaskInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ManagementTaskInputError("任务输入必须是对象");
  if (Object.keys(input).some(key => !["operation", "action", "target", "confirmationToken"].includes(key))) throw new ManagementTaskInputError("任务请求包含不支持的字段");
  if (input.operation === "service") {
    if (!serviceActions.has(input.action)) throw new ManagementTaskInputError("服务任务动作无效");
    if (input.action === "uninstall") throw new ManagementTaskInputError("此操作会停止当前 WebUI 管理任务，请在本机终端执行 codexc uninstall --services");
    if (input.action === "install") {
      if (input.target !== undefined) throw new ManagementTaskInputError("服务安装不接受服务目标");
      return { operation: "service", action: input.action, target: undefined };
    }
    if (input.action === "reload") {
      if (input.target !== undefined) throw new ManagementTaskInputError("服务重载不接受服务目标");
      return { operation: "service", action: input.action, target: undefined };
    }
    if (!targets.has(input.target)) throw new ManagementTaskInputError("服务任务目标无效");
    if (["restart", "stop"].includes(input.action) && (input.target === "all" || input.target === "webui")) {
      throw new ManagementTaskInputError(`此操作会停止当前 WebUI 管理任务，请在本机终端执行 codexc ${input.action} ${input.target}`);
    }
    return { operation: "service", action: input.action, target: input.target };
  }
  if (input.operation === "metrics") {
    if (!maintenanceActions.has(input.action)) throw new ManagementTaskInputError("指标维护动作无效");
    if (input.action === "prune") {
      if (!isPrunableMetricsProviderId(input.target)) throw new ManagementTaskInputError("指标清理任务必须指定有效提供商");
      return { operation: "metrics", action: input.action, target: input.target };
    }
    if (input.target !== undefined) throw new ManagementTaskInputError("该指标维护动作不接受提供商目标");
    return { operation: "metrics", action: input.action };
  }
  if (input.operation === "traffic") {
    if (input.action !== "cleanup") throw new ManagementTaskInputError("调用记录维护动作无效");
    if (input.target !== undefined) throw new ManagementTaskInputError("调用记录清理不接受目标");
    return { operation: "traffic", action: "cleanup", target: undefined };
  }
  throw new ManagementTaskInputError("任务类型无效");
}

function publicTask(task) {
  return {
    id: task.id,
    operation: task.operation,
    action: task.action,
    target: task.target,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error,
    errorCode: task.errorCode,
    result: task.result,
    auditStatus: task.auditStatus,
  };
}

function sanitizeTaskText(value) {
  return String(value)
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/giu, "authorization: Bearer [已隐藏]")
    .replace(/(api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=[已隐藏]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-1_000);
}
