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
  agentThreadId: string;
  agentPath: string;
  activeTurnId: string | undefined;
  terminalStatus?: SubagentCompletedEvent["status"];
  terminalTurnId: string | undefined;
  metricsCheckpoint?: Promise<boolean>;
  waitObservedAfterTerminal: boolean;
  timer: NodeJS.Timeout | undefined;
  revision: number;
  emitted?: boolean;
}

interface SubagentMetricsSummary {
  latestTurn: {
    upstreamTtftMs?: number | null;
    model: string | null;
    provider: string | null;
    reasoningEffort: string | null;
  } | null;
  threadAggregate: {
    requestCount: number;
    unsuccessfulRequestCount: number;
    inputTokens: number;
    cachedInputTokens: number | null;
    outputTokens: number;
    reasoningOutputTokens: number;
  } | null;
}

interface PendingTerminal {
  status: SubagentTerminalStatus;
  terminalTurnId: string | undefined;
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

interface PendingCompletion {
  event: Extract<ConversationInputEvent, { type: "item.subagentActivity" }>;
  expiresAtMs: number;
}

interface PendingParentRun {
  parentThreadId: string;
  parentTurnId: string;
  agentThreadId: string;
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
  onRunAttributionIncomplete?: () => void;
  publish: (event: SubagentCompletedEvent) => void;
  settleDelayMs?: number;
  onReadError?: (error: unknown, agentThreadId: string) => void;
  onMissingMetrics?: (agentThreadId: string) => void;
  onCompleted?: (event: SubagentCompletedEvent) => void;
}

const defaultSettleDelayMs = 5_000;
const pendingTerminalTtlMs = 60_000;
const maxPendingTerminals = 128;
const maxObservedFollowupOperations = 128;

export class SubagentCompletionTracker {
  private readonly active = new Map<string, ActiveSubagent>();
  private readonly pendingTerminals = new Map<string, PendingTerminal>();
  private readonly pendingStarts = new Map<string, PendingStart>();
  private readonly pendingActivities = new Map<string, PendingActivity>();
  private readonly pendingCompletions = new Map<string, PendingCompletion>();
  private readonly pendingParentRuns = new Map<string, PendingParentRun>();
  private readonly metricParents = new Map<string, { parentThreadId: string; parentTurnId: string; agentPath: string; expiresAtMs: number; followupStart?: number }>();
  private readonly attributedMetricParents = new Set<string>();
  private readonly metricTurns = new Map<string, { turnId: string; expiresAtMs: number; sequence: number; started: boolean }>();
  private readonly metricFollowupStarts = new Map<string, number>();
  private metricSequence = 0;
  private readonly metricPaths = new Map<string, string>();
  private readonly observedMetricTurns = new Set<string>();
  private readonly observedMetricActivities = new Set<string>();
  private readonly observedFollowupOperations = new Set<string>();
  private closed = false;
  private readonly detached = new Set<ActiveSubagent>();
  private drainTask: Promise<void> | undefined;

  constructor(private readonly options: SubagentCompletionTrackerOptions) {}

  hasPendingForParentThread(parentThreadId: string): boolean {
    return [...this.pendingParentRuns.values()].some((run) =>
      run.parentThreadId === parentThreadId
    );
  }

  pendingParentTurns(): { threadId: string; turnId: string }[] {
    return [...this.pendingParentRuns.values()].map(run => ({ threadId: run.parentThreadId, turnId: run.parentTurnId }));
  }

  resetRunAttribution(isAffected: (threadId: string) => boolean = () => true): void {
    const affectedChildren = new Set<string>();
    for (const [threadId, parent] of this.metricParents) {
      if (!isAffected(threadId) && !isAffected(parent.parentThreadId)) continue;
      affectedChildren.add(threadId);
      this.metricParents.delete(threadId);
    }
    const affected = (threadId: string) => affectedChildren.has(threadId) || isAffected(threadId);
    for (const entries of [this.metricTurns, this.metricPaths]) {
      for (const threadId of entries.keys()) if (affected(threadId)) entries.delete(threadId);
    }
    for (const key of this.metricFollowupStarts.keys()) {
      if (affected(key.split("\u0000")[0]!)) this.metricFollowupStarts.delete(key);
    }
    for (const observed of [this.observedMetricActivities, this.observedMetricTurns]) {
      for (const key of observed) if (affected(key.split("\u0000")[0]!)) observed.delete(key);
    }
    for (const key of this.attributedMetricParents) {
      const [parentThreadId, , agentThreadId] = key.split("\u0000");
      if (affected(parentThreadId!) || affected(agentThreadId!)) this.attributedMetricParents.delete(key);
    }
    this.options.onRunAttributionIncomplete?.();
  }

