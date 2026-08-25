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
  parentTurnId: string;
  agentPath: string;
  startedAtMs: number;
  activeTurnId: string | undefined;
  terminalStatus?: SubagentCompletedEvent["status"];
  terminalTurnId: string | undefined;
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
  terminalTurnId: string | undefined;
  terminalAtMs: number;
  expiresAtMs: number;
}

interface PendingStart {
  turnId: string;
  expiresAtMs: number;
}

interface PendingActivity {
  event: Extract<OutputEvent, { type: "subagent.contacted" }>;
  expiresAtMs: number;
}

export interface SubagentCompletionTrackerOptions {
  readSummary: (
    agentThreadId: string,
    terminalTurnId?: string,
  ) => SubagentMetricsSummary;
  waitForMetrics?: (agentThreadId: string, agentTurnId?: string) => Promise<boolean>;
  onRunStarted?: (details: {
    agentThreadId: string;
    agentTurnId: string;
    parentThreadId: string;
    parentTurnId: string;
    agentPath: string;
  }) => void;
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
  private readonly pendingStarts = new Map<string, PendingStart>();
  private readonly pendingActivities = new Map<string, PendingActivity>();
  private closed = false;

  constructor(private readonly options: SubagentCompletionTrackerOptions) {}

  handle(event: OutputEvent): void {
    if (this.closed) return;
    if (event.type === "subagent.spawned") {
      if (!this.active.has(event.agentThreadId)) this.register(event);
      return;
    }
    if (event.type === "subagent.contacted") {
      const previous = this.active.get(event.agentThreadId);
      if (!previous) {
        this.register(event);
      } else if (previous.terminalStatus) {
        if (previous.timer) clearTimeout(previous.timer);
        previous.timer = undefined;
        this.active.delete(event.agentThreadId);
        void this.complete(event.agentThreadId, previous, previous.revision, true);
        this.register(event);
      } else {
        this.rememberPendingActivity(event);
      }
      return;
    }
    if (event.type !== "operation.updated") return;
    for (const state of event.operation.subagentStates ?? []) {
      const terminalStatus = completionStatus(state.status);
      if (!terminalStatus) continue;
      this.markTerminal(state.threadId, terminalStatus, false);
    }
    if (
      event.operation.kind === "subagent"
      && event.operation.action === "wait"
      && event.operation.status === "completed"
    ) {
      for (const [agentThreadId, entry] of this.active) {
        if (
          entry.parentThreadId !== event.threadId
          || entry.parentTurnId !== event.turnId
          || !entry.terminalStatus
        ) continue;
        entry.waitObservedAfterTerminal = true;
        this.schedule(agentThreadId, entry);
      }
    }
  }

  handleInput(event: ConversationInputEvent): void {
    if (this.closed) return;
    if (event.type === "turn.started") {
      const entry = this.active.get(event.threadId);
      if (entry && entry.activeTurnId === undefined) {
        this.assignTurn(event.threadId, entry, event.turnId);
      } else if (!entry || entry.activeTurnId !== event.turnId) {
        this.rememberPendingStart(event.threadId, event.turnId);
        this.promotePendingFollowup(event.threadId);
      }
      return;
    }
    if (event.type === "turn.completed") {
      const status = turnCompletionStatus(event.status);
      if (status) {
        this.markTerminal(event.threadId, status, true, event.turnId);
      }
      return;
    }
    if (event.type === "item.subagentActivity" && event.kind === "interrupted") {
      this.markTerminal(event.agentThreadId, "interrupted", false);
    }
  }

  metricsAvailable(agentThreadId: string, agentTurnId?: string): void {
    if (this.closed) return;
    const entry = this.active.get(agentThreadId);
    if (!entry) return;
    if (
      agentTurnId !== undefined
      && agentTurnId !== entry.activeTurnId
      && agentTurnId !== entry.terminalTurnId
    ) return;
    const checkpoint = this.options.waitForMetrics?.(agentThreadId, agentTurnId)
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
    this.pendingStarts.clear();
    this.pendingActivities.clear();
  }

