import type { EventBus } from "../event-bus/index.js";
import {
  conversationTargetKey,
  gatewayUserMessageClientIdPrefix,
  type ConversationTarget,
  type MessagePhase,
  type OutputEvent,
  type RateLimitSnapshot,
  type ThreadGoal,
  type ThreadTokenUsage,
  type TurnErrorCode,
  type TurnStartIdentity,
  type TurnArtifacts,
  isCriticalOutputEvent,
  usesOpenAiAccount,
} from "./events.js";
import type { ConversationInputEvent } from "./input-events.js";
import type { ConversationRoutingPort } from "./routing-port.js";
import { TurnTimingAccumulator } from "./turn-timing-accumulator.js";

interface ActiveTurn {
  target: ConversationTarget;
  threadId: string;
  turnId: string;
}

interface ReasoningState {
  turnId: string;
  startedAtMs: number;
  segmentActive: boolean;
  timer?: NodeJS.Timeout;
}

type WithoutTarget<T> = T extends unknown ? Omit<T, "target"> : never;
type UntargetedOutputEvent = WithoutTarget<OutputEvent>;

export class ConversationCore {
  private readonly activeByThread = new Map<string, ActiveTurn>();
  private readonly errorsByTurn = new Map<string, { message: string; errorCode?: TurnErrorCode }>();
  private readonly usageByThread = new Map<string, ThreadTokenUsage>();
  private readonly usageTurnByThread = new Map<string, string>();
  private readonly goalsByThread = new Map<string, ThreadGoal>();
  private readonly contextCompactionItemIdsByThread = new Map<string, Set<string>>();
  private readonly seenUserMessages = new Set<string>();
  private readonly phaseByItem = new Map<string, MessagePhase | null>();
  private readonly artifactsByThread = new Map<string, TurnArtifacts>();
  private readonly timingByThread = new Map<string, TurnTimingAccumulator>();
  private readonly mcpStatus = new Map<string, string>();
  private readonly unhealthyMcpServers = new Set<string>();
  private readonly reasoningByThread = new Map<string, ReasoningState>();
  private accountStatus: string | undefined;
  private readonly rateLimitNotices = new Map<string, string>();
  private readonly rateLimitSnapshots = new Map<string, RateLimitSnapshot>();

  constructor(
    private readonly router: ConversationRoutingPort,
    private readonly output: EventBus<OutputEvent>,
  ) {}

  markTurnStarted(
    target: ConversationTarget,
    threadId: string,
    turnId: string,
    identity?: TurnStartIdentity,
  ): void {
    const current = this.activeByThread.get(threadId);
    if (current?.threadId === threadId && current.turnId === turnId) {
      return;
    }
    const artifacts = this.artifactsByThread.get(threadId);
    if (artifacts?.turnId !== turnId) {
      this.artifactsByThread.set(threadId, { threadId, turnId });
    }
    this.activeByThread.set(threadId, { target, threadId, turnId });
    this.publish({
      type: "turn.started",
      target,
      threadId,
      turnId,
      ...(identity ? { identity } : {}),
      ...(this.isBackgroundThread(threadId) ? { background: true } : {}),
    });
  }

  activeTurn(target: ConversationTarget): ActiveTurn | undefined {
    const threadId = this.router.foregroundThreadId?.(target);
    if (threadId) return this.activeByThread.get(threadId);
    return [...this.activeByThread.values()].find(
      (active) => this.key(active.target) === this.key(target)
        && !this.isBackgroundThread(active.threadId),
    );
  }

  activeTurnForThread(threadId: string): ActiveTurn | undefined {
    return this.activeByThread.get(threadId);
  }

  hasActiveTurns(): boolean {
    return this.activeByThread.size > 0;
  }

  tokenUsage(threadId: string): ThreadTokenUsage | undefined {
    return this.usageByThread.get(threadId);
  }

  goal(threadId: string): ThreadGoal | undefined {
    return this.goalsByThread.get(threadId);
  }

  private rememberContextCompactions(threadId: string, itemIds: readonly string[]): void {
    const known = this.contextCompactionItemIdsByThread.get(threadId) ?? new Set<string>();
    for (const itemId of itemIds) {
      known.add(itemId);
    }
    this.contextCompactionItemIdsByThread.set(threadId, known);
  }

