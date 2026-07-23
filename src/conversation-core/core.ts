import type {
  AuthMode,
  McpServerStartupFailureReason,
  McpServerStartupState,
  MessagePhase,
  PlanType,
  RateLimitReachedType,
  RateLimitSnapshot,
  ThreadTokenUsage,
  TurnPlanStep,
} from "../codex-protocol/index.js";
import type { EventBus } from "../event-bus/index.js";
import {
  conversationTargetKey,
  gatewayUserMessageClientIdPrefix,
  type ConversationTarget,
  type OutputEvent,
  type TurnArtifacts,
  isCriticalOutputEvent,
} from "./events.js";
import type { ConversationRoutingPort } from "./routing-port.js";
import { parseOperationUpdate, sanitizeOperationText } from "./operation.js";

export interface CodexNotification {
  method: string;
  params: unknown;
}

interface ActiveTurn {
  target: ConversationTarget;
  threadId: string;
  turnId: string;
}

type WithoutTarget<T> = T extends unknown ? Omit<T, "target"> : never;
type UntargetedOutputEvent = WithoutTarget<OutputEvent>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = record?.[name];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, name: string): number | undefined {
  const value = record?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class ConversationCore {
  private readonly activeByConversation = new Map<string, ActiveTurn>();
  private readonly errorsByTurn = new Map<string, string>();
  private readonly usageByThread = new Map<string, ThreadTokenUsage>();
  private readonly usageTurnByThread = new Map<string, string>();
  private readonly seenUserMessages = new Set<string>();
  private readonly phaseByItem = new Map<string, MessagePhase | null>();
  private readonly artifactsByThread = new Map<string, TurnArtifacts>();
  private readonly mcpStatus = new Map<string, string>();
  private accountStatus: string | undefined;
  private readonly rateLimitNotices = new Map<string, string>();
  private readonly rateLimitSnapshots = new Map<string, RateLimitSnapshot>();

  constructor(
    private readonly router: ConversationRoutingPort,
    private readonly output: EventBus<OutputEvent>,
  ) {}

  markTurnStarted(target: ConversationTarget, threadId: string, turnId: string): void {
    const current = this.activeByConversation.get(this.key(target));
    if (current?.threadId === threadId && current.turnId === turnId) {
      return;
    }
    const artifacts = this.artifactsByThread.get(threadId);
    if (artifacts?.turnId !== turnId) {
      this.artifactsByThread.set(threadId, { threadId, turnId });
    }
    this.activeByConversation.set(this.key(target), { target, threadId, turnId });
    this.publish({ type: "turn.started", target, threadId, turnId });
  }

  activeTurn(target: ConversationTarget): ActiveTurn | undefined {
    return this.activeByConversation.get(this.key(target));
  }

  tokenUsage(threadId: string): ThreadTokenUsage | undefined {
    return this.usageByThread.get(threadId);
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

  connectionLost(message: string): void {
    this.activeByConversation.clear();
    this.errorsByTurn.clear();
    this.usageByThread.clear();
    this.usageTurnByThread.clear();
    this.seenUserMessages.clear();
    this.phaseByItem.clear();
    this.mcpStatus.clear();
    for (const binding of this.router.allBindings()) {
      this.publish({
        type: "connection.lost",
        target: binding.target,
        threadId: binding.threadId,
        message,
      });
    }
  }

  handle(notification: CodexNotification): void {
    const params = asRecord(notification.params);
    const threadId = stringField(params, "threadId");

    switch (notification.method) {
      case "turn/started": {
        const turn = asRecord(params?.turn);
        const turnId = stringField(turn, "id");
        const target = threadId ? this.router.targetForThread(threadId) : undefined;
        if (threadId && turnId && target) {
          this.markTurnStarted(target, threadId, turnId);
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const turnId = stringField(params, "turnId");
        const tokenUsage = parseThreadTokenUsage(asRecord(params?.tokenUsage));
        if (threadId && turnId && tokenUsage) {
          this.usageByThread.set(threadId, tokenUsage);
          this.usageTurnByThread.set(threadId, turnId);
        }
        return;
      }
      case "turn/diff/updated": {
        const turnId = stringField(params, "turnId");
        const diff = stringField(params, "diff");
        if (threadId && turnId && diff !== undefined) {
          const current = this.artifactsByThread.get(threadId);
          this.artifactsByThread.set(threadId, {
            ...(current?.turnId === turnId ? current : { threadId, turnId }),
            threadId,
            turnId,
            diff,
          });
        }
        return;
      }
      case "turn/plan/updated": {
        const turnId = stringField(params, "turnId");
        const explanation = params?.explanation;
        const plan = parsePlanSteps(params?.plan);
        if (threadId && turnId && plan && (typeof explanation === "string" || explanation === null)) {
          const current = this.artifactsByThread.get(threadId);
          this.artifactsByThread.set(threadId, {
            ...(current?.turnId === turnId ? current : { threadId, turnId }),
            threadId,
            turnId,
            plan: { explanation, steps: plan },
          });
        }
        return;
      }
      case "item/agentMessage/delta": {
        const turnId = stringField(params, "turnId");
        const itemId = stringField(params, "itemId");
        const text = stringField(params, "delta");
        if (threadId && turnId && itemId && text) {
          const phase = this.phaseByItem.get(this.itemKey(threadId, turnId, itemId));
          this.publishForThread(threadId, {
            type: "text.delta",
            threadId,
            turnId,
            itemId,
            text,
            ...(phase !== undefined ? { phase } : {}),
          });
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        const turnId = stringField(params, "turnId");
        const item = asRecord(params?.item);
        const itemId = stringField(item, "id");
        if (threadId && turnId && item?.type === "agentMessage" && itemId) {
          const key = this.itemKey(threadId, turnId, itemId);
          const phase = messagePhase(item.phase);
          if (notification.method === "item/started") {
            this.phaseByItem.set(key, phase);
          } else {
            const resolvedPhase = phase ?? this.phaseByItem.get(key) ?? null;
            if (typeof item.text === "string") {
              this.publishForThread(threadId, {
                type: "text.completed",
                threadId,
                turnId,
                itemId,
                text: item.text,
                phase: resolvedPhase,
              });
            }
            this.phaseByItem.delete(key);
          }
          return;
        }
        if (threadId && turnId && item?.type === "userMessage") {
          this.publishUserMessage(threadId, turnId, item);
          return;
        }
        if (threadId && turnId && item) {
          const operation = parseOperationUpdate(
            item,
            notification.method === "item/started" ? "started" : "completed",
          );
          if (operation) {
            this.publishForThread(threadId, {
              type: "operation.updated",
              threadId,
              turnId,
              operation,
            });
          }
        }
        return;
      }
      case "error": {
        const turnId = stringField(params, "turnId");
        const error = asRecord(params?.error);
        const message = stringField(error, "message");
        if (turnId && message) {
          this.errorsByTurn.set(turnId, message);
        }
        return;
      }
      case "turn/completed": {
        const turn = asRecord(params?.turn);
        const turnId = stringField(turn, "id");
        const status = stringField(turn, "status") ?? "completed";
        if (!threadId || !turnId) {
          return;
        }
        this.clearSeenUserMessages(threadId, turnId);
        this.clearItemPhases(threadId, turnId);
        const target = this.router.targetForThread(threadId);
        if (!target) {
          return;
        }
        const active = this.activeByConversation.get(this.key(target));
        if (active?.turnId === turnId) {
          this.activeByConversation.delete(this.key(target));
        }
        const turnError = asRecord(turn?.error);
        const error = stringField(turnError, "message") ?? this.errorsByTurn.get(turnId);
        const tokenUsage = this.usageTurnByThread.get(threadId) === turnId
          ? this.usageByThread.get(threadId)
          : undefined;
        const modelSettings = this.router.modelSettingsForThread(threadId);
        const weeklyLimit = this.weeklyRateLimit();
        this.errorsByTurn.delete(turnId);
        this.publish({
          type: "turn.completed",
          target,
          threadId,
          turnId,
          status,
          ...(error ? { error } : {}),
          ...(tokenUsage ? { tokenUsage } : {}),
          ...(modelSettings
            ? {
                model: modelSettings.model,
                effort: modelSettings.effort,
                serviceTier: modelSettings.serviceTier,
              }
            : {}),
          ...(weeklyLimit ? { weeklyLimit } : {}),
        });
        return;
      }
      case "thread/status/changed": {
        const status = asRecord(params?.status);
        const statusType = stringField(status, "type");
        if (threadId && statusType) {
          this.publishForThread(threadId, {
            type: "thread.status",
            threadId,
            status: statusType,
          });
        }
        return;
      }
      case "thread/closed":
      case "thread/archived":
      case "thread/deleted": {
        if (!threadId) {
          return;
        }
        const target = this.router.targetForThread(threadId);
        this.usageByThread.delete(threadId);
        this.usageTurnByThread.delete(threadId);
        this.clearSeenUserMessages(threadId);
        this.clearItemPhases(threadId);
        this.artifactsByThread.delete(threadId);
        if (target) {
          this.activeByConversation.delete(this.key(target));
        }
        return;
      }
      case "account/updated": {
        const authMode = parseAuthMode(params?.authMode);
        const planType = parsePlanType(params?.planType);
        if (authMode === undefined || planType === undefined) {
          return;
        }
        const fingerprint = `${authMode ?? ""}:${planType ?? ""}`;
        if (fingerprint !== this.accountStatus) {
          this.accountStatus = fingerprint;
          this.broadcast({ type: "account.updated", authMode, planType });
        }
        return;
      }
      case "account/rateLimits/updated": {
        const update = parseRateLimitSnapshot(params?.rateLimits);
        if (!update) {
          return;
        }
        const limitId = update.limitId ?? "codex";
        const rateLimits = mergeRateLimitSnapshot(
          this.rateLimitSnapshots.get(limitId),
          update,
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
          this.broadcast({
            type: "account.rateLimits.updated",
            rateLimits,
          });
        }
        return;
      }
      case "mcpServer/startupStatus/updated": {
        const name = stringField(params, "name");
        const status = stringField(params, "status");
        const error = typeof params?.error === "string"
          ? sanitizeOperationText(params.error)
          : null;
        const failureReason = typeof params?.failureReason === "string" ? params.failureReason : null;
        if (!name || !isMcpStartupState(status) || !isMcpFailureReason(failureReason)) {
          return;
        }
        const key = `${threadId ?? "global"}:${name}`;
        const fingerprint = `${status}:${error ?? ""}:${failureReason ?? ""}`;
        if (this.mcpStatus.get(key) === fingerprint) {
          return;
        }
        this.mcpStatus.set(key, fingerprint);
        const event = {
          type: "mcp.status.updated" as const,
          threadId: threadId ?? null,
          name,
          status,
          error,
          failureReason,
        };
        if (threadId) {
          this.publishForThread(threadId, event);
        } else {
          this.broadcast(event);
        }
        return;
      }
      case "warning": {
        const message = stringField(params, "message");
        if (message && threadId) {
          this.publishForThread(threadId, { type: "warning", threadId, message });
        }
        return;
      }
      default:
        return;
    }
  }

  private publishForThread(
    threadId: string,
    event: UntargetedOutputEvent,
  ): void {
    const target = this.router.targetForThread(threadId);
    if (target) {
      this.publish({ ...event, target });
    }
  }

  private publishUserMessage(
    threadId: string,
    turnId: string,
    item: Record<string, unknown>,
  ): void {
    const itemId = stringField(item, "id");
    if (!itemId) {
      return;
    }
    const messageKey = `${threadId}:${turnId}:${itemId}`;
    if (this.seenUserMessages.has(messageKey)) {
      return;
    }
    this.seenUserMessages.add(messageKey);
    const clientId = stringField(item, "clientId");
    if (clientId?.startsWith(gatewayUserMessageClientIdPrefix)) {
      return;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .map((input) => {
        const record = asRecord(input);
        return record?.type === "text" && typeof record.text === "string"
          ? record.text.trim()
          : "";
      })
      .filter(Boolean)
      .join("\n\n");
    if (!text) {
      return;
    }
    const target = this.router.targetForThread(threadId);
    if (!target) {
      return;
    }
    this.markTurnStarted(target, threadId, turnId);
    this.publish({ type: "user.message", target, threadId, turnId, itemId, text });
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

  private key(target: ConversationTarget): string {
    return conversationTargetKey(target);
  }
}

function parsePlanSteps(value: unknown): TurnPlanStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps: TurnPlanStep[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const step = stringField(record, "step");
    const status = stringField(record, "status");
    if (!step || !status || !["pending", "inProgress", "completed"].includes(status)) {
      return undefined;
    }
    steps.push({ step, status: status as TurnPlanStep["status"] });
  }
  return steps;
}

function parseAuthMode(value: unknown): AuthMode | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && [
    "apikey", "chatgpt", "chatgptAuthTokens", "headers", "agentIdentity",
    "personalAccessToken", "bedrockApiKey",
  ].includes(value) ? value as AuthMode : undefined;
}

function parsePlanType(value: unknown): PlanType | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" && [
    "free", "go", "plus", "pro", "prolite", "team", "self_serve_business_usage_based",
    "business", "enterprise_cbp_usage_based", "enterprise", "edu", "unknown",
  ].includes(value) ? value as PlanType : undefined;
}

function isMcpStartupState(value: unknown): value is McpServerStartupState {
  return typeof value === "string" && ["starting", "ready", "failed", "cancelled"].includes(value);
}

function isMcpFailureReason(value: unknown): value is McpServerStartupFailureReason | null {
  return value === null || value === "reauthenticationRequired";
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

function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const primary = parseRateLimitWindow(record.primary);
  const secondary = parseRateLimitWindow(record.secondary);
  const credits = parseCredits(record.credits);
  const individualLimit = parseIndividualLimit(record.individualLimit);
  const spendControlReached = nullableBoolean(record.spendControlReached);
  const planType = parsePlanType(record.planType ?? null);
  const rateLimitReachedType = parseRateLimitReachedType(record.rateLimitReachedType);
  if (
    primary === undefined || secondary === undefined || credits === undefined ||
    individualLimit === undefined || spendControlReached === undefined ||
    planType === undefined || rateLimitReachedType === undefined
  ) {
    return undefined;
  }
  return {
    limitId: nullableString(record.limitId),
    limitName: nullableString(record.limitName),
    primary,
    secondary,
    credits,
    individualLimit,
    spendControlReached,
    planType,
    rateLimitReachedType,
  };
}

function parseRateLimitWindow(value: unknown): RateLimitSnapshot["primary"] | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  const usedPercent = numberField(record, "usedPercent");
  const windowDurationMins = nullableNumber(record?.windowDurationMins);
  const resetsAt = nullableNumber(record?.resetsAt);
  return record && usedPercent !== undefined && windowDurationMins !== undefined && resetsAt !== undefined
    ? { usedPercent, windowDurationMins, resetsAt }
    : undefined;
}

function parseCredits(value: unknown): RateLimitSnapshot["credits"] | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  const hasCredits = record?.hasCredits;
  const unlimited = record?.unlimited;
  if (!record || typeof hasCredits !== "boolean" || typeof unlimited !== "boolean") {
    return undefined;
  }
  return { hasCredits, unlimited, balance: nullableString(record.balance) };
}

