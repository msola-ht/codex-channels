import { serviceCommandTarget } from "../runtime/service-targets.mjs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { webuiLogger } from "./webui-logger.mjs";

import { isPrunableMetricsProviderId } from "./metrics-command-options.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { terminateChildProcess } from "../runtime/process-lifecycle.mjs";

const targets = new Set(["gateway", "app-server", "webui", "model-relay", "all"]);
const serviceActions = new Set(["install", "uninstall", "start", "stop", "reload", "restart"]);
const maintenanceActions = new Set(["cleanup", "prune", "reset"]);
const metricsRequireStoppedGateway = new Set(["cleanup", "reset"]);
const maximumTaskHistory = 32;
const defaultCancellationGraceMs = 10_000;

export class WebuiManagementTaskRunner {
  #tasks = new Map();
  #now;
  #onEvent;
  #listeners = new Set();
  #cancellationGraceMs;
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
        ? "永久删除全部可识别调用记录，无法恢复；未知文件与目录不处理"
        : metrics
        ? normalized.action === "prune"
          ? "操作前备份本地指标库；失败时保留备份并尝试恢复原服务状态"
          : "操作前保留指标数据库备份；失败时保留备份并重试"
        : "服务管理器失败时任务标记失败，不自动扩大操作范围",
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