  handle(event: OutputEvent): void {
    if (this.closed || this.drainTask) return;
    if (event.type === "subagent.spawned") {
      const metricKey = `${event.threadId}\u0000${event.turnId}\u0000${event.agentThreadId}`;
      if (!this.attributedMetricParents.has(metricKey)) {
        this.metricParents.set(event.agentThreadId, { parentThreadId: event.threadId, parentTurnId: event.turnId,
          agentPath: event.agentPath, expiresAtMs: Date.now() + pendingTerminalTtlMs });
        this.tryRecordMetricRun(event.agentThreadId);
        this.trimMetricObservations();
      }
      this.rememberParentRun(event);
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
        this.detached.add(previous);
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
    this.observeMetricRun(event);
    if (this.closed || this.drainTask) return;
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
    if (
      event.type === "item.operation.updated"
      && event.operation.kind === "subagent"
      && event.operation.action === "followup_task"
      && event.operation.status === "completed"
    ) {
      for (const agentThreadId of event.operation.receiverThreadIds ?? []) {
        const run = {
          parentThreadId: event.threadId,
          parentTurnId: event.turnId,
          agentThreadId,
        };
        if (!this.rememberFollowupOperation(run, event.operation.itemId)) continue;
        this.rememberParentRun(run, true);
      }
      return;
    }
    if (event.type === "item.subagentActivity") {
      if (event.kind === "started") {
        this.rememberParentRun(event);
      } else if (event.kind === "interrupted") {
        this.forgetParentRun(event);
        this.markTerminal(event.agentThreadId, "interrupted", false);
      } else if (event.kind === "completed") {
        this.forgetParentRun(event);
        this.markNativeCompletion(event);
      }
    }
  }

  /** Attribution also runs for descendants that have no channel binding or output. */
  private observeMetricRun(event: ConversationInputEvent): void {
    if (this.closed || this.drainTask) return;
    this.metricSequence += 1;
    for (const [threadId, pending] of this.metricParents) {
      if (pending.expiresAtMs > Date.now()) continue;
      this.metricParents.delete(threadId);
      this.options.onRunAttributionIncomplete?.();
    }
    for (const [threadId, pending] of this.metricTurns) {
      if (pending.expiresAtMs > Date.now()) continue;
      this.metricTurns.delete(threadId);
      if (this.metricParents.has(threadId)) this.options.onRunAttributionIncomplete?.();
    }
    let agentThreadId: string;
    if (event.type === "turn.started" || event.type === "turn.completed") {
      agentThreadId = event.threadId;
      const key = `${agentThreadId}\u0000${event.turnId}`;
      if (this.observedMetricTurns.has(key)) return;
      const previous = this.metricTurns.get(agentThreadId);
      if (previous && previous.turnId !== event.turnId && this.metricParents.has(agentThreadId)) this.options.onRunAttributionIncomplete?.();
      this.metricTurns.set(agentThreadId, { turnId: event.turnId, expiresAtMs: Date.now() + pendingTerminalTtlMs,
        sequence: previous?.turnId === event.turnId ? previous.sequence : this.metricSequence,
        started: event.type === "turn.started" || (previous?.turnId === event.turnId && previous.started) });
    } else if (event.type === "item.subagentActivity" && (event.kind === "started" || event.kind === "interacted")) {
      const key = `${event.threadId}\u0000${event.turnId}\u0000${event.itemId}`;
      if (this.observedMetricActivities.has(key)) return;
      this.observedMetricActivities.add(key);
      agentThreadId = event.agentThreadId;
      this.metricPaths.set(agentThreadId, event.agentPath);
      const existing = this.metricParents.get(agentThreadId);
      if (event.kind === "started" || (existing?.parentThreadId === event.threadId && existing.parentTurnId === event.turnId)) {
        this.metricParents.set(agentThreadId, { parentThreadId: event.threadId, parentTurnId: event.turnId,
          agentPath: event.agentPath, expiresAtMs: Date.now() + pendingTerminalTtlMs,
          ...(existing?.followupStart === undefined ? {} : { followupStart: existing.followupStart }) });
      }
    } else if (event.type === "item.operation.updated" && event.operation.kind === "subagent"
      && event.operation.action === "followup_task") {
      const operationKey = `${event.threadId}\u0000${event.turnId}\u0000${event.operation.itemId}`;
      if (event.operation.status === "running") {
        this.metricFollowupStarts.set(operationKey, this.metricSequence);
        this.trimMetricObservations();
        return;
      }
      if (event.operation.status !== "completed") return;
      const operationStart = this.metricFollowupStarts.get(operationKey);
      this.metricFollowupStarts.delete(operationKey);
      if (operationStart === undefined) {
        this.options.onRunAttributionIncomplete?.();
        return;
      }
      for (const receiver of event.operation.receiverThreadIds ?? []) {
        const candidate = this.metricTurns.get(receiver);
        // A prior terminal or unrelated running turn cannot belong to this followup.
        if (candidate && (!candidate.started || operationStart === undefined || candidate.sequence <= operationStart)) {
          this.metricTurns.delete(receiver);
          this.options.onRunAttributionIncomplete?.();
        }
        this.metricParents.set(receiver, { parentThreadId: event.threadId, parentTurnId: event.turnId,
          agentPath: this.metricPaths.get(receiver) ?? this.active.get(receiver)?.agentPath ?? "", expiresAtMs: Date.now() + pendingTerminalTtlMs,
          followupStart: operationStart });
        this.tryRecordMetricRun(receiver);
      }
      this.trimMetricObservations();
      return;
    } else if (event.type === "item.subagentActivity" && (event.kind === "completed" || event.kind === "interrupted")) {
      if (this.metricParents.delete(event.agentThreadId)) this.options.onRunAttributionIncomplete?.();
      return;
    } else return;
    this.tryRecordMetricRun(agentThreadId);
    this.trimMetricObservations();
  }

  private tryRecordMetricRun(agentThreadId: string): void {
    const parent = this.metricParents.get(agentThreadId);
    const turn = this.metricTurns.get(agentThreadId);
    if (parent?.followupStart !== undefined && (!turn?.started || turn.sequence <= parent.followupStart)) return;
    if (parent?.agentPath && turn) {
      this.recordMetricRun({ parentThreadId: parent.parentThreadId, parentTurnId: parent.parentTurnId,
        agentPath: parent.agentPath, agentThreadId, agentTurnId: turn.turnId });
      this.metricParents.delete(agentThreadId);
      this.metricTurns.delete(agentThreadId);
    }
  }

  private trimMetricObservations(): void {
    for (const pending of [this.metricParents, this.metricTurns, this.metricPaths]) {
      while (pending.size > maxPendingTerminals) {
        const threadId = pending.keys().next().value!;
        pending.delete(threadId);
        if (pending === this.metricParents || this.metricParents.has(threadId)) this.options.onRunAttributionIncomplete?.();
      }
    }
    for (const observed of [this.observedMetricTurns, this.observedMetricActivities, this.attributedMetricParents]) {
      while (observed.size > maxObservedFollowupOperations) {
        observed.delete(observed.values().next().value!);
        this.options.onRunAttributionIncomplete?.();
      }
    }
    while (this.metricFollowupStarts.size > maxPendingTerminals) {
      this.metricFollowupStarts.delete(this.metricFollowupStarts.keys().next().value!);
      this.options.onRunAttributionIncomplete?.();
    }
  }

  metricsAvailable(agentThreadId: string, agentTurnId?: string): void {
    if (this.closed || this.drainTask) return;
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
    ).catch((error: unknown) => {
      this.options.onReadError?.(error, agentThreadId);
      return false;
    });
    if (!entry.terminalStatus) return;
    this.schedule(agentThreadId, entry);
  }

