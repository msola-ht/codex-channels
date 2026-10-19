import type { SessionRouter, ThreadModelSettings } from "../session-routing/index.js";
import type { AccountRateLimit, AccountRateLimits } from "./account-port.js";
import { ConversationLockCoordinator } from "./conversation-lock-coordinator.js";
import type { ModelOption } from "./model-port.js";
import type { ModelSelectionService } from "./model-selection-service.js";
import {
  lunaReserveModel,
  type LunaReservePort,
  type LunaReserveThreadSettings,
} from "./luna-reserve-port.js";
import type { ConversationTarget, OutputEvent } from "../conversation-core/index.js";

const recoveryPollIntervalMs = 60_000;

interface ReserveReturnState {
  accountId: string;
  settings: ThreadModelSettings;
  reserveSettings: ThreadModelSettings;
}

interface RefreshGeneration {
  account: number;
  thread: number;
}

export interface LunaReserveServiceOptions {
  port: LunaReservePort;
  router: Pick<
    SessionRouter,
    "current" | "modelSettingsForThread" | "targetForThread"
  >;
  models: Pick<ModelSelectionService, "hasPending" | "state">;
  collaborationModes?: {
    hasPending(target: ConversationTarget): boolean;
  };
  activity: {
    hasActiveTurn(threadId: string): boolean;
  };
  locks: ConversationLockCoordinator;
  output: {
    publish(event: OutputEvent, critical?: boolean): void;
  };
  onError?: (error: unknown, threadId: string) => void;
}

