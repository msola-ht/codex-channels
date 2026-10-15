import type { Logger } from "pino";

import { aggregateProviderId } from "../../runtime/aggregate-model-provider.mjs";
import { ProviderSettingsSnapshotReader } from "../../runtime/provider-settings-snapshot-reader.mjs";

export interface ProviderSettingsWatcherOptions {
  logger: Logger;
  applyProviderSettings: (provider: string, signal: AbortSignal) => Promise<boolean>;
  configuredProviders?: readonly string[];
  aggregateMembers?: readonly string[];
  refreshProviderModels: (provider: string, signal: AbortSignal) => void | Promise<void>;
  onStateChange?: (change: ProviderSettingsStateChange) => void;
  environment?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  restartCooldownMs?: number;
  validationCooldownMs?: number;
  stopTimeoutMs?: number;
  nowMs?: () => number;
  validate?: () => void;
}

export type ProviderSettingsStateKind =
  | "scheduled"
  | "restarting"
  | "applied"
  | "failed";

export interface ProviderSettingsStateChange {
  kind: ProviderSettingsStateKind;
  /** 用户可见的 Provider/账户；不包含仅用于监听共享目录的内部基础定义。 */
  providers: string[];
}

const defaultPollIntervalMs = 2_000;
const defaultRestartCooldownMs = 30_000;
const defaultValidationCooldownMs = 30_000;
const maximumApplyFailures = 12;

export class ProviderSettingsWatcher {
  private readonly logger: Logger;
  private readonly applyProviderSettings: ProviderSettingsWatcherOptions["applyProviderSettings"];
  private readonly refreshProviderModels: ProviderSettingsWatcherOptions["refreshProviderModels"];
  private readonly onStateChange:
    | ((change: ProviderSettingsStateChange) => void)
    | undefined;
  private readonly pollIntervalMs: number;
  private readonly restartCooldownMs: number;
  private readonly validationCooldownMs: number;
  private readonly nowMs: () => number;
  private readonly validate: (() => void) | undefined;
  private readonly reader: ProviderSettingsSnapshotReader;
  private visibleProviderIds: ReadonlySet<string> | undefined;
  private checkTask: Promise<void> | undefined;
  private fingerprints = new Map<string, string>();
  private lastReadFailureAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private initialized = false;
  private readonly pendingProviders = new Map<string, number>();
  private readonly applyFailures = new Map<string, { generation: number; count: number }>();
  private readonly deferredGenerations = new Map<string, number>();
  private generation = 0;
  private readonly cancellation = new AbortController();
  private readonly stopTimeoutMs: number;
  private restartTask: Promise<void> | undefined;
  private lastRestartAttemptAt = 0;

