import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

import type { Logger } from "pino";

import { writePrivateFileAtomic } from "../../runtime/private-file.mjs";

import type {
  ModelRequestMetricsStore,
  StoredModelRequestMetric,
  StoredSubagentThreadRecord,
} from "./request-metrics.js";

const requestTimeoutMs = 30_000;
const maximumBackoffMs = 60 * 60 * 1_000;
const stateVersion = 1;

export interface MetricsSyncConfig {
  enabled: boolean;
  endpoint?: string;
  deviceToken?: string;
  deviceId?: string;
  deviceName?: string;
  batchSize: number;
  intervalSeconds: number;
}

export interface MetricsSyncOptions {
  config: MetricsSyncConfig;
  store: ModelRequestMetricsStore;
  statePath: string;
  fetchImpl: typeof fetch;
  logger: Logger;
  providerIdentities?: () => readonly MetricsProviderIdentity[];
}

export interface MetricsProviderIdentity {
  provider: string;
  displayName: string;
  email?: string;
  phone?: string;
}

export interface SyncedRequestMetric
  extends Omit<StoredModelRequestMetric, "id" | "errorMessage"> {
  localId: number;
}

export interface MetricsSyncPayload {
  deviceId: string;
  deviceName: string;
  requestMetrics: SyncedRequestMetric[];
  subagentThreads: StoredSubagentThreadRecord[];
  providerIdentities?: readonly MetricsProviderIdentity[];
}

export class MetricsSyncHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.name = "MetricsSyncHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

interface PersistedMetricsSyncState {
  version: 1;
  deviceId: string;
  lastRequestLocalId: number;
  lastSubagentRecordedAtMs: number;
  lastSubagentThreadId: string | null;
  lastProviderIdentitySignature?: string;
}

export class MetricsSync {
  private state: PersistedMetricsSyncState;
  private timer: NodeJS.Timeout | undefined;
  private currentRun: Promise<void> | undefined;
  private activeRequest: AbortController | undefined;
  private closed = false;
  private consecutiveFailures = 0;