  start(input, { owner, environment = process.env, auditMetadata = null } = {}) {
    const normalized = normalizeTaskInput(input);
    this.#pruneTerminalTasks();
    if (this.#tasks.size >= maximumTaskHistory) throw new Error("管理任务数量已达上限，请先等待当前任务结束");
    if ([...this.#tasks.values()].some((task) => task.owner === owner && ["queued", "running", "cancelling"].includes(task.state))) {
      throw new Error("已有管理任务运行中，请等待完成或取消后重试");
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
      process: null,
      cancelTask: null,
      cancelFailed: false,
      auditMetadata,
    };
    this.#tasks.set(id, task);
    this.#notify(task);
    // The runner must never leak a rejected promise into the WebUI process.
    // Resolution failures (missing executable, invalid Windows shell, etc.)
    // are represented as a failed task instead.
    Promise.resolve()
      .then(() => this.#run(task, normalized, environment))
      .catch((error) => this.#fail(task, error));
    return publicTask(task);
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
    if (task.state === "queued") {
      task.state = "cancelled";
      task.updatedAt = new Date(this.#now()).toISOString();
      this.#emitTerminal(task, "cancelled", "cancelled", "none");
    } else if (task.state === "running" && task.process) {
      task.state = "cancelling";
      task.error = null;
      task.cancelFailed = false;
      task.updatedAt = new Date(this.#now()).toISOString();
      task.cancelTask = terminateChildProcess(task.process, { gracePeriodMs: this.#cancellationGraceMs })
        .then(() => true, (error) => {
          task.cancelFailed = true;
          if (task.state === "cancelling") {
            // Retain ownership and block overlapping tasks until the child exits.
            // Returning to running makes cancellation retryable without inventing success.
            task.state = "running";
            task.error = "取消未完成，进程状态尚未确认；可重试取消，请勿重复执行任务";
            task.updatedAt = new Date(this.#now()).toISOString();
            this.#notify(task);
          }
          webuiLogger.error({ event: "task.cancel_failed", taskId: task.id, err: error }, "管理任务取消未完成");
          return false;
        });
      this.#notify(task);
    }
    return publicTask(task);
  }

  async #run(task, normalized, environment) {
    if (task.state !== "queued") return;
    task.state = "running";
    task.updatedAt = new Date(this.#now()).toISOString();
    this.#notify(task);
    const args = normalized.operation === "service"
      ? serviceTaskArguments(normalized)
      : normalized.operation === "traffic"
        ? ["cleanup", "traffic", "--confirm"]
        : metricsTaskArguments(normalized);
    const invocation = resolveExecutableInvocation("codexc", args, environment);
    await new Promise((resolve) => {
      const child = spawn(invocation.file, invocation.args, {
        env: environment,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      task.process = child;
      let settled = false;
      const finish = (state, error, resultCode, recovery) => {
        if (settled) return;
        settled = true;
        task.cancelTask = null;
        task.process = null;
        task.state = state;
        task.error = error === null ? null : sanitizeTaskText(error);
        task.result = state === "completed" ? { output: null } : null;
        task.updatedAt = new Date(this.#now()).toISOString();
        this.#emitTerminal(task, state, resultCode, recovery);
        resolve();
      };
      child.once("error", () => {
        // Do not expose the platform error text: it can contain executable
        // paths or environment-specific details that are not actionable here.
        finish("failed", "任务启动失败", "failed", "retry-task");
      });
      child.once("close", async (code) => {
        const cancelled = task.state === "cancelling";
        if (task.cancelTask) await task.cancelTask;
        if (task.cancelFailed) {
          finish("failed", "任务进程已退出，但未确认全部子进程停止；请检查实际状态后再操作", "failed", "none");
          return;
        }
        const state = cancelled ? "cancelled" : code === 0 ? "completed" : "failed";
        const error = state === "failed" ? `任务失败（退出码 ${code === null ? "未知" : String(code)}）` : null;
        // Command output is intentionally neither retained nor returned: even
        // after redaction a third-party command may include credentials or paths.
        finish(state, error, state === "cancelled" ? "cancelled" : state, state === "failed" ? "retry-task" : "none");
      });
    });
  }

  #fail(task, error) {
    if (["completed", "failed", "cancelled"].includes(task.state)) return;
    task.cancelTask = null;
    task.process = null;
    task.state = "failed";
    task.error = sanitizeTaskText(error instanceof Error ? error.message : error);
    task.result = null;
    task.updatedAt = new Date(this.#now()).toISOString();
    this.#emitTerminal(task, "failed", "failed", "retry-task");
  }

  #emitTerminal(task, state, resultCode, recovery) {
    this.#notify(task);
    if (this.#onEvent === null || task.auditMetadata === null) return;
    try {
      this.#onEvent({ ...task.auditMetadata, task: publicTask(task), phase: state, resultCode, recovery });
    } catch (error) {
      webuiLogger.error({ module: "audit", event: "task.terminal_audit_failed", taskId: task.id, err: error }, "管理任务终态审计失败");
    }
  }

  #pruneTerminalTasks() {
    if (this.#tasks.size < maximumTaskHistory) return;
    for (const [id, task] of this.#tasks) {
      if (!["queued", "running", "cancelling"].includes(task.state)) {
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

function serviceTaskArguments(input) {
  return [input.action, ...(input.action === "uninstall" ? ["--services"]
    : input.target === undefined ? [] : [serviceCommandTarget(input.target)])];
}

export function normalizeTaskInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("任务输入必须是对象");
  if (input.operation === "service") {
    if (!serviceActions.has(input.action)) throw new Error("服务任务动作无效");
    if (input.action === "uninstall") throw new Error("此操作会停止当前 WebUI 管理任务，请在本机终端执行 codexc uninstall --services");
    if (input.action === "install") return { operation: "service", action: input.action, target: undefined };
    if (input.action === "reload") {
      if (input.target !== undefined) throw new Error("服务重载不接受服务目标");
      return { operation: "service", action: input.action, target: undefined };
    }
    if (!targets.has(input.target)) throw new Error("服务任务目标无效");
    if (["restart", "stop"].includes(input.action) && (input.target === "all" || input.target === "webui")) {
      throw new Error(`此操作会停止当前 WebUI 管理任务，请在本机终端执行 codexc ${input.action} ${input.target}`);
    }
    return { operation: "service", action: input.action, target: input.target };
  }
  if (input.operation === "metrics") {
    if (!maintenanceActions.has(input.action)) throw new Error("指标维护动作无效");
    if (input.action === "prune") {
      if (!isPrunableMetricsProviderId(input.target)) throw new Error("指标清理任务必须指定有效提供商");
      return { operation: "metrics", action: input.action, target: input.target };
    }
    if (input.target !== undefined) throw new Error("该指标维护动作不接受提供商目标");
    return { operation: "metrics", action: input.action };
  }
  if (input.operation === "traffic") {
    if (input.action !== "cleanup") throw new Error("调用记录维护动作无效");
    if (input.target !== undefined) throw new Error("调用记录清理不接受目标");
    return { operation: "traffic", action: "cleanup", target: undefined };
  }
  throw new Error("任务类型无效");
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
    result: task.result,
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
