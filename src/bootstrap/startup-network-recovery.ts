import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";

import policy from "../../startup-network-policy.json" with { type: "json" };
import type { McpServerSummary } from "../application/index.js";
import type { McpServerStatus } from "../conversation-core/index.js";
import type { OpenAiConnectivityStatus } from "./openai-connectivity.js";

interface StartupNetworkRecoveryOptions {
  logger: Logger;
  probe(signal: AbortSignal): Promise<OpenAiConnectivityStatus>;
  snapshot(threadId: string, signal: AbortSignal): Promise<McpServerSummary[]>;
  reloadMcp(signal: AbortSignal): Promise<void>;
  recovered(signal: AbortSignal): Promise<void>;
  status(status: OpenAiConnectivityStatus | "recovering"): void;
  notify(message: string): void;
  policy?: typeof policy;
}

/** A single bounded startup recovery; never replays user input or restarts shared services. */
export class StartupNetworkRecovery {
  private readonly policy: typeof policy;
  private readonly abort = new AbortController();
  private readonly failedApps = new Set<string>();
  private readonly snapshotVersions = new Map<string, number>();
  private readonly pendingSnapshots = new Set<string>();
  private task: Promise<void> | undefined;
  private finished = false;
  private initial: OpenAiConnectivityStatus | undefined;
  private networkReachable = false;
  private monitorLateFailure = false;
  private readonly deadline = new AbortController();
  private deadlineTimer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly options: StartupNetworkRecoveryOptions) {
    this.policy = options.policy ?? policy;
  }

  observeMcp(event: McpServerStatus): void {
    if (this.finished || this.abort.signal.aborted || event.name !== "codex_apps" || event.threadId === null) return;
    this.pendingSnapshots.delete(event.threadId);
    if (this.snapshotVersions.has(event.threadId)) {
      this.snapshotVersions.set(event.threadId, this.snapshotVersions.get(event.threadId)! + 1);
    }
    if (event.status === "failed" && event.failureReason === null) {
      this.failedApps.add(event.threadId);
      if (this.initial === "reachable" && !this.task) this.launch(false);
    } else if (event.status === "ready" || event.status === "cancelled" || event.failureReason !== null) {
      this.failedApps.delete(event.threadId);
      this.wake?.();
    }
  }

  forgetThread(threadId: string): void {
    this.pendingSnapshots.delete(threadId);
    if (this.snapshotVersions.has(threadId)) {
      this.snapshotVersions.set(threadId, this.snapshotVersions.get(threadId)! + 1);
    }
    this.failedApps.delete(threadId);
    this.wake?.();
  }

  start(initial: OpenAiConnectivityStatus, restoredThreadIds: readonly string[] = []): void {
    if (this.initial !== undefined || this.finished || this.abort.signal.aborted) return;
    this.initial = initial;
    this.networkReachable = initial === "reachable";
    const networkFailed = initial === "unreachable" || initial === "indeterminate" || initial === "temporarily-unavailable";
    if (!networkFailed && initial !== "reachable") {
      this.finished = true;
      this.failedApps.clear();
      return;
    }
    this.deadlineTimer = setTimeout(() => {
      this.deadline.abort();
      if (!this.task) {
        this.finished = true;
        this.failedApps.clear();
      }
    }, this.policy.recoveryDeadlineMs);
    this.deadlineTimer.unref();
    if (networkFailed) this.options.status("recovering");
    if (networkFailed || this.failedApps.size > 0 || restoredThreadIds.length > 0) this.launch(networkFailed, restoredThreadIds);
  }

  private launch(networkFailed: boolean, restoredThreadIds: readonly string[] = []): void {
    this.monitorLateFailure = false;
    this.task = Promise.resolve().then(() => this.run(networkFailed, restoredThreadIds)).catch((error: unknown) => {
      if (this.abort.signal.aborted) return;
      if (!this.networkReachable) this.options.status("indeterminate");
      this.options.logger.warn({ err: error }, "启动网络恢复失败");
      this.options.notify("启动恢复未完成，请使用 /mcp health 检查连接；不会自动重发任务或重启 App Server。");
    }).finally(() => {
      if (this.monitorLateFailure && !this.abort.signal.aborted && !this.deadline.signal.aborted) {
        this.initial = "reachable";
        this.task = undefined;
        if (this.failedApps.size > 0) this.launch(false);
        return;
      }
      this.finished = true;
      clearTimeout(this.deadlineTimer);
      this.failedApps.clear();
      this.pendingSnapshots.clear();
      this.wake = undefined;
    });
  }

  async stop(): Promise<void> {
    this.abort.abort();
    clearTimeout(this.deadlineTimer);
    this.wake?.();
    const waitAbort = new AbortController();
    try {
      await Promise.race([
        this.task,
        delay(this.policy.stopTimeoutMs, undefined, { signal: waitAbort.signal }),
      ]);
    } finally {
      waitAbort.abort();
      this.failedApps.clear();
      this.pendingSnapshots.clear();
    }
  }

  private async run(networkFailed: boolean, restoredThreadIds: readonly string[]): Promise<void> {
    const signal = AbortSignal.any([this.abort.signal, this.deadline.signal]);
    let status: OpenAiConnectivityStatus = this.initial ?? "unreachable";
    try {
      await this.restoreMcpSnapshots(restoredThreadIds, signal);
      signal.throwIfAborted();
      if (!networkFailed && this.failedApps.size === 0 && this.pendingSnapshots.size === 0) {
        this.monitorLateFailure = true;
        return;
      }
      for (const milliseconds of this.policy.recoveryRetryDelaysMs) {
        await delay(milliseconds, undefined, { signal, ref: false });
        status = await this.options.probe(signal);
        signal.throwIfAborted();
        if (status === "not-applicable") {
          this.options.status(status);
          return;
        }
        if (status === "reachable") {
          this.networkReachable = true;
          this.options.status(status);
          if (networkFailed) this.options.notify("OpenAI 网络已恢复。此前失败的任务不会自动重发。");
          await this.restoreMcpSnapshots([...this.pendingSnapshots], signal);
          signal.throwIfAborted();
          if (this.pendingSnapshots.size > 0) {
            this.options.notify("网络已恢复，但部分会话的 MCP 状态仍无法读取；请使用 /mcp health 检查。");
            this.pendingSnapshots.clear();
          }
          this.monitorLateFailure = this.failedApps.size === 0;
          await Promise.all([this.recoverMcp(signal), this.options.recovered(signal)]);
          return;
        }
        if (status !== "unreachable" && status !== "indeterminate" && status !== "temporarily-unavailable") break;
      }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      if (!this.deadline.signal.aborted) throw error;
    }
    if (this.abort.signal.aborted) return;
    this.options.status(status);
    this.options.notify("启动网络自动复检已结束，外部依赖仍未就绪；请检查网络、代理和 /mcp health。");
  }

  private async restoreMcpSnapshots(threadIds: readonly string[], signal: AbortSignal): Promise<void> {
    for (const threadId of threadIds) this.snapshotVersions.set(threadId, 0);
    try {
      for (const threadId of threadIds) {
        signal.throwIfAborted();
        if (this.snapshotVersions.get(threadId) !== 0) continue;
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new Error("读取启动 MCP 状态超时")), this.policy.probeDeadlineMs);
        timer.unref();
        const requestSignal = AbortSignal.any([signal, deadline.signal]);
        try {
          const servers = await this.options.snapshot(threadId, requestSignal);
          requestSignal.throwIfAborted();
          // A notification or thread closure received during the read supersedes its snapshot.
          if (this.snapshotVersions.get(threadId) !== 0) continue;
          this.pendingSnapshots.delete(threadId);
          const apps = servers.find((server) => server.name === "codex_apps");
          if (apps?.runtimeStatus === "failed") this.failedApps.add(threadId);
          else this.failedApps.delete(threadId);
        } catch (error) {
          if (signal.aborted) throw error;
          if (this.snapshotVersions.get(threadId) === 0) this.pendingSnapshots.add(threadId);
          this.options.logger.warn({ err: error, threadId }, "读取启动 MCP 状态失败，继续观察实时通知");
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      this.snapshotVersions.clear();
    }
  }

  private async recoverMcp(signal: AbortSignal): Promise<void> {
    if (this.failedApps.size === 0) return;
    // RPC success means the refresh was requested, not that the MCP connection is ready.
    await this.options.reloadMcp(signal);
    signal.throwIfAborted();
    if (this.failedApps.size === 0) return;
    const waitAbort = new AbortController();
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.wake = () => { if (this.failedApps.size === 0) resolve(); };
        }),
        delay(this.policy.mcpReadyTimeoutMs, undefined, {
          signal: AbortSignal.any([signal, waitAbort.signal]), ref: false,
        }),
      ]);
      signal.throwIfAborted();
      if (this.failedApps.size > 0) {
        this.options.notify("OpenAI 网络已恢复，但 codex_apps 尚未确认就绪；请使用 /mcp health 检查，必要时执行 /mcp reload。");
      }
    } finally {
      this.wake = undefined;
      waitAbort.abort();
    }
  }
}