  constructor(private readonly options: MetricsSyncOptions) {
    const persisted = loadState(options.statePath, options.logger);
    this.state = persisted !== null
      && (
        options.config.deviceId === undefined
        || options.config.deviceId === persisted.deviceId
      )
      ? persisted
      : {
          version: stateVersion,
          deviceId: options.config.deviceId ?? randomUUID(),
          lastRequestLocalId: 0,
          lastSubagentRecordedAtMs: 0,
          lastSubagentThreadId: null,
        };
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.schedule(0);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.activeRequest?.abort();
    await this.currentRun?.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.currentRun = this.tick().finally(() => {
        this.currentRun = undefined;
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      await this.syncOnce();
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      const retryAfterMs = error instanceof MetricsSyncHttpError
        ? error.retryAfterMs ?? 0
        : 0;
      this.options.logger.warn(
        {
          err: error,
          failures: this.consecutiveFailures,
          retryAfterMs: retryAfterMs > 0 ? retryAfterMs : undefined,
        },
        "指标同步失败，稍后重试",
      );
      const baseDelayMs = this.options.config.intervalSeconds * 1_000;
      const backoffMs = Math.min(
        baseDelayMs * 2 ** Math.max(this.consecutiveFailures - 1, 0),
        maximumBackoffMs,
      );
      this.schedule(Math.max(baseDelayMs, backoffMs, retryAfterMs));
      return;
    }
    if (this.closed) return;
    const baseDelayMs = this.options.config.intervalSeconds * 1_000;
    const backoffMs = Math.min(
      baseDelayMs * 2 ** Math.max(this.consecutiveFailures - 1, 0),
      maximumBackoffMs,
    );
    this.schedule(Math.max(baseDelayMs, backoffMs));
  }

  private async syncOnce(): Promise<void> {
    if (this.closed || !this.options.config.enabled) return;
    const endpoint = this.options.config.endpoint;
    const deviceToken = this.options.config.deviceToken;
    if (!endpoint || !deviceToken) {
      throw new Error("指标同步配置不完整：缺少 endpoint 或 device_token");
    }
    const requestRows = this.options.store.requestRowsAfter(
      this.state.lastRequestLocalId,
      this.options.config.batchSize,
    );
    const subagentRows = this.options.store.subagentThreadsAfter(
      this.state.lastSubagentRecordedAtMs,
      this.state.lastSubagentThreadId ?? undefined,
    );
    const providerIdentities = this.options.providerIdentities?.() ?? [];
    const providerIdentitySignature = JSON.stringify(
      [...providerIdentities].sort((left, right) => left.provider.localeCompare(right.provider)),
    );
    const identitiesConfigured = this.options.providerIdentities !== undefined;
    const identitiesChanged = identitiesConfigured
      && providerIdentitySignature !== this.state.lastProviderIdentitySignature;
    if (requestRows.length === 0 && subagentRows.length === 0 && !identitiesChanged) {
      return;
    }
    const payload: MetricsSyncPayload = {
      deviceId: this.state.deviceId,
      deviceName: this.options.config.deviceName ?? hostname(),
      requestMetrics: requestRows.map(toSyncedRequestMetric),
      subagentThreads: subagentRows,
      ...(identitiesConfigured ? { providerIdentities } : {}),
    };
    await this.postBatch(endpoint, deviceToken, payload);
    const lastRequest = requestRows[requestRows.length - 1];
    const lastSubagent = subagentRows[subagentRows.length - 1];
    if (lastRequest) {
      this.state.lastRequestLocalId = lastRequest.id;
    }
    if (lastSubagent) {
      this.state.lastSubagentRecordedAtMs = lastSubagent.recordedAtMs;
      this.state.lastSubagentThreadId = lastSubagent.threadId;
    }
    this.state.lastProviderIdentitySignature = providerIdentitySignature;
    this.options.logger.info(
      {
        deviceId: this.state.deviceId,
        requestCount: requestRows.length,
        subagentCount: subagentRows.length,
        lastRequestLocalId: this.state.lastRequestLocalId,
      },
      "指标已同步到中心",
    );
    await persistState(this.options.statePath, this.state);
  }

  private async postBatch(
    endpoint: string,
    deviceToken: string,
    payload: MetricsSyncPayload,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await this.options.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deviceToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MetricsSyncHttpError(
          `指标同步请求失败：HTTP ${response.status}`,
          response.status,
          parseRetryAfterMs(response.headers.get("retry-after")),
        );
      }
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === controller) {
        this.activeRequest = undefined;
      }
    }
  }
}

function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | null {
  if (value === null || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1_000);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return Math.max(0, parsed - nowMs);
  }
  return null;
}

function toSyncedRequestMetric(
  row: StoredModelRequestMetric,
): SyncedRequestMetric {
  const { id, errorMessage: _errorMessage, ...rest } = row;
  void _errorMessage;
  return {
    localId: id,
    ...rest,
  };
}

function loadState(
  path: string,
  logger: Logger,
): PersistedMetricsSyncState | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isPersistedState(parsed)) return parsed;
    logger.warn({ path }, "指标同步状态文件无效，将重建");
    return null;
  } catch {
    return null;
  }
}

function isPersistedState(value: unknown): value is PersistedMetricsSyncState {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === stateVersion
    && typeof candidate.deviceId === "string"
    && candidate.deviceId.length > 0
    && typeof candidate.lastRequestLocalId === "number"
    && Number.isInteger(candidate.lastRequestLocalId)
    && candidate.lastRequestLocalId >= 0
    && typeof candidate.lastSubagentRecordedAtMs === "number"
    && Number.isInteger(candidate.lastSubagentRecordedAtMs)
    && candidate.lastSubagentRecordedAtMs >= 0
    && (candidate.lastSubagentThreadId === null
      || (
        typeof candidate.lastSubagentThreadId === "string"
        && candidate.lastSubagentThreadId.length > 0
      ));
}

async function persistState(
  path: string,
  state: PersistedMetricsSyncState,
): Promise<void> {
  await writePrivateFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}