  private markTerminal(
    agentThreadId: string,
    status: SubagentTerminalStatus,
    retainIfMissing: boolean,
    terminalTurnId?: string,
  ): void {
    const entry = this.active.get(agentThreadId);
    if (entry) {
      const resolvedTerminalTurnId = terminalTurnId ?? entry.activeTurnId;
      if (
        terminalTurnId !== undefined
        && entry.activeTurnId !== undefined
        && entry.activeTurnId !== terminalTurnId
      ) {
        if (retainIfMissing) {
          this.rememberPendingTerminal(agentThreadId, status, terminalTurnId);
        }
        return;
      }
      if (terminalTurnId !== undefined && entry.activeTurnId === undefined) {
        this.assignTurn(agentThreadId, entry, terminalTurnId);
      }
      if (entry.terminalStatus) {
        if (!entry.terminalTurnId && resolvedTerminalTurnId) {
          entry.terminalTurnId = resolvedTerminalTurnId;
          entry.terminalStatus = status;
          this.schedule(agentThreadId, entry);
        }
        return;
      }
      entry.terminalStatus = status;
      entry.terminalTurnId = resolvedTerminalTurnId;
      entry.terminalAtMs = Date.now();
      this.schedule(agentThreadId, entry);
      this.promotePendingFollowup(agentThreadId);
      return;
    }
    if (!retainIfMissing) return;
    this.rememberPendingTerminal(agentThreadId, status, terminalTurnId);
  }

  private rememberPendingTerminal(
    agentThreadId: string,
    status: SubagentTerminalStatus,
    terminalTurnId?: string,
  ): void {
    this.prunePendingTerminals();
    const key = pendingTerminalKey(agentThreadId, terminalTurnId);
    this.pendingTerminals.delete(key);
    this.pendingTerminals.set(key, {
      status,
      terminalTurnId,
      terminalAtMs: Date.now(),
      expiresAtMs: Date.now() + pendingTerminalTtlMs,
    });
    while (this.pendingTerminals.size > maxPendingTerminals) {
      const oldest = this.pendingTerminals.keys().next().value;
      if (!oldest) break;
      this.pendingTerminals.delete(oldest);
    }
  }

  private takePendingTerminal(
    agentThreadId: string,
    agentTurnId?: string,
  ): PendingTerminal | undefined {
    this.prunePendingTerminals();
    const exactKey = pendingTerminalKey(agentThreadId, agentTurnId);
    const legacyKey = pendingTerminalKey(agentThreadId);
    const pending = this.pendingTerminals.get(exactKey)
      ?? this.pendingTerminals.get(legacyKey)
      ?? (agentTurnId === undefined
        ? [...this.pendingTerminals.entries()].reverse().find(
            ([key]) => key.startsWith(`${agentThreadId}\u0000`),
          )?.[1]
        : undefined);
    this.pendingTerminals.delete(exactKey);
    this.pendingTerminals.delete(legacyKey);
    if (pending?.terminalTurnId) {
      this.pendingTerminals.delete(
        pendingTerminalKey(agentThreadId, pending.terminalTurnId),
      );
    }
    return pending;
  }

  private register(
    event: Extract<OutputEvent, { type: "subagent.spawned" | "subagent.contacted" }>,
  ): void {
    const entry: ActiveSubagent = {
      target: event.target,
      parentThreadId: event.threadId,
      parentTurnId: event.turnId,
      agentPath: event.agentPath,
      startedAtMs: Date.now(),
      activeTurnId: undefined,
      terminalTurnId: undefined,
      waitObservedAfterTerminal: false,
      timer: undefined,
      revision: 0,
    };
    this.active.set(event.agentThreadId, entry);
    const pendingStart = this.takePendingStart(event.agentThreadId);
    if (pendingStart) {
      this.assignTurn(event.agentThreadId, entry, pendingStart.turnId);
    }
    const pending = this.takePendingTerminal(
      event.agentThreadId,
      entry.activeTurnId,
    );
    if (pending) {
      if (entry.activeTurnId === undefined && pending.terminalTurnId) {
        this.assignTurn(event.agentThreadId, entry, pending.terminalTurnId);
      }
      entry.terminalStatus = pending.status;
      entry.terminalTurnId = pending.terminalTurnId ?? entry.activeTurnId;
      entry.terminalAtMs = pending.terminalAtMs;
      this.schedule(event.agentThreadId, entry);
    }
  }

