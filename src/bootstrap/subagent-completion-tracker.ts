import type {
  ConversationInputEvent,
  ConversationTarget,
  OutputEvent,
  SubagentStatus,
  SubagentTerminalStatus,
} from "../conversation-core/index.js";

type SubagentCompletedEvent = Extract<OutputEvent, { type: "subagent.completed" }>;

interface ActiveSubagent {
  target: ConversationTarget;
  parentThreadId: string;
  agentPath: string;
  startedAtMs: number;
  terminalStatus?: SubagentCompletedEvent["status"];
  terminalAtMs?: number;
  metricsCheckpoint?: Promise<boolean>;
  waitObservedAfterTerminal: boolean;
  timer: NodeJS.Timeout | undefined;
  revision: number;
}

interface SubagentMetricsSummary {
  latestTurn: {
    model: string | null;
    provider: string | null;
    reasoningEffort: string | null;
  } | null;
  threadAggregate: {
    requestCount: number;
    unsuccessfulRequestCount: number;
    pricedRequestCount: number;
    inputTokens: number;
    pricedInputTokens: number;
    cachedInputTokens: number | null;
    outputTokens: number;
    pricedOutputTokens: number;
    reasoningOutputTokens: number;
    totalCostNanos: number | null;
    inputCostNanos: number | null;
    cachedInputCostNanos: number | null;
    outputCostNanos: number | null;
    pricingCurrency: string | null;
    requestDurationMs: number;
    outputTokensPerSecond: number | null;
    outputSpeedSampleCount: number;
    outputSpeedTimedCount: number;
  } | null;
}

interface PendingTerminal {
  status: SubagentTerminalStatus;
  terminalAtMs: number;
  expiresAtMs: number;
}

export interface SubagentCompletionTrackerOptions {
  readSummary: (agentThreadId: string) => SubagentMetricsSummary;
  waitForMetrics?: (agentThreadId: string) => Promise<boolean>;
  publish: (event: SubagentCompletedEvent) => void;
  settleDelayMs?: number;
  onReadError?: (error: unknown, agentThreadId: string) => void;
  onMissingMetrics?: (agentThreadId: string) => void;
  onCompleted?: (event: SubagentCompletedEvent) => void;
}

const defaultSettleDelayMs = 5_000;
const pendingTerminalTtlMs = 60_000;
const maxPendingTerminals = 128;

export class SubagentCompletionTracker {
  private readonly active = new Map<string, ActiveSubagent>();
  private readonly pendingTerminals = new Map<string, PendingTerminal>();
  private closed = false;

  constructor(private readonly options: SubagentCompletionTrackerOptions) {}

  handle(event: OutputEvent): void {
    if (this.closed) return;
    if (event.type === "subagent.spawned") {
      if (!this.active.has(event.agentThreadId)) {
        const entry: ActiveSubagent = {
          target: event.target,
          parentThreadId: event.threadId,
          agentPath: event.agentPath,
          startedAtMs: Date.now(),
          waitObservedAfterTerminal: false,
          timer: undefined,
          revision: 0,
        };
        this.active.set(event.agentThreadId, entry);
        const pending = this.takePendingTerminal(event.agentThreadId);
        if (pending) {
          entry.terminalStatus = pending.status;
          entry.terminalAtMs = pending.terminalAtMs;
          this.schedule(event.agentThreadId, entry);
        }
      }
      return;
    }
    if (event.type !== "operation.updated") return;
    for (const state of event.operation.subagentStates ?? []) {
      const terminalStatus = completionStatus(state.status);
      if (!terminalStatus) continue;
      const entry = this.active.get(state.threadId);
      if (!entry || entry.terminalStatus) continue;
      entry.terminalStatus = terminalStatus;
      entry.terminalAtMs = Date.now();
      this.schedule(state.threadId, entry);
    }
    if (
      event.operation.kind === "subagent"
      && event.operation.action === "wait"
      && event.operation.status === "completed"
    ) {
      for (const [agentThreadId, entry] of this.active) {
        if (entry.parentThreadId !== event.threadId || !entry.terminalStatus) continue;
        entry.waitObservedAfterTerminal = true;
        this.schedule(agentThreadId, entry);
      }
    }
  }

  handleInput(event: ConversationInputEvent): void {
    if (this.closed) return;
    if (event.type === "turn.completed") {
      const status = turnCompletionStatus(event.status);
      if (status) {
        this.markTerminal(event.threadId, status, true);
      }
      return;
    }
    if (event.type === "item.subagentActivity" && event.kind === "interrupted") {
      this.markTerminal(event.agentThreadId, "interrupted", false);
    }
  }

  metricsAvailable(agentThreadId: string): void {
    if (this.closed) return;
    const entry = this.active.get(agentThreadId);
    if (!entry) return;
    const checkpoint = this.options.waitForMetrics?.(agentThreadId)
      ?? Promise.resolve(true);
    entry.metricsCheckpoint = Promise.all([
      entry.metricsCheckpoint ?? Promise.resolve(true),
      checkpoint,
    ]).then(([previousSucceeded, currentSucceeded]) =>
      previousSucceeded && currentSucceeded
    );
    if (!entry.terminalStatus) return;
    this.schedule(agentThreadId, entry);
  }