  /** Called after lifecycle producers and their event queues have drained. */
  drain(): Promise<void> {
    this.drainTask ??= this.drainTerminals();
    return this.drainTask;
  }

  private async drainTerminals(): Promise<void> {
    const entries = [...this.active.values(), ...this.detached];
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), defaultSettleDelayMs);
    });
    try {
      await Promise.all(entries.map(async (entry) => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = undefined;
        // Supersede both timer callbacks and already waiting complete calls.
        entry.revision++;
        if (!entry.terminalStatus || entry.emitted) return;
        entry.metricsCheckpoint = Promise.race([
          entry.metricsCheckpoint ?? Promise.resolve(true),
          deadline,
        ]);
        await this.complete(entry.agentThreadId, entry, entry.revision, this.detached.has(entry));
      }));
    } finally {
      if (timer) clearTimeout(timer);
      this.close();
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.active.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.active.clear();
    this.detached.clear();
    this.pendingTerminals.clear();
    this.pendingStarts.clear();
    this.pendingActivities.clear();
    this.pendingCompletions.clear();
    this.pendingParentRuns.clear();
    this.metricParents.clear();
    this.attributedMetricParents.clear();
    this.metricTurns.clear();
    this.metricPaths.clear();
    this.metricFollowupStarts.clear();
    this.observedMetricTurns.clear();
    this.observedMetricActivities.clear();
    this.observedFollowupOperations.clear();
  }

  private markNativeCompletion(
    event: Extract<ConversationInputEvent, { type: "item.subagentActivity" }>,
  ): void {
    const entry = this.active.get(event.agentThreadId);
    if (!entry || !matchesParentRun(entry, event)) {
      this.rememberPendingCompletion(event);
      return;
    }
    this.pendingCompletions.delete(event.agentThreadId);
    this.markTerminal(event.agentThreadId, "completed", false);
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
      this.forgetParentRun(entry);
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
      agentThreadId: event.agentThreadId,
      agentPath: event.agentPath,
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
      this.forgetParentRun(entry);
      this.schedule(event.agentThreadId, entry);
    }
    const completion = this.takePendingCompletion(event.agentThreadId);
    if (completion && matchesParentRun(entry, completion.event)) {
      entry.terminalStatus = "completed";
      entry.terminalTurnId = entry.activeTurnId;
      this.forgetParentRun(entry);
      this.schedule(event.agentThreadId, entry);
    }
  }

  private rememberParentRun(
    run: PendingParentRun | Extract<OutputEvent, {
      type: "subagent.spawned" | "subagent.contacted";
    }> | Extract<ConversationInputEvent, { type: "item.subagentActivity" }>,
    allowSettled = false,
  ): void {
    const value: PendingParentRun = "parentThreadId" in run
      ? run
      : {
          parentThreadId: run.threadId,
          parentTurnId: run.turnId,
          agentThreadId: run.agentThreadId,
        };
    if (!allowSettled && this.parentRunSettled(value)) return;
    this.pendingParentRuns.set(parentRunKey(value), value);
  }

  private rememberFollowupOperation(run: PendingParentRun, itemId: string): boolean {
    const key = followupOperationKey(run, itemId);
    if (this.observedFollowupOperations.has(key)) return false;
    this.observedFollowupOperations.add(key);
    while (this.observedFollowupOperations.size > maxObservedFollowupOperations) {
      const oldest = this.observedFollowupOperations.values().next().value;
      if (!oldest) break;
      this.observedFollowupOperations.delete(oldest);
    }
    return true;
  }

  private forgetParentRun(
    run: ActiveSubagent | Extract<ConversationInputEvent, { type: "item.subagentActivity" }>,
  ): void {
    const value: PendingParentRun = "parentThreadId" in run
      ? run
      : {
          parentThreadId: run.threadId,
          parentTurnId: run.turnId,
          agentThreadId: run.agentThreadId,
        };
    this.pendingParentRuns.delete(parentRunKey(value));
  }

  private parentRunSettled(run: PendingParentRun): boolean {
    const active = this.active.get(run.agentThreadId);
    if (
      active?.terminalStatus
      && active.parentThreadId === run.parentThreadId
      && active.parentTurnId === run.parentTurnId
    ) return true;
    const completion = this.pendingCompletions.get(run.agentThreadId)?.event;
    return completion?.threadId === run.parentThreadId
      && completion.turnId === run.parentTurnId;
  }

  private assignTurn(
    agentThreadId: string,
    entry: ActiveSubagent,
    agentTurnId: string,
  ): void {
    entry.activeTurnId = agentTurnId;
    this.rememberParentRun(entry);
    if (entry.terminalStatus && entry.terminalTurnId === undefined) {
      entry.terminalTurnId = agentTurnId;
      this.schedule(agentThreadId, entry);
    }
  }

  private recordMetricRun(details: Parameters<NonNullable<SubagentCompletionTrackerOptions["onRunStarted"]>>[0]): void {
    const key = `${details.agentThreadId}\u0000${details.agentTurnId}`;
    if (this.observedMetricTurns.has(key)) return;
    this.observedMetricTurns.add(key);
    this.attributedMetricParents.add(`${details.parentThreadId}\u0000${details.parentTurnId}\u0000${details.agentThreadId}`);
    this.options.onRunStarted?.(details);
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
    this.detached.add(previous);
    void this.complete(agentThreadId, previous, previous.revision, true);
    this.register(pendingActivity.event);
  }

  private prunePendingActivities(): void {
    const now = Date.now();
    for (const [threadId, pending] of this.pendingActivities) {
      if (pending.expiresAtMs <= now) this.pendingActivities.delete(threadId);
    }
  }

  private rememberPendingCompletion(
    event: Extract<ConversationInputEvent, { type: "item.subagentActivity" }>,
  ): void {
    this.prunePendingCompletions();
    this.pendingCompletions.delete(event.agentThreadId);
    this.pendingCompletions.set(event.agentThreadId, {
      event,
      expiresAtMs: Date.now() + pendingTerminalTtlMs,
    });
    while (this.pendingCompletions.size > maxPendingTerminals) {
      const oldest = this.pendingCompletions.keys().next().value;
      if (!oldest) break;
      this.pendingCompletions.delete(oldest);
    }
  }

  private takePendingCompletion(agentThreadId: string): PendingCompletion | undefined {
    this.prunePendingCompletions();
    const pending = this.pendingCompletions.get(agentThreadId);
    this.pendingCompletions.delete(agentThreadId);
    return pending;
  }

  private prunePendingCompletions(): void {
    const now = Date.now();
    for (const [threadId, pending] of this.pendingCompletions) {
      if (pending.expiresAtMs <= now) this.pendingCompletions.delete(threadId);
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
      this.closed || entry.emitted || entry.revision !== revision
      || (!detached && this.active.get(agentThreadId) !== entry)
    ) return;
    const metricsPersisted = await (entry.metricsCheckpoint ?? Promise.resolve(true));
    if (
      this.closed || entry.emitted || entry.revision !== revision
      || (!detached && this.active.get(agentThreadId) !== entry)
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
      ...(entry.terminalTurnId !== undefined && summary?.latestTurn?.upstreamTtftMs != null
        ? { upstreamTtftMs: summary.latestTurn.upstreamTtftMs } : {}),
      status: entry.terminalStatus ?? "errored",
      requestCount: aggregate?.requestCount ?? 0,
      unsuccessfulRequestCount: aggregate?.unsuccessfulRequestCount ?? 0,
      inputTokens: aggregate?.inputTokens ?? 0,
      cachedInputTokens: aggregate?.cachedInputTokens ?? null,
      outputTokens: aggregate?.outputTokens ?? 0,
      reasoningOutputTokens: aggregate?.reasoningOutputTokens ?? 0,
    };
    entry.emitted = true;
    this.detached.delete(entry);
    if (!detached) this.active.delete(agentThreadId);
    this.options.publish(event);
    this.options.onCompleted?.(event);
  }

}

function turnCompletionStatus(
  status: "completed" | "interrupted" | "failed" | "inProgress",
): SubagentTerminalStatus | undefined {
  if (status === "interrupted") return status;
  return status === "failed" ? "errored" : undefined;
}

function completionStatus(
  status: SubagentStatus,
): SubagentTerminalStatus | undefined {
  return status === "pendingInit" || status === "running" || status === "completed"
    ? undefined
    : status;
}

function matchesParentRun(
  entry: ActiveSubagent,
  event: Extract<ConversationInputEvent, { type: "item.subagentActivity" }>,
): boolean {
  return entry.parentThreadId === event.threadId
    && entry.parentTurnId === event.turnId
    && entry.agentPath === event.agentPath;
}

function parentRunKey(run: PendingParentRun): string {
  return [
    run.parentThreadId,
    run.parentTurnId,
    run.agentThreadId,
  ].join("\u0000");
}

function followupOperationKey(run: PendingParentRun, itemId: string): string {
  return `${parentRunKey(run)}\u0000${itemId}`;
}

function pendingTerminalKey(agentThreadId: string, agentTurnId?: string): string {
  return `${agentThreadId}\u0000${agentTurnId ?? ""}`;
}