  contextCompactionCount(threadId: string): number | undefined {
    const restored = this.router.contextCompactionItemIdsForThread(threadId);
    const live = this.contextCompactionItemIdsByThread.get(threadId);
    if (restored === undefined && live === undefined) {
      return undefined;
    }
    return new Set([...(restored ?? []), ...(live ?? [])]).size;
  }

  rememberRateLimits(snapshots: readonly RateLimitSnapshot[]): void {
    for (const snapshot of snapshots) {
      const limitId = snapshot.limitId ?? "codex";
      this.rateLimitSnapshots.set(
        limitId,
        mergeRateLimitSnapshot(this.rateLimitSnapshots.get(limitId), snapshot, limitId),
      );
    }
  }

  weeklyRateLimit(): NonNullable<RateLimitSnapshot["secondary"]> | undefined {
    const snapshot = this.rateLimitSnapshots.get("codex");
    if (!snapshot) {
      return undefined;
    }
    for (const window of [snapshot.secondary, snapshot.primary]) {
      if (window?.windowDurationMins === 10_080) {
        return window;
      }
    }
    return undefined;
  }

  artifacts(threadId: string): TurnArtifacts | undefined {
    return this.artifactsByThread.get(threadId);
  }

  connectionLost(message: string, affectedThreadIds?: ReadonlySet<string>): void {
    if (affectedThreadIds) {
      for (const [threadId, active] of this.activeByThread) {
        if (affectedThreadIds.has(active.threadId)) {
          this.activeByThread.delete(threadId);
        }
      }
      for (const threadId of affectedThreadIds) {
        this.usageByThread.delete(threadId);
        this.usageTurnByThread.delete(threadId);
        this.goalsByThread.delete(threadId);
        this.contextCompactionItemIdsByThread.delete(threadId);
        this.artifactsByThread.delete(threadId);
        this.timingByThread.delete(threadId);
        this.disposeReasoning(threadId);
      }
      this.publishConnectionNotice("connection.lost", message, affectedThreadIds);
      return;
    }
    this.activeByThread.clear();
    this.errorsByTurn.clear();
    this.usageByThread.clear();
    this.usageTurnByThread.clear();
    this.goalsByThread.clear();
    this.contextCompactionItemIdsByThread.clear();
    this.seenUserMessages.clear();
    this.phaseByItem.clear();
    this.timingByThread.clear();
    for (const state of this.reasoningByThread.values()) {
      if (state.timer !== undefined) {
        clearInterval(state.timer);
      }
    }
    this.reasoningByThread.clear();
    this.mcpStatus.clear();
    this.unhealthyMcpServers.clear();
    this.publishConnectionNotice("connection.lost", message);
  }

  connectionRestored(message: string, affectedThreadIds?: ReadonlySet<string>): void {
    this.publishConnectionNotice("connection.restored", message, affectedThreadIds);
  }