  private assignTurn(
    agentThreadId: string,
    entry: ActiveSubagent,
    agentTurnId: string,
  ): void {
    entry.activeTurnId = agentTurnId;
    if (entry.terminalStatus && entry.terminalTurnId === undefined) {
      entry.terminalTurnId = agentTurnId;
      this.schedule(agentThreadId, entry);
    }
    this.options.onRunStarted?.({
      agentThreadId,
      agentTurnId,
      parentThreadId: entry.parentThreadId,
      parentTurnId: entry.parentTurnId,
      agentPath: entry.agentPath,
    });
  }

  private rememberPendingStart(agentThreadId: string, turnId: string): void {
    this.prunePendingStarts();
    this.pendingStarts.delete(agentThreadId);
    this.pendingStarts.set(agentThreadId, {
      turnId,
      expiresAtMs: Date.now() + pendingTerminalTtlMs,
    });
    while (this.pendingStarts.size > maxPendingTerminals) {
      const oldest = this.pendingStarts.keys().next().value;
      if (!oldest) break;
      this.pendingStarts.delete(oldest);
    }
  }

  private rememberPendingActivity(
    event: Extract<OutputEvent, { type: "subagent.contacted" }>,
  ): void {
    this.prunePendingActivities();
    this.pendingActivities.delete(event.agentThreadId);
    this.pendingActivities.set(event.agentThreadId, {
      event,
      expiresAtMs: Date.now() + pendingTerminalTtlMs,
    });
    while (this.pendingActivities.size > maxPendingTerminals) {
      const oldest = this.pendingActivities.keys().next().value;
      if (!oldest) break;
      this.pendingActivities.delete(oldest);
    }
  }

  private promotePendingFollowup(agentThreadId: string): void {
    this.prunePendingActivities();
    this.prunePendingStarts();
    const previous = this.active.get(agentThreadId);
    const pendingActivity = this.pendingActivities.get(agentThreadId);
    if (
      !previous?.terminalStatus
      || !pendingActivity
      || !this.pendingStarts.has(agentThreadId)
    ) return;
    this.pendingActivities.delete(agentThreadId);
    if (previous.timer) clearTimeout(previous.timer);
    previous.timer = undefined;
    this.active.delete(agentThreadId);
    void this.complete(agentThreadId, previous, previous.revision, true);
    this.register(pendingActivity.event);
  }

  private prunePendingActivities(): void {
    const now = Date.now();
    for (const [threadId, pending] of this.pendingActivities) {
      if (pending.expiresAtMs <= now) this.pendingActivities.delete(threadId);
    }
  }

  private takePendingStart(agentThreadId: string): PendingStart | undefined {
    this.prunePendingStarts();
    const pending = this.pendingStarts.get(agentThreadId);
    this.pendingStarts.delete(agentThreadId);
    return pending;
  }

  private prunePendingStarts(): void {
    const now = Date.now();
    for (const [threadId, pending] of this.pendingStarts) {
      if (pending.expiresAtMs <= now) this.pendingStarts.delete(threadId);
    }
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
    detached = false,
  ): Promise<void> {
    if (
      this.closed
      || (!detached && (
        this.active.get(agentThreadId) !== entry
        || entry.revision !== revision
      ))
    ) return;
    const metricsPersisted = await (entry.metricsCheckpoint ?? Promise.resolve(true));
    if (
      this.closed
      || (!detached && (
        this.active.get(agentThreadId) !== entry
        || entry.revision !== revision
      ))
    ) return;
    let summary: SubagentMetricsSummary | null = null;
    let metricsStatus: SubagentCompletedEvent["metricsStatus"] = "unavailable";
    if (metricsPersisted) {
      try {
        summary = this.options.readSummary(agentThreadId, entry.terminalTurnId);
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
    if (!detached) this.active.delete(agentThreadId);
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

function pendingTerminalKey(agentThreadId: string, agentTurnId?: string): string {
  return `${agentThreadId}\u0000${agentTurnId ?? ""}`;
}