  constructor(options: ProviderSettingsWatcherOptions) {
    this.logger = options.logger;
    this.applyProviderSettings = options.applyProviderSettings;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.stopTimeoutMs) || this.stopTimeoutMs < 0) {
      throw new RangeError("Provider 设置停止等待上限必须是非负整数毫秒");
    }
    this.refreshProviderModels = options.refreshProviderModels;
    this.onStateChange = options.onStateChange;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.restartCooldownMs = options.restartCooldownMs ?? defaultRestartCooldownMs;
    this.validationCooldownMs =
      options.validationCooldownMs ?? defaultValidationCooldownMs;
    this.nowMs = options.nowMs ?? Date.now;
    this.validate = options.validate;
    this.visibleProviderIds = options.configuredProviders ? new Set(options.configuredProviders) : undefined;
    const members = this.visibleProviderIds?.has(aggregateProviderId) ? [...(options.aggregateMembers ?? [])] : [];
    if (this.visibleProviderIds?.has(aggregateProviderId) && members.length < 2) {
      throw new Error("聚合设置监听需要至少两个已配置切换 Provider");
    }
    this.reader = new ProviderSettingsSnapshotReader(options.environment ?? process.env, members);
  }

  start(): void {
    if (this.stopping || this.timer) return;
    // The supervisor owns the applied baseline, so a Gateway rebuild cannot lose pending changes.
    for (const provider of this.visibleProviderIds ?? []) this.pendingProviders.set(provider, 0);
    void this.checkOnce();
    this.timer = setInterval(() => {
      if (!this.checkTask) void this.checkOnce();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.cancellation.abort(new Error("Provider 设置监听已停止"));
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const readerStopped = this.reader.close();
    const workStopped = Promise.all([this.checkTask, this.restartTask]).then(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.all([readerStopped, Promise.race([
        workStopped,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn({ timeoutMs: this.stopTimeoutMs }, "Provider 设置应用停止等待超时");
            resolve();
          }, this.stopTimeoutMs);
          timer.unref?.();
        }),
      ])]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async checkNow(): Promise<void> {
    await this.checkOnce();
    await this.restartTask;
  }

  private checkOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.checkTask) return this.checkTask;
    const task = this.checkSettings().finally(() => {
      if (this.checkTask === task) this.checkTask = undefined;
    });
    this.checkTask = task;
    return task;
  }

  private async checkSettings(): Promise<void> {
    const nextFingerprints = await this.tryReadFingerprints();
    if (!nextFingerprints) return;
    this.acceptFingerprints(nextFingerprints);
  }

  private acceptFingerprints(nextFingerprints: Map<string, string>): void {
    if (this.stopping) return;
    if (!this.initialized) {
      this.fingerprints = nextFingerprints;
      this.initialized = true;
      for (const provider of this.visibleProviderIds ?? []) this.pendingProviders.set(provider, 0);
    }
    if (this.initialized && !sameFingerprints(this.fingerprints, nextFingerprints)) {
      const providers = [...(this.visibleProviderIds ?? [])]
        .filter((provider) => this.fingerprints.get(provider) !== nextFingerprints.get(provider));
      if (providers.length === 0) {
        this.fingerprints = nextFingerprints;
        this.considerRestart();
        return;
      }
      this.fingerprints = nextFingerprints;
      const generation = ++this.generation;
      for (const provider of providers) {
        this.pendingProviders.set(provider, generation);
        this.applyFailures.delete(provider);
        this.deferredGenerations.delete(provider);
      }
      this.emitState("scheduled", providers);
      this.logger.info(
        { providers },
        "第三方模型设置已变化，等待对应 Provider 安全应用",
      );
      this.considerRestart();
      return;
    }
    if (this.pendingProviders.size > 0) {
      this.considerRestart();
    }
  }

  private considerRestart(): void {
    if (this.stopping || this.restartTask || this.pendingProviders.size === 0) return;
    if (this.nowMs() - this.lastRestartAttemptAt < this.restartCooldownMs) {
      return;
    }
    const pending = new Map([...this.pendingProviders].filter(([provider, generation]) => {
      const failures = this.applyFailures.get(provider);
      return failures?.generation !== generation || failures.count < maximumApplyFailures;
    }));
    if (pending.size === 0) return;
    const task = this.runRestart(pending).finally(() => {
      if (this.restartTask === task) this.restartTask = undefined;
    });
    this.restartTask = task;
  }

  private async runRestart(pending: ReadonlyMap<string, number>): Promise<void> {
    // Defer until the owner has stored this task, including for reentrant notifications.
    await Promise.resolve();
    if (this.stopping) return;
    this.lastRestartAttemptAt = this.nowMs();
    for (const [provider, generation] of pending) {
      if (this.stopping) return;
      try {
        const fingerprint = this.fingerprints.get(provider);
        const wasDeferred = this.deferredGenerations.get(provider) === generation;
        if (generation > 0 && !wasDeferred) this.emitState("restarting", [provider]);
        const applied = await this.applyProviderSettings(provider, this.cancellation.signal);
        if (this.stopping) return;
        if (!applied) {
          if (generation > 0 && !wasDeferred) this.emitState("scheduled", [provider]);
          this.deferredGenerations.set(provider, generation);
          continue;
        }
        if (generation > 0 && wasDeferred) this.emitState("restarting", [provider]);
        this.deferredGenerations.delete(provider);
        // Re-read before confirming: a change made during application remains pending.
        const current = await this.tryReadFingerprints();
        if (this.stopping) return;
        if (current) this.acceptFingerprints(current);
        if (!current || current.get(provider) !== fingerprint) continue;
        if (this.pendingProviders.get(provider) !== generation) continue;
        await this.refreshProviderModels(provider, this.cancellation.signal);
        if (this.stopping) return;
        const confirmed = await this.tryReadFingerprints();
        if (this.stopping) return;
        if (confirmed) this.acceptFingerprints(confirmed);
        if (!confirmed || confirmed.get(provider) !== fingerprint) continue;
        if (this.pendingProviders.get(provider) !== generation) continue;
        this.pendingProviders.delete(provider);
        this.applyFailures.delete(provider);
        if (generation > 0) this.emitState("applied", [provider]);
        this.logger.info({ provider }, "第三方模型设置已安全应用到对应 Provider");
      } catch (error) {
        if (this.stopping) return;
        this.deferredGenerations.delete(provider);
        const old = this.applyFailures.get(provider);
        const count = old?.generation === generation ? old.count + 1 : 1;
        // Do not debit a newer file generation for an earlier attempt's failure.
        if (this.pendingProviders.get(provider) === generation) this.applyFailures.set(provider, { generation, count });
        this.emitState("failed", [provider]);
        this.logger.error(
          { err: error, provider, attempt: count, maximumApplyFailures },
          count >= maximumApplyFailures
            ? "第三方模型设置应用失败次数耗尽，保留待应用状态，等待设置变化或 Gateway 重建"
            : "第三方模型设置应用失败，将在冷却后重试",
        );
      }
    }
  }

  private emitState(
    kind: ProviderSettingsStateKind,
    providers: string[],
  ): void {
    if (this.stopping || !this.onStateChange) {
      return;
    }
    try {
      this.onStateChange({ kind, providers });
    } catch (error) {
      this.logger.error(
        { err: error, kind, providers },
        "第三方模型设置状态通知失败",
      );
    }
  }

  private async tryReadFingerprints(): Promise<Map<string, string> | undefined> {
    try {
      const snapshot = await this.reader.readFresh();
      if (this.stopping) return undefined;
      this.validate?.();
      this.visibleProviderIds ??= new Set(snapshot.visibleProviders);
      return new Map(snapshot.fingerprints);
    } catch (error) {
      if (this.stopping) return undefined;
      const now = this.nowMs();
      if (now - this.lastReadFailureAt >= this.validationCooldownMs) {
        this.lastReadFailureAt = now;
        this.logger.error(
          { err: error, phase: error instanceof Error && "phase" in error ? error.phase : "read" },
          "读取第三方模型设置失败，继续使用现有配置并等待修复",
        );
      }
      return undefined;
    }
  }
}

function sameFingerprints(
  current: Map<string, string>,
  next: Map<string, string>,
): boolean {
  if (current.size !== next.size) {
    return false;
  }
  for (const [path, fingerprint] of current) {
    if (next.get(path) !== fingerprint) {
      return false;
    }
  }
  return true;
}
