import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";

import { codexHomePath } from "../../runtime/codex-home.mjs";
import {
  loadManagedModelProviderDefinitions,
  loadManagedModelProviderWatcherDefinitions,
} from "../../runtime/model-provider-definitions.mjs";
import {
  managedProviderMarkerPath,
  managedProviderDirectory,
  readManagedMarker,
  validateConfiguredModelProviders,
} from "../../runtime/model-provider-runtime.mjs";

export interface ProviderSettingsWatcherOptions {
  logger: Logger;
  applyProviderSettings: (provider: string, signal: AbortSignal) => Promise<boolean>;
  configuredProviders?: readonly string[];
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

interface ManagedProviderFiles {
  provider: string;
  paths: string[];
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
  private readonly environment: NodeJS.ProcessEnv;
  private readonly pollIntervalMs: number;
  private readonly restartCooldownMs: number;
  private readonly validationCooldownMs: number;
  private readonly nowMs: () => number;
  private readonly validate: () => void;
  private readonly filesByProvider: ManagedProviderFiles[];
  private readonly visibleProviderIds: ReadonlySet<string>;
  private fingerprints = new Map<string, string>();
  private lastReadFailureAt = Number.NEGATIVE_INFINITY;
  private lastValidationFailureAt = Number.NEGATIVE_INFINITY;
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
    this.environment = options.environment ?? process.env;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.restartCooldownMs = options.restartCooldownMs ?? defaultRestartCooldownMs;
    this.validationCooldownMs =
      options.validationCooldownMs ?? defaultValidationCooldownMs;
    this.nowMs = options.nowMs ?? Date.now;
    this.validate = options.validate ?? (() => {
      validateConfiguredModelProviders(this.environment);
    });
    const visibleProviderIds = new Set(
      options.configuredProviders ?? loadManagedModelProviderDefinitions(this.environment)
        .map((definition) => definition.id),
    );
    const codexHome = codexHomePath(this.environment);
    const definitions = loadManagedModelProviderWatcherDefinitions(this.environment);
    const filesByProvider = new Map<string, ManagedProviderFiles>();
    for (const definition of definitions) {
      const files = filesByProvider.get(definition.id) ?? {
        provider: definition.id,
        paths: [],
      };
      const paths = [
        join(
          managedProviderDirectory(this.environment, definition),
          definition.catalogFileName,
        ),
        ...("profileFileName" in definition ? [
          join(codexHome, readManagedMarker(this.environment, definition)?.mode === "exclusive"
            ? "config.toml"
            : definition.profileFileName),
          managedProviderMarkerPath(this.environment, definition),
        ] : []),
      ];
      for (const path of paths) {
        if (!files.paths.includes(path)) files.paths.push(path);
      }
      filesByProvider.set(definition.id, files);
    }
    this.filesByProvider = [...filesByProvider.values()];
    this.visibleProviderIds = visibleProviderIds;
  }

  start(): void {
    this.fingerprints = this.tryReadFingerprints() ?? new Map<string, string>();
    // The supervisor owns the applied baseline, so a Gateway rebuild cannot lose pending changes.
    for (const provider of this.visibleProviderIds) this.pendingProviders.set(provider, 0);
    this.initialized = true;
    this.timer = setInterval(() => {
      void this.checkNow();
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
    if (!this.restartTask) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.restartTask,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn({ timeoutMs: this.stopTimeoutMs }, "Provider 设置应用停止等待超时");
            resolve();
          }, this.stopTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async checkNow(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const nextFingerprints = this.tryReadFingerprints();
    if (!nextFingerprints) {
      return;
    }
    if (this.initialized && !sameFingerprints(this.fingerprints, nextFingerprints)) {
      const providers = this.filesByProvider
        .filter(({ paths }) => paths.some((path) =>
          this.fingerprints.get(path) !== nextFingerprints.get(path)))
        .map(({ provider }) => provider)
        .filter((provider) => this.visibleProviderIds.has(provider));
      if (providers.length === 0) {
        this.fingerprints = nextFingerprints;
        this.considerRestart();
        await this.restartTask;
        return;
      }
      if (!this.validateSettings(providers)) {
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
      await this.restartTask;
      return;
    }
    if (this.pendingProviders.size > 0) {
      this.considerRestart();
    }
    await this.restartTask;
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
    if (!this.validateSettings([...pending.keys()])) return;
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
        void this.checkNow();
        if (this.stopping) return;
        const current = this.tryReadFingerprints();
        if (!current || this.filesByProvider.some((files) => files.provider === provider
          && files.paths.some((path) => current.get(path) !== this.fingerprints.get(path)))) continue;
        if (this.pendingProviders.get(provider) !== generation) continue;
        await this.refreshProviderModels(provider, this.cancellation.signal);
        if (this.stopping) return;
        const confirmed = this.tryReadFingerprints();
        if (!confirmed || this.filesByProvider.some((files) => files.provider === provider
          && files.paths.some((path) => confirmed.get(path) !== this.fingerprints.get(path)))) {
          void this.checkNow();
          continue;
        }
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

  private validateSettings(providers: readonly string[]): boolean {
    try {
      this.validate();
      return true;
    } catch (error) {
      const now = this.nowMs();
      if (now - this.lastValidationFailureAt >= this.validationCooldownMs) {
        this.lastValidationFailureAt = now;
        this.logger.error(
          { err: error, providers },
          "第三方模型设置变化校验失败，继续使用现有配置并等待修复",
        );
      }
      return false;
    }
  }

  private tryReadFingerprints(): Map<string, string> | undefined {
    try {
      return this.readFingerprints();
    } catch (error) {
      const now = this.nowMs();
      if (now - this.lastReadFailureAt >= this.validationCooldownMs) {
        this.lastReadFailureAt = now;
        this.logger.error(
          { err: error },
          "读取第三方模型设置失败，继续使用现有配置并等待修复",
        );
      }
      return undefined;
    }
  }

  private readFingerprints(): Map<string, string> {
    const fingerprints = new Map<string, string>();
    for (const { paths } of this.filesByProvider) {
      for (const path of paths) {
        fingerprints.set(path, readFileFingerprint(path));
      }
    }
    return fingerprints;
  }
}

function readFileFingerprint(path: string): string {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  return createHash("sha256").update(content).digest("hex");
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