  handle(event: ConversationInputEvent): void {
    switch (event.type) {
      case "turn.started": {
        this.clearReasoning(event.threadId);
        this.disposeReasoning(event.threadId);
        this.timingByThread.set(
          event.threadId,
          new TurnTimingAccumulator(event.turnId, event.receivedAtMs),
        );
        const target = this.router.targetForThread(event.threadId);
        if (target) {
          this.markTurnStarted(target, event.threadId, event.turnId);
        }
        return;
      }
      case "thread.tokenUsage.updated":
        this.usageByThread.set(event.threadId, event.tokenUsage);
        this.usageTurnByThread.set(event.threadId, event.turnId);
        return;
      case "thread.goal.updated":
        this.goalsByThread.set(event.threadId, event.goal);
        return;
      case "thread.goal.cleared":
        this.goalsByThread.delete(event.threadId);
        return;
      case "thread.reverted":
        // Revert changes durable history, not local files. Drop only derived
        // displays; an active turn is left in activeByThread so the official
        // interrupted turn/completed event can close it normally.
        this.usageByThread.delete(event.threadId);
        this.usageTurnByThread.delete(event.threadId);
        this.goalsByThread.delete(event.threadId);
        this.contextCompactionItemIdsByThread.delete(event.threadId);
        this.artifactsByThread.delete(event.threadId);
        this.timingByThread.delete(event.threadId);
        this.disposeReasoning(event.threadId);
        return;
      case "turn.diff.updated": {
        const current = this.artifactsByThread.get(event.threadId);
        this.artifactsByThread.set(event.threadId, {
          ...(current?.turnId === event.turnId
            ? current
            : { threadId: event.threadId, turnId: event.turnId }),
          threadId: event.threadId,
          turnId: event.turnId,
          diff: event.diff,
        });
        return;
      }
      case "turn.plan.updated": {
        const current = this.artifactsByThread.get(event.threadId);
        this.artifactsByThread.set(event.threadId, {
          ...(current?.turnId === event.turnId
            ? current
            : { threadId: event.threadId, turnId: event.turnId }),
          threadId: event.threadId,
          turnId: event.turnId,
          plan: { explanation: event.explanation, steps: event.plan },
        });
        this.publishForThread(event.threadId, {
          type: "plan.updated",
          threadId: event.threadId,
          turnId: event.turnId,
          explanation: event.explanation,
          steps: event.plan,
        });
        return;
      }
      case "item.agentMessage.started":
        this.phaseByItem.set(
          this.itemKey(event.threadId, event.turnId, event.itemId),
          event.phase,
        );
        return;
      case "item.agentMessage.delta": {
        this.clearReasoning(event.threadId, event.turnId);
        const key = this.itemKey(event.threadId, event.turnId, event.itemId);
        const phase = this.phaseByItem.get(key);
        if (event.receivedAtMs !== undefined) {
          this.timingByThread.get(event.threadId)?.recordAgentMessageDelta(
            event.turnId,
            key,
            event.receivedAtMs,
            phase === "final_answer",
          );
        }
        this.publishForThread(event.threadId, {
          type: "text.delta",
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          text: event.text,
          ...(phase !== undefined ? { phase } : {}),
        });
        return;
      }
      case "item.reasoning.delta": {
        const current = this.reasoningByThread.get(event.threadId);
        if (current !== undefined && current.turnId !== event.turnId) {
          if (current.timer !== undefined) {
            clearInterval(current.timer);
          }
        }
        const state = current?.turnId === event.turnId
          ? current
          : {
              turnId: event.turnId,
              startedAtMs: 0,
              segmentActive: false,
            };
        if (!state.segmentActive) {
          state.segmentActive = true;
          state.startedAtMs = Date.now();
          this.publishForThread(event.threadId, {
            type: "turn.reasoning",
            threadId: event.threadId,
            turnId: event.turnId,
            summary: "",
            elapsedMs: Date.now() - state.startedAtMs,
          });
          state.timer = setInterval(() => {
            const latest = this.reasoningByThread.get(event.threadId);
            if (latest !== state || !state.segmentActive) {
              return;
            }
            this.publishForThread(event.threadId, {
              type: "turn.reasoning",
              threadId: event.threadId,
              turnId: state.turnId,
              summary: "",
              elapsedMs: Date.now() - state.startedAtMs,
            });
          }, 1_000);
          state.timer.unref();
        }
        this.reasoningByThread.set(event.threadId, state);
        return;
      }
      case "turn.modelTiming.updated": {
        this.timingByThread.get(event.threadId)?.recordModelTiming(event);
        return;
      }
      case "item.agentMessage.completed": {
        const key = this.itemKey(event.threadId, event.turnId, event.itemId);
        const phase = event.phase ?? this.phaseByItem.get(key) ?? null;
        this.publishForThread(event.threadId, {
          type: "text.completed",
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          text: event.text,
          phase,
        });
        this.phaseByItem.delete(key);
        return;
      }
      case "item.userMessage":
        this.publishUserMessage(event);
        return;
      case "item.operation.updated":
        this.clearReasoning(event.threadId, event.turnId);
        if (
          event.operation.kind === "contextCompaction"
          && event.operation.status === "completed"
        ) {
          this.rememberContextCompactions(event.threadId, [event.operation.itemId]);
        }
        this.publishForThread(event.threadId, {
          type: "operation.updated",
          threadId: event.threadId,
          turnId: event.turnId,
          operation: event.operation,
        });
        return;
      case "item.subagentActivity":
        if (event.kind === "interrupted") {
          return;
        }
        this.publishForThread(event.threadId, {
          type: event.kind === "started" ? "subagent.spawned" : "subagent.contacted",
          threadId: event.threadId,
          turnId: event.turnId,
          agentThreadId: event.agentThreadId,
          agentPath: event.agentPath,
        });
        return;
      case "turn.error":
        this.clearReasoning(event.threadId, event.turnId);
        if (!event.willRetry) {
          this.errorsByTurn.set(event.turnId, {
            message: event.message,
            ...(event.errorCode ? { errorCode: event.errorCode } : {}),
          });
        }
        return;
      case "turn.completed": {
        this.clearReasoning(event.threadId, event.turnId);
        this.clearSeenUserMessages(event.threadId, event.turnId);
        this.clearItemPhases(event.threadId, event.turnId);
        const target = this.router.targetForThread(event.threadId);
        if (!target) {
          this.timingByThread.delete(event.threadId);
          return;
        }
        const active = this.activeByThread.get(event.threadId);
        if (active?.turnId === event.turnId) {
          this.activeByThread.delete(event.threadId);
        }
        const storedError = this.errorsByTurn.get(event.turnId);
        const resolvedError = event.error === null
          ? storedError
          : {
              message: event.error,
              ...(event.errorCode ? { errorCode: event.errorCode } : {}),
            };
        const tokenUsage = this.usageTurnByThread.get(event.threadId) === event.turnId
          ? this.usageByThread.get(event.threadId)
          : undefined;
        const modelSettings = this.router.modelSettingsForThread(event.threadId);
        const workspace = this.router.workspaceForThread?.(event.threadId);
        const weeklyLimit = usesOpenAiAccount(modelSettings?.modelProvider)
          ? this.weeklyRateLimit()
          : undefined;
        const goal = this.goalsByThread.get(event.threadId);
        const contextCompactionCount = this.contextCompactionCount(event.threadId);
        const timing = this.timingByThread.get(event.threadId)?.output(
          event.turnId,
          supportsDetailedModelTiming(modelSettings?.modelProvider),
          tokenUsage?.last,
        );
        this.timingByThread.delete(event.threadId);
        this.errorsByTurn.delete(event.turnId);
        this.publish({
          type: "turn.completed",
          target,
          threadId: event.threadId,
          turnId: event.turnId,
          status: event.status,
          ...(resolvedError ? { error: resolvedError.message } : {}),
          ...(resolvedError?.errorCode ? { errorCode: resolvedError.errorCode } : {}),
          ...(event.durationMs === undefined
            ? {}
            : { durationMs: event.durationMs }),
          ...(timing ? { timing } : {}),
          ...(tokenUsage ? { tokenUsage } : {}),
          ...(modelSettings
            ? {
                model: modelSettings.model,
                modelProvider: modelSettings.modelProvider ?? "openai",
                effort: modelSettings.effort,
                serviceTier: modelSettings.serviceTier,
              }
            : {}),
          ...(weeklyLimit ? { weeklyLimit } : {}),
          ...(goal ? { goal } : {}),
          ...(contextCompactionCount !== undefined ? { contextCompactionCount } : {}),
          ...(workspace
            ? { workspaceId: workspace.id, workspaceName: workspace.name }
            : {}),
          ...(this.isBackgroundThread(event.threadId) ? { background: true } : {}),
        });
        return;
      }
      case "thread.status.changed":
        this.publishForThread(event.threadId, {
          type: "thread.status",
          threadId: event.threadId,
          status: event.status,
        });
        return;
      case "thread.closed":
      case "thread.archived":
      case "thread.deleted": {
        const target = this.router.targetForThread(event.threadId);
        this.usageByThread.delete(event.threadId);
        this.usageTurnByThread.delete(event.threadId);
        this.goalsByThread.delete(event.threadId);
        this.contextCompactionItemIdsByThread.delete(event.threadId);
        this.timingByThread.delete(event.threadId);
        this.disposeReasoning(event.threadId);
        this.clearSeenUserMessages(event.threadId);
        this.clearItemPhases(event.threadId);
        this.artifactsByThread.delete(event.threadId);
        if (target) {
          this.activeByThread.delete(event.threadId);
        }
        return;
      }
      case "account.updated": {
        const fingerprint = `${event.authMode ?? ""}:${event.planType ?? ""}`;
        if (fingerprint !== this.accountStatus) {
          this.accountStatus = fingerprint;
          this.broadcastForProvider(event.modelProvider, {
            type: "account.updated",
            authMode: event.authMode,
            planType: event.planType,
          });
        }
        return;
      }
      case "account.rateLimits.updated": {
        const limitId = event.rateLimits.limitId ?? "codex";
        const rateLimits = mergeRateLimitSnapshot(
          this.rateLimitSnapshots.get(limitId),
          event.rateLimits,
          limitId,
        );
        this.rateLimitSnapshots.set(limitId, rateLimits);
        const fingerprint = rateLimitNoticeFingerprint(rateLimits);
        const previous = this.rateLimitNotices.get(limitId);
        if (fingerprint) {
          this.rateLimitNotices.set(limitId, fingerprint);
        } else {
          this.rateLimitNotices.delete(limitId);
        }
        if (fingerprint && fingerprint !== previous) {
          this.broadcastForProvider(event.modelProvider, {
            type: "account.rateLimits.updated",
            rateLimits,
          });
        }
        return;
      }
      case "mcp.status.updated": {
        const key = `${event.modelProvider ?? "global"}:${event.threadId ?? "global"}:${event.name}`;
        const fingerprint =
          `${event.status}:${event.error ?? ""}:${event.failureReason ?? ""}`;
        const previous = this.mcpStatus.get(key);
        if (previous === fingerprint) {
          return;
        }
        this.mcpStatus.set(key, fingerprint);
        if (event.status === "failed" || event.status === "cancelled") {
          this.unhealthyMcpServers.add(key);
        }
        const recovered = event.status === "ready"
          && this.unhealthyMcpServers.delete(key);
        if (
          event.status !== "failed"
          && event.status !== "cancelled"
          && !recovered
        ) {
          return;
        }
        const outputEvent = {
          type: "mcp.status.updated" as const,
          threadId: event.threadId,
          name: event.name,
          status: event.status,
          error: event.error,
          failureReason: event.failureReason,
        };
        if (event.threadId) {
          this.publishForThread(event.threadId, outputEvent);
        } else {
          this.broadcastForProvider(event.modelProvider, outputEvent);
        }
        return;
      }
      case "mcp.oauth.completed": {
        if (!event.threadId) {
          return;
        }
        const outputEvent = {
          type: "mcp.oauth.completed" as const,
          threadId: event.threadId,
          name: event.name,
          success: event.success,
          error: event.error,
        };
        this.publishForThread(event.threadId, outputEvent);
        return;
      }
      case "warning":
        if (event.threadId) {
          this.publishForThread(event.threadId, {
            type: "warning",
            threadId: event.threadId,
            message: event.message,
          });
        } else {
          this.broadcastForProvider(event.modelProvider, {
            type: "warning",
            message: event.message,
          });
        }
        return;
    }
  }

