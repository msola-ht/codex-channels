import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";

import { codexHomePath } from "../../runtime/codex-home.mjs";
import {
  deepseekProviderDefinition,
  loadManagedModelProviderDefinitions,
  opencodeGoProviderDefinition,
} from "../../runtime/model-provider-definitions.mjs";
import {
  managedProviderMarkerPath,
  managedProviderDirectory,
  validateConfiguredModelProviders,
} from "../../runtime/model-provider-runtime.mjs";

export interface ProviderSettingsWatcherOptions {
  logger: Logger;
  hasActiveTurns: () => boolean;
  restartAppServer: () => Promise<void>;
  onStateChange?: (change: ProviderSettingsStateChange) => void;
  environment?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  restartCooldownMs?: number;
  validationCooldownMs?: number;
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
  providers: string[];
}

interface ManagedProviderFiles {
  provider: string;
  paths: string[];
}

const defaultPollIntervalMs = 2_000;
const defaultRestartCooldownMs = 30_000;
const defaultValidationCooldownMs = 30_000;

export class ProviderSettingsWatcher {
  private readonly logger: Logger;
  private readonly hasActiveTurns: () => boolean;
  private readonly restartAppServer: () => Promise<void>;
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
  private fingerprints = new Map<string, string>();
  private lastReadFailureAt = Number.NEGATIVE_INFINITY;
  private lastValidationFailureAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private initialized = false;
  private restartInFlight = false;
  private restartPending = false;
  private pendingProviders: string[] = [];
  private lastRestartAttemptAt = 0;

  constructor(options: ProviderSettingsWatcherOptions) {
    this.logger = options.logger;
    this.hasActiveTurns = options.hasActiveTurns;
    this.restartAppServer = options.restartAppServer;
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
    const codexHome = codexHomePath(this.environment);
    const baseDefinitions = [deepseekProviderDefinition, opencodeGoProviderDefinition];
    const definitions = [
      ...baseDefinitions,
      ...loadManagedModelProviderDefinitions(this.environment).filter(
        (definition) => !baseDefinitions.some((base) => base.id === definition.id),
      ),
    ];
    this.filesByProvider = definitions.map((definition) => ({
      provider: definition.id,
      paths: [
        join(
          managedProviderDirectory(this.environment, definition),
          definition.catalogFileName,
        ),
        join(codexHome, definition.profileFileName),
        managedProviderMarkerPath(this.environment, definition),
      ],
    }));
  }

  start(): void {
    this.fingerprints = this.tryReadFingerprints() ?? new Map<string, string>();
    this.initialized = true;
    this.timer = setInterval(() => {
      void this.checkNow();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  checkNow(): void {
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
        .map(({ provider }) => provider);
      if (!this.validateSettings(providers)) {
        return;
      }
      this.fingerprints = nextFingerprints;
      this.pendingProviders = providers;
      this.emitState("scheduled", providers);
      this.logger.info(
        { providers },
        "第三方模型设置已变化，准备重启 App Server 使其生效",
      );
      this.considerRestart();
      return;
    }
    if (this.restartPending) {
      this.considerRestart();
    }
  }

  private considerRestart(): void {
    if (this.stopping || this.restartInFlight) {
      this.restartPending = true;
      return;
    }
    if (this.hasActiveTurns()) {
      if (!this.restartPending) {
        this.logger.info(
          { providers: this.pendingProviders },
          "第三方模型设置已变化，等待当前 Turn 完成后重启 App Server",
        );
      }
      this.restartPending = true;
      return;
    }
    if (this.nowMs() - this.lastRestartAttemptAt < this.restartCooldownMs) {
      this.restartPending = true;
      return;
    }
    if (!this.validateSettings(this.pendingProviders)) {
      this.restartPending = true;
      return;
    }
    const providers = this.pendingProviders;
    this.restartPending = false;
    this.pendingProviders = [];
    void this.runRestart(providers);
  }

  private async runRestart(providers: string[]): Promise<void> {
    if (this.stopping || this.restartInFlight) {
      return;
    }
    this.restartInFlight = true;
    this.lastRestartAttemptAt = this.nowMs();
    this.emitState("restarting", providers);
    this.logger.info(
      { providers },
      "正在重启 App Server 以应用第三方模型设置",
    );
    try {
      await this.restartAppServer();
      this.emitState("applied", providers);
      this.logger.info(
        { providers },
        "第三方模型设置已应用，App Server 重启完成",
      );
    } catch (error) {
      this.emitState("failed", providers);
      this.restartPending = true;
      this.pendingProviders = providers;
      this.logger.error(
        { err: error, providers },
        "第三方模型设置变化后 App Server 重启失败，将在冷却后重试",
      );
    } finally {
      this.restartInFlight = false;
    }
  }

  private emitState(
    kind: ProviderSettingsStateKind,
    providers: string[],
  ): void {
    if (!this.onStateChange) {
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