  close(): void {
    this.closed = true;
    for (const entry of this.active.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.active.clear();
    this.pendingTerminals.clear();
  }

  private markTerminal(
    agentThreadId: string,
    status: SubagentTerminalStatus,
    retainIfMissing: boolean,
  ): void {
    const entry = this.active.get(agentThreadId);
    if (entry) {
      if (entry.terminalStatus) return;
      entry.terminalStatus = status;
      entry.terminalAtMs = Date.now();
      this.schedule(agentThreadId, entry);
      return;
    }
    if (!retainIfMissing) return;
    this.prunePendingTerminals();
    this.pendingTerminals.delete(agentThreadId);
    this.pendingTerminals.set(agentThreadId, {
      status,
      terminalAtMs: Date.now(),
      expiresAtMs: Date.now() + pendingTerminalTtlMs,
    });
    while (this.pendingTerminals.size > maxPendingTerminals) {
      const oldest = this.pendingTerminals.keys().next().value;
      if (!oldest) break;
      this.pendingTerminals.delete(oldest);
    }
  }

  private takePendingTerminal(agentThreadId: string): PendingTerminal | undefined {
    this.prunePendingTerminals();
    const pending = this.pendingTerminals.get(agentThreadId);
    this.pendingTerminals.delete(agentThreadId);
    return pending;
  }

  private prunePendingTerminals(): void {
    const now = Date.now();
    for (const [threadId, pending] of this.pendingTerminals) {
      if (pending.expiresAtMs <= now) {
        this.pendingTerminals.delete(threadId);
      }
    }
  }

  private schedule(agentThreadId: string, entry: ActiveSubagent): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.revision += 1;
    const revision = entry.revision;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.complete(agentThreadId, entry, revision);
    }, entry.metricsCheckpoint && entry.waitObservedAfterTerminal
      ? 0
      : this.options.settleDelayMs ?? defaultSettleDelayMs);
    entry.timer.unref?.();
  }

  private async complete(
    agentThreadId: string,
    entry: ActiveSubagent,
    revision: number,
  ): Promise<void> {
    if (
      this.closed
      || this.active.get(agentThreadId) !== entry
      || entry.revision !== revision
    ) return;
    const metricsPersisted = await (entry.metricsCheckpoint ?? Promise.resolve(true));
    if (
      this.closed
      || this.active.get(agentThreadId) !== entry
      || entry.revision !== revision
    ) return;
    let summary: SubagentMetricsSummary | null = null;
    let metricsStatus: SubagentCompletedEvent["metricsStatus"] = "unavailable";
    if (metricsPersisted) {
      try {
        summary = this.options.readSummary(agentThreadId);
        metricsStatus = summary.threadAggregate?.requestCount
          ? "available"
          : "empty";
      } catch (error) {
        this.options.onReadError?.(error, agentThreadId);
      }
    }
    const aggregate = summary?.threadAggregate ?? null;
    if (metricsStatus === "empty") {
      this.options.onMissingMetrics?.(agentThreadId);
    }
    const event: SubagentCompletedEvent = {
      type: "subagent.completed",
      target: entry.target,
      parentThreadId: entry.parentThreadId,
      agentThreadId,
      agentPath: entry.agentPath,
      metricsStatus,
      model: summary?.latestTurn?.model ?? null,
      modelProvider: summary?.latestTurn?.provider ?? null,
      reasoningEffort: summary?.latestTurn?.reasoningEffort ?? null,
      status: entry.terminalStatus ?? "errored",
      requestCount: aggregate?.requestCount ?? 0,
      unsuccessfulRequestCount: aggregate?.unsuccessfulRequestCount ?? 0,
      pricedRequestCount: aggregate?.pricedRequestCount ?? 0,
      inputTokens: aggregate?.inputTokens ?? 0,
      pricedInputTokens: aggregate?.pricedInputTokens ?? 0,
      cachedInputTokens: aggregate?.cachedInputTokens ?? null,
      outputTokens: aggregate?.outputTokens ?? 0,
      pricedOutputTokens: aggregate?.pricedOutputTokens ?? 0,
      reasoningOutputTokens: aggregate?.reasoningOutputTokens ?? 0,
      totalCostNanos: aggregate?.totalCostNanos ?? null,
      inputCostNanos: aggregate?.inputCostNanos ?? null,
      cachedInputCostNanos: aggregate?.cachedInputCostNanos ?? null,
      outputCostNanos: aggregate?.outputCostNanos ?? null,
      pricingCurrency: aggregate?.pricingCurrency ?? null,
      outputTokensPerSecond: aggregate?.outputTokensPerSecond ?? null,
      outputSpeedSampleCount: aggregate?.outputSpeedSampleCount ?? 0,
      outputSpeedTimedCount: aggregate?.outputSpeedTimedCount ?? 0,
      elapsedMs: Math.max(
        0,
        (entry.terminalAtMs ?? Date.now()) - entry.startedAtMs,
      ),
      durationMs: aggregate?.requestDurationMs ?? 0,
    };
    this.active.delete(agentThreadId);
    this.options.publish(event);
    this.options.onCompleted?.(event);
  }

}

function turnCompletionStatus(
  status: "completed" | "interrupted" | "failed" | "inProgress",
): SubagentTerminalStatus | undefined {
  if (status === "completed" || status === "interrupted") return status;
  return status === "failed" ? "errored" : undefined;
}

function completionStatus(
  status: SubagentStatus,
): SubagentTerminalStatus | undefined {
  return status === "pendingInit" || status === "running"
    ? undefined
    : status;
}