  private publishForThread(
    threadId: string,
    event: UntargetedOutputEvent,
  ): void {
    const target = this.router.targetForThread(threadId);
    if (target) {
      this.publish({
        ...event,
        target,
        ...(this.isBackgroundThread(threadId) ? { background: true } : {}),
      });
    }
  }

  private clearReasoning(threadId: string, turnId?: string): void {
    const current = this.reasoningByThread.get(threadId);
    if (current !== undefined && (turnId === undefined || current.turnId === turnId)) {
      if (current.segmentActive) {
        current.segmentActive = false;
        this.publishForThread(threadId, {
          type: "turn.reasoning",
          threadId,
          turnId: current.turnId,
          summary: "",
          elapsedMs: Date.now() - current.startedAtMs,
          final: true,
        });
      }
      if (current.timer !== undefined) {
        clearInterval(current.timer);
        delete current.timer;
      }
    }
  }

  private disposeReasoning(threadId: string): void {
    const current = this.reasoningByThread.get(threadId);
    if (current?.timer !== undefined) {
      clearInterval(current.timer);
    }
    this.reasoningByThread.delete(threadId);
  }

  private isBackgroundThread(threadId: string): boolean {
    return this.router.isBackgroundThread?.(threadId) ?? false;
  }

  private publishConnectionNotice(
    type: "connection.lost" | "connection.restored",
    message: string,
    threadIds?: ReadonlySet<string>,
  ): void {
    for (const binding of this.router.allBindings()) {
      if (threadIds === undefined || threadIds.has(binding.threadId)) {
        this.publish({
          type,
          target: binding.target,
          threadId: binding.threadId,
          message,
        });
      }
    }
  }