export class LunaReserveService {
  private readonly returnByThread = new Map<string, ReserveReturnState>();
  private readonly usageLimitedTurns = new Map<string, string>();
  private readonly pendingRefreshes = new Set<string>();
  private readonly deferredUntilTurnCompletion = new Set<string>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly observedSettings = new Map<string, {
    current: ThreadModelSettings;
    submitted?: ThreadModelSettings;
  }>();
  private readonly threadGenerations = new Map<string, number>();
  private accountGeneration = 0;
  private limitsRead: { controller: AbortController; promise: Promise<AccountRateLimits> } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: LunaReserveServiceOptions) {}

  observeSettings(threadId: string): void {
    const observed = this.observedSettings.get(threadId);
    const expected = observed?.current ?? this.returnByThread.get(threadId)?.reserveSettings;
    if (!expected) return;
    const current = this.options.router.modelSettingsForThread(threadId);
    if (sameModelSettings(current, expected)) return;
    if (observed?.submitted && sameModelSettings(current, observed.submitted)) {
      observed.current = observed.submitted;
      delete observed.submitted;
      return;
    }
    // A later return to the same value must not revive an invalidated refresh.
    this.clearThread(threadId);
  }

  markUsageLimit(threadId: string, turnId: string): void {
    const settings = this.options.router.modelSettingsForThread(threadId);
    if (
      !this.closed
      && settings
      && (settings.modelProvider ?? "openai") === "openai"
    ) {
      this.usageLimitedTurns.set(threadId, turnId);
    }
  }

  recoverAfterTurn(threadId: string, turnId: string): void {
    const usageLimitMatched = this.usageLimitedTurns.get(threadId) === turnId;
    const deferred = this.deferredUntilTurnCompletion.delete(threadId);
    if (!usageLimitMatched && !deferred) return;
    if (usageLimitMatched) this.usageLimitedTurns.delete(threadId);
    if (this.operations.has(threadId)) {
      this.pendingRefreshes.add(threadId);
      return;
    }
    this.startRefresh(threadId);
  }

  clearThread(threadId: string): void {
    if (this.operations.has(threadId)) {
      this.threadGenerations.set(threadId, (this.threadGenerations.get(threadId) ?? 0) + 1);
    } else {
      this.threadGenerations.delete(threadId);
    }
    this.usageLimitedTurns.delete(threadId);
    this.pendingRefreshes.delete(threadId);
    this.deferredUntilTurnCompletion.delete(threadId);
    this.returnByThread.delete(threadId);
    this.observedSettings.delete(threadId);
    this.stopTimerWhenIdle();
  }

  clearAccountState(): void {
    this.accountGeneration += 1;
    this.cancelLimitsRead();
    this.usageLimitedTurns.clear();
    this.pendingRefreshes.clear();
    this.deferredUntilTurnCompletion.clear();
    this.returnByThread.clear();
    this.observedSettings.clear();
    for (const threadId of this.threadGenerations.keys()) {
      if (!this.operations.has(threadId)) this.threadGenerations.delete(threadId);
    }
    this.stopTimerWhenIdle();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.accountGeneration += 1;
    this.cancelLimitsRead();
    this.usageLimitedTurns.clear();
    this.pendingRefreshes.clear();
    this.deferredUntilTurnCompletion.clear();
    this.returnByThread.clear();
    this.observedSettings.clear();
    this.threadGenerations.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await waitAtMost(Promise.allSettled([...this.operations.values()]), 5_000);
  }

  private startRefresh(threadId: string): void {
    if (this.closed || this.operations.has(threadId)) return;
    const target = this.options.router.targetForThread(threadId);
    if (!target) {
      this.clearThread(threadId);
      return;
    }
    const generation = {
      account: this.accountGeneration,
      thread: this.threadGenerations.get(threadId) ?? 0,
    };
    const settings = this.options.router.modelSettingsForThread(threadId);
    if (settings) this.observedSettings.set(threadId, { current: settings });
    const operation = this.options.locks.forConversation(target, async () => {
      if (!this.isCurrentRefresh(threadId, generation)) return;
      const binding = this.options.router.current(target);
      if (binding?.threadId !== threadId) {
        this.clearThread(threadId);
        return;
      }
      const limits = await this.readLimits();
      if (!this.isCurrentRefresh(threadId, generation)) return;
      await this.reconcile(threadId, limits, generation);
    });
    this.operations.set(threadId, operation);
    void operation.catch((error) => {
      if (this.isCurrentRefresh(threadId, generation)) this.options.onError?.(error, threadId);
    }).finally(() => {
      if (this.operations.get(threadId) === operation) {
        this.operations.delete(threadId);
        this.observedSettings.delete(threadId);
        if (this.pendingRefreshes.delete(threadId)) {
          this.startRefresh(threadId);
          return;
        }
        if (
          !this.usageLimitedTurns.has(threadId)
          && !this.returnByThread.has(threadId)
        ) {
          this.threadGenerations.delete(threadId);
        }
      }
    });
  }

  private async reconcile(
    threadId: string,
    limits: AccountRateLimits,
    generation: RefreshGeneration,
  ): Promise<void> {
    const target = this.options.router.targetForThread(threadId);
    const current = this.options.router.modelSettingsForThread(threadId);
    if (!target || !current || (current.modelProvider ?? "openai") !== "openai") {
      this.clearThread(threadId);
      return;
    }
    const previous = this.returnByThread.get(threadId);
    if (previous && !sameModelSettings(current, previous.reserveSettings)) {
      this.clearThread(threadId);
      return;
    }
    if (this.deferWhileActive(threadId)) return;
    if (current.model === lunaReserveModel) {
      await this.restoreOrdinaryModel(threadId, limits, generation);
      return;
    }
    await this.enterReserve(threadId, limits, current, generation);
  }

  private async enterReserve(
    threadId: string,
    limits: AccountRateLimits,
    current: ThreadModelSettings,
    generation: RefreshGeneration,
  ): Promise<void> {
    const target = this.options.router.targetForThread(threadId);
    const offer = limits.lunaReserve;
    if (
      !target
      || !offer
      || !limits.accountId
      || this.hasPendingSelection(target)
      || (offer.blockedModelSlug !== null && offer.blockedModelSlug !== current.model)
    ) {
      return;
    }
    const reserve = await this.options.port.lunaReserveModel();
    const latest = this.options.router.modelSettingsForThread(threadId);
    if (
      !this.isCurrentRefresh(threadId, generation)
      || !sameModelSettings(latest, current)
      || this.hasPendingSelection(target)
      || !reserve
      || reserve.model !== lunaReserveModel
      || this.deferWhileActive(threadId)
    ) {
      return;
    }
    const settings = settingsForModel(reserve, current);
    if (!await this.applySettings(threadId, target, generation, current, settings)) return;
    this.returnByThread.set(threadId, {
      accountId: limits.accountId,
      settings: current,
      reserveSettings: { ...settings, modelProvider: "openai" },
    });
    this.ensureTimer();
    this.options.output.publish({
      type: "warning",
      target,
      threadId,
      message: "OpenAI 普通用量已用尽，当前 Session 已自动切换到 Luna Reserve。额度错误发生前的排队消息也可能已经自动开始，请重新发送失败消息；Gateway 不会自动重放。",
    }, true);
  }

  private async restoreOrdinaryModel(
    threadId: string,
    limits: AccountRateLimits,
    generation: RefreshGeneration,
  ): Promise<void> {
    const target = this.options.router.targetForThread(threadId);
    const previous = this.returnByThread.get(threadId);
    if (!target || !previous) return;
    const pendingSelection = this.hasPendingSelection(target);
    if (
      limits.accountId !== previous.accountId
      || pendingSelection
      || !ordinaryUsageRecovered(limits)
    ) {
      if (limits.accountId !== previous.accountId || pendingSelection) {
        this.clearThread(threadId);
      }
      return;
    }
    const state = await this.options.models.state(target);
    const model = state.models.find((candidate) =>
      candidate.model === previous.settings.model
      && (candidate.provider ?? "openai") === "openai"
      && candidate.available !== false
    );
    if (!model) return;
    const current = this.options.router.modelSettingsForThread(threadId);
    if (
      !this.isCurrentRefresh(threadId, generation)
      || !sameModelSettings(current, previous.reserveSettings)
      || this.hasPendingSelection(target)
      || this.deferWhileActive(threadId)
    ) {
      return;
    }
    const settings = settingsForModel(model, previous.settings);
    if (!await this.applySettings(threadId, target, generation, previous.reserveSettings, settings)) return;
    this.returnByThread.delete(threadId);
    this.stopTimerWhenIdle();
    this.options.output.publish({
      type: "warning",
      target,
      threadId,
      message: `OpenAI 普通用量已恢复，当前 Session 已自动切回 ${settings.model}。`,
    }, true);
  }

  private ensureTimer(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.startRecoveryPoll(), recoveryPollIntervalMs);
    this.timer.unref();
  }

  private async applySettings(
    threadId: string,
    target: ConversationTarget,
    generation: RefreshGeneration,
    expected: ThreadModelSettings,
    settings: LunaReserveThreadSettings,
  ): Promise<boolean> {
    const invalidated = new Error("Luna Reserve 设置提交前已失效");
    const beforeSubmit = () => {
      if (
        !this.isCurrentRefresh(threadId, generation)
        || this.options.router.current(target)?.threadId !== threadId
        || !sameModelSettings(this.options.router.modelSettingsForThread(threadId), expected)
        || this.hasPendingSelection(target)
        || this.deferWhileActive(threadId)
      ) throw invalidated;
      const observed = this.observedSettings.get(threadId);
      if (observed) observed.submitted = { ...settings, modelProvider: "openai" };
    };
    try {
      await this.options.port.updateLunaReserveThreadSettings(threadId, settings, beforeSubmit);
    } catch (error) {
      if (error === invalidated) return false;
      if (!this.isCurrentRefresh(threadId, generation)) {
        this.warnInvalidatedAccountWrite(threadId, target, generation);
        return false;
      }
      // An unconfirmed write may already have been applied. Never retry it
      // from the recovery timer or overwrite a later client selection.
      this.returnByThread.delete(threadId);
      this.pendingRefreshes.delete(threadId);
      this.stopTimerWhenIdle();
      throw error;
    }
    if (!this.isCurrentRefresh(threadId, generation)) {
      this.warnInvalidatedAccountWrite(threadId, target, generation);
      return false;
    }
    if (
      this.options.router.current(target)?.threadId !== threadId
      || !sameModelSettings(this.options.router.modelSettingsForThread(threadId), {
        ...settings,
        modelProvider: "openai",
      })
    ) {
      this.returnByThread.delete(threadId);
      this.pendingRefreshes.delete(threadId);
      this.stopTimerWhenIdle();
      throw new Error("Luna Reserve 设置已变化，未确认自动切换");
    }
    return true;
  }

  private startRecoveryPoll(): void {
    const threadIds = [...this.returnByThread.keys()].filter(
      (threadId) =>
        !this.operations.has(threadId)
        && !this.deferredUntilTurnCompletion.has(threadId),
    );
    for (const threadId of threadIds) {
      this.startRefresh(threadId);
    }
  }

  private readLimits(): Promise<AccountRateLimits> {
    if (this.limitsRead) return this.limitsRead.promise;
    const controller = new AbortController();
    const promise = this.options.port.accountRateLimits({ background: true, signal: controller.signal });
    const read = { controller, promise };
    this.limitsRead = read;
    const clear = () => {
      if (this.limitsRead === read) this.limitsRead = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  private cancelLimitsRead(): void {
    const read = this.limitsRead;
    this.limitsRead = undefined;
    read?.controller.abort();
  }

  private stopTimerWhenIdle(): void {
    if (this.returnByThread.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private hasPendingSelection(target: ConversationTarget): boolean {
    return this.options.models.hasPending(target)
      || this.options.collaborationModes?.hasPending(target) === true;
  }

  private deferWhileActive(threadId: string): boolean {
    if (!this.options.activity.hasActiveTurn(threadId)) return false;
    this.deferredUntilTurnCompletion.add(threadId);
    return true;
  }

  private warnInvalidatedAccountWrite(
    threadId: string,
    target: ConversationTarget,
    generation: RefreshGeneration,
  ): void {
    if (
      this.closed
      || generation.account === this.accountGeneration
      || generation.thread !== (this.threadGenerations.get(threadId) ?? 0)
    ) {
      return;
    }
    this.options.output.publish({
      type: "warning",
      target,
      threadId,
      message: "Luna Reserve 设置写入期间账户已发生变化，请确认当前 Session 模型；Gateway 已取消自动切回。",
    }, true);
  }

  private isCurrentRefresh(threadId: string, generation: RefreshGeneration): boolean {
    return !this.closed
      && generation.account === this.accountGeneration
      && generation.thread === (this.threadGenerations.get(threadId) ?? 0);
  }
}

function sameModelSettings(
  current: ThreadModelSettings | undefined,
  expected: ThreadModelSettings,
): boolean {
  return current?.model === expected.model
    && (current.modelProvider ?? "openai") === (expected.modelProvider ?? "openai")
    && current.effort === expected.effort
    && current.serviceTier === expected.serviceTier
    && current.collaborationMode === expected.collaborationMode;
}

function settingsForModel(
  model: ModelOption,
  previous: ThreadModelSettings,
): LunaReserveThreadSettings {
  const efforts = new Set(model.supportedReasoningEfforts.map((option) => option.effort));
  const effort = previous.effort && efforts.has(previous.effort)
    ? previous.effort
    : model.defaultReasoningEffort;
  const tiers = new Set(model.serviceTiers.map((tier) => tier.id));
  const serviceTier = previous.serviceTier && tiers.has(previous.serviceTier)
    ? previous.serviceTier
    : model.defaultServiceTier;
  return {
    model: model.model,
    effort,
    // App Server represents an explicitly cleared tier as "default" in the
    // applied settings notification, rather than the catalog's null default.
    serviceTier: serviceTier ?? "default",
    collaborationMode: previous.collaborationMode,
  };
}

function ordinaryUsageRecovered(limits: AccountRateLimits): boolean {
  if (limits.ordinaryUsageAllowed === null) return false;
  const primary = limits.ordinaryUsageLimit;
  const hasCredits = primary?.credits?.unlimited === true
    || primary?.credits?.hasCredits === true;
  return (limits.ordinaryUsageAllowed || hasCredits)
    && limits.lunaReserve === null
    && !limits.unsupportedUpsellPresent
    && !hasRemainingBlocker(primary);
}

function hasRemainingBlocker(limit: AccountRateLimit): boolean {
  return limit.spendControlReached === true
    || limit.rateLimitReachedType !== null;
}

async function waitAtMost(operation: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    operation,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, milliseconds);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
}