function parseIndividualLimit(value: unknown): RateLimitSnapshot["individualLimit"] | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  const limit = stringField(record, "limit");
  const used = stringField(record, "used");
  const remainingPercent = numberField(record, "remainingPercent");
  const resetsAt = numberField(record, "resetsAt");
  return record && limit && used && remainingPercent !== undefined && resetsAt !== undefined
    ? { limit, used, remainingPercent, resetsAt }
    : undefined;
}

function parseRateLimitReachedType(value: unknown): RateLimitReachedType | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" && [
    "rate_limit_reached", "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
  ].includes(value) ? value as RateLimitReachedType : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null || value === undefined
    ? null
    : typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableBoolean(value: unknown): boolean | null | undefined {
  return value === null || value === undefined
    ? null
    : typeof value === "boolean" ? value : undefined;
}

function messagePhase(value: unknown): MessagePhase | null {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function parseThreadTokenUsage(record: Record<string, unknown> | undefined): ThreadTokenUsage | undefined {
  const total = parseTokenUsageBreakdown(asRecord(record?.total));
  const last = parseTokenUsageBreakdown(asRecord(record?.last));
  const context = record?.modelContextWindow;
  if (!total || !last || (context !== null && (typeof context !== "number" || !Number.isFinite(context)))) {
    return undefined;
  }
  return { total, last, modelContextWindow: context };
}

function parseTokenUsageBreakdown(record: Record<string, unknown> | undefined): ThreadTokenUsage["total"] | undefined {
  const totalTokens = numberField(record, "totalTokens");
  const inputTokens = numberField(record, "inputTokens");
  const cachedInputTokens = numberField(record, "cachedInputTokens");
  const cacheWriteInputTokens = numberField(record, "cacheWriteInputTokens");
  const outputTokens = numberField(record, "outputTokens");
  const reasoningOutputTokens = numberField(record, "reasoningOutputTokens");
  if (
    totalTokens === undefined || inputTokens === undefined || cachedInputTokens === undefined ||
    cacheWriteInputTokens === undefined || outputTokens === undefined || reasoningOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}