  private publishUserMessage(
    event: Extract<ConversationInputEvent, { type: "item.userMessage" }>,
  ): void {
    const messageKey = `${event.threadId}:${event.turnId}:${event.itemId}`;
    if (this.seenUserMessages.has(messageKey)) {
      return;
    }
    this.seenUserMessages.add(messageKey);
    if (event.clientId?.startsWith(gatewayUserMessageClientIdPrefix)) {
      return;
    }
    const target = this.router.targetForThread(event.threadId);
    if (!target) {
      return;
    }
    this.markTurnStarted(target, event.threadId, event.turnId);
    this.publish({
      type: "user.message",
      target,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      text: event.text,
      ...(this.isBackgroundThread(event.threadId) ? { background: true } : {}),
    });
  }

  private clearSeenUserMessages(threadId: string, turnId?: string): void {
    const prefix = turnId ? `${threadId}:${turnId}:` : `${threadId}:`;
    for (const key of this.seenUserMessages) {
      if (key.startsWith(prefix)) {
        this.seenUserMessages.delete(key);
      }
    }
  }

  private clearItemPhases(threadId: string, turnId?: string): void {
    const prefix = turnId ? `${threadId}:${turnId}:` : `${threadId}:`;
    for (const key of this.phaseByItem.keys()) {
      if (key.startsWith(prefix)) {
        this.phaseByItem.delete(key);
      }
    }
  }

