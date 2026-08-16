import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";

import { codexHomePath } from "../../runtime/codex-home.mjs";
import { managedModelProviderDefinitions } from "../../runtime/model-provider-definitions.mjs";
import { validateConfiguredModelProviders } from "../../runtime/model-provider-runtime.mjs";

export interface ProviderSettingsWatcherOptions {
  logger: Logger;
  hasActiveTurns: () => boolean;
  restartAppServer: () => Promise<void>;
  environment?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  restartCooldownMs?: number;
  validate?: () => void;
}

interface ManagedProviderFiles {
  provider: string;
  paths: string[];
}

const defaultPollIntervalMs = 2_000;
const defaultRestartCooldownMs = 30_000;

export class ProviderSettingsWatcher {
  private readonly logger: Logger;
  private readonly hasActiveTurns: () => boolean;
  private readonly restartAppServer: () => Promise<void>;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly pollIntervalMs: number;
  private readonly restartCooldownMs: number;
  private readonly validate: () => void;
  private readonly filesByProvider: ManagedProviderFiles[];
  private fingerprints = new Map<string, string>();
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
    this.environment = options.environment ?? process.env;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    this.restartCooldownMs = options.restartCooldownMs ?? defaultRestartCooldownMs;
    this.validate = options.validate ?? (() => {
      validateConfiguredModelProviders(this.environment);
    });
    const codexHome = codexHomePath(this.environment);
    this.filesByProvider = managedModelProviderDefinitions.map((definition) => ({
      provider: definition.id,
      paths: [
        join(codexHome, definition.catalogFileName),
        join(codexHome, definition.profileFileName),
        join(codexHome, definition.managedMarkerFileName),
      ],
    }));
  }

  start(): void {
    this.fingerprints = this.readFingerprints();
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
    const nextFingerprints = this.readFingerprints();
    if (this.initialized && !sameFingerprints(this.fingerprints, nextFingerprints)) {
      const providers = this.filesByProvider
        .filter(({ paths }) => paths.some((path) =>
          this.fingerprints.get(path) !== nextFingerprints.get(path)))
        .map(({ provider }) => provider);
      try {
        this.validate();
      } catch (error) {
        this.logger.error(
          { err: error, providers },
          "第三方模型设置变化校验失败，继续使用现有配置并等待修复",
        );
        return;
      }
      this.fingerprints = nextFingerprints;
      this.pendingProviders = providers;
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
    if (Date.now() - this.lastRestartAttemptAt < this.restartCooldownMs) {
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
    this.lastRestartAttemptAt = Date.now();
    this.logger.info(
      { providers },
      "正在重启 App Server 以应用第三方模型设置",
    );
    try {
      await this.restartAppServer();
      this.logger.info(
        { providers },
        "第三方模型设置已应用，App Server 重启完成",
      );
    } catch (error) {
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