  private itemKey(threadId: string, turnId: string, itemId: string): string {
    return `${threadId}:${turnId}:${itemId}`;
  }


  private publish(event: OutputEvent): void {
    this.output.publish(event, isCriticalOutputEvent(event));
  }

  private broadcast(event: UntargetedOutputEvent): void {
    const seen = new Set<string>();
    for (const binding of this.router.allBindings()) {
      const key = this.key(binding.target);
      if (!seen.has(key)) {
        seen.add(key);
        this.publish({ ...event, target: binding.target });
      }
    }
  }

  private broadcastForProvider(
    modelProvider: string | undefined,
    event: UntargetedOutputEvent,
  ): void {
    if (!modelProvider) {
      this.broadcast(event);
      return;
    }
    const seen = new Set<string>();
    for (const binding of this.router.allBindings()) {
      const provider = this.router.modelSettingsForThread(binding.threadId)?.modelProvider
        ?? "openai";
      const key = this.key(binding.target);
      if (provider === modelProvider && !seen.has(key)) {
        seen.add(key);
        this.publish({ ...event, target: binding.target });
      }
    }
  }

  private key(target: ConversationTarget): string {
    return conversationTargetKey(target);
  }
}

function supportsDetailedModelTiming(modelProvider: string | undefined): boolean {
  return modelProvider === "deepseek"
    || modelProvider === "opencode-go"
    || (typeof modelProvider === "string" && modelProvider.startsWith("opencode-go-"));
}

function rateLimitNoticeFingerprint(snapshot: RateLimitSnapshot): string | undefined {
  const reached = snapshot.rateLimitReachedType;
  const primaryThreshold = rateLimitThreshold(snapshot.primary?.usedPercent);
  const secondaryThreshold = rateLimitThreshold(snapshot.secondary?.usedPercent);
  if (!reached && primaryThreshold === 0 && secondaryThreshold === 0) {
    return undefined;
  }
  return `${snapshot.limitId ?? "codex"}:${reached ?? ""}:${primaryThreshold}:${secondaryThreshold}`;
}

function rateLimitThreshold(used: number | undefined): number {
  return used === undefined ? 0 : used >= 100 ? 100 : used >= 90 ? 90 : used >= 80 ? 80 : 0;
}

function mergeRateLimitSnapshot(
  current: RateLimitSnapshot | undefined,
  update: RateLimitSnapshot,
  limitId: string,
): RateLimitSnapshot {
  return {
    limitId: update.limitId ?? current?.limitId ?? limitId,
    limitName: update.limitName ?? current?.limitName ?? null,
    primary: mergeRateLimitWindow(current?.primary, update.primary),
    secondary: mergeRateLimitWindow(current?.secondary, update.secondary),
    credits: update.credits
      ? {
          ...update.credits,
          balance: update.credits.balance ?? current?.credits?.balance ?? null,
        }
      : current?.credits ?? null,
    individualLimit: update.individualLimit ?? current?.individualLimit ?? null,
    spendControlReached: update.spendControlReached ?? current?.spendControlReached ?? null,
    planType: update.planType ?? current?.planType ?? null,
    rateLimitReachedType: update.rateLimitReachedType,
  };
}

function mergeRateLimitWindow(
  current: RateLimitSnapshot["primary"] | undefined,
  update: RateLimitSnapshot["primary"],
): RateLimitSnapshot["primary"] {
  return update
    ? {
        usedPercent: update.usedPercent,
        windowDurationMins: update.windowDurationMins ?? current?.windowDurationMins ?? null,
        resetsAt: update.resetsAt ?? current?.resetsAt ?? null,
      }
    : current ?? null;
}
