import { modelRequestDiagnosticKeys, validModelRequestDiagnostics } from "./chat-diagnostics.js";
import { validRequestTiming } from "../../runtime/request-timing.mjs";
import { sanitizeModelRequestUrl } from "../../runtime/model-request-address.mjs";
import { modelRequestPolicy } from "../../runtime/model-request-policy.mjs";
import type { Socket } from "node:net";

import {
  createPrivateIpcConnectionAsync,
  PrivateIpcServer,
} from "../../runtime/private-ipc.mjs";

import {
  boundedString,
  responseUsageAmount,
  type ProviderProxyMetrics,
} from "./response-metrics-observer.js";

const maximumMetricsBytes = 8_192;
const maximumConfirmationBytes = 16;
const metricsFields = [
  "upstreamUrl", "transport", "responseFormat", "operation", "threadId", "turnId", "requestPurpose",
  "reviewerThreadId", "reviewerTurnId", "model", "serviceTier", "requestServiceTier",
  "reasoningEffort", "status", "httpStatus", "userAgent", "errorType", "errorCode",
  "errorMessage", "incompleteReason", "inputTokens", "cachedInputTokens", "outputTokens",
  "reasoningOutputTokens", "totalTokens", "responseUsageAmount", "upstreamTtftMs",
  "firstTokenMs", "responseTimeMs", "generationTiming", "timingBasis", "totalDurationMs",
  "requestBytes", "requestModel", "responseModel", "traffic", "requestStartedAtMs", "responseCompletedAtMs",
  "weeklyQuota", "quotaObservedAtMs", "quotaWindows", ...modelRequestDiagnosticKeys,
] as const satisfies readonly (keyof ProviderProxyMetrics)[];

export class ProviderProxyMetricsServer {
  private readonly server: PrivateIpcServer;
  private readonly sockets = new Set<Socket>();
  private started = false;
  private stopped = false;

  constructor(
    private readonly socketPath: string,
    private readonly onMetrics: (metrics: ProviderProxyMetrics) => void,
    private readonly onError?: (error: Error) => void,
  ) {
    this.server = new PrivateIpcServer(this.socketPath, (socket) => this.handleConnection(socket), {
      maximumConnections: 8,
      connectionTimeoutMs: modelRequestPolicy.metricsDeliveryTimeoutMs,
    });
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("模型代理指标接收器已关闭");
    if (this.started) {
      return;
    }
    try {
      await this.server.start(`模型代理指标 Socket 已被占用：${this.socketPath}`);
      this.started = true;
    } catch (error) {
      // PrivateIpcServer owns failed-start cleanup; explicit close permanently withdraws admission.
      for (const socket of this.sockets) socket.destroy();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.closeResources();
  }

  private async closeResources(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await this.server.close();
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    let bytes = 0;
    const chunks: Buffer[] = [];
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) {
        return;
      }
      bytes += chunk.length;
      if (bytes > maximumMetricsBytes) {
        handled = true;
        socket.pause();
        socket.end("rejected\n");
        this.onError?.(new Error("模型代理指标超过大小限制"));
        return;
      }
      chunks.push(chunk);
      const payload = Buffer.concat(chunks);
      const newline = payload.indexOf(10);
      if (newline < 0) {
        return;
      }
      handled = true;
      socket.pause();
      try {
        const metrics = newline === payload.length - 1
          ? parseMetrics(new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(0, newline)))
          : undefined;
        if (!metrics) throw new Error("模型代理指标格式无效");
        this.onMetrics(metrics);
        socket.end("ok\n");
      } catch (error) {
        socket.end("rejected\n");
        this.onError?.(asError(error));
      }
    });
    socket.on("end", () => {
      if (!handled) {
        handled = true;
        socket.end("rejected\n");
        this.onError?.(new Error("模型代理指标帧不完整"));
      }
    });
    socket.on("error", (error) => this.onError?.(asError(error)));
    socket.on("close", () => this.sockets.delete(socket));
  }
}

export function sendProviderProxyMetrics(
  socketPath: string,
  metrics: ProviderProxyMetrics,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: Socket | undefined;
    const cancellation = new AbortController();
    let settled = false;
    let confirmation = Buffer.alloc(0);
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancellation.abort();
      socket?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("模型代理指标确认超时")), modelRequestPolicy.metricsDeliveryTimeoutMs);
    let payload: string;
    try {
      payload = `${JSON.stringify(metrics)}\n`;
      if (Buffer.byteLength(payload) > maximumMetricsBytes) throw new Error();
    } catch {
      finish(new Error("模型代理指标无法编码或超过大小限制"));
      return;
    }
    void createPrivateIpcConnectionAsync(socketPath, { signal: cancellation.signal }).then(connection => {
      socket = connection;
      socket.once("error", () => finish(new Error("模型代理指标传输失败")));
      if (settled) { socket.destroy(); return; }
      socket.once("connect", () => {
        if (settled) return;
        try { connection.write(payload); }
        catch { finish(new Error("模型代理指标传输失败")); }
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (confirmation.length + chunk.length > maximumConfirmationBytes) {
          finish(new Error("模型代理指标确认无效"));
          return;
        }
        confirmation = Buffer.concat([confirmation, chunk]);
        if (!confirmation.includes(10)) return;
        const reply = confirmation.toString("utf8");
        if (reply === "ok\n") finish();
        else finish(new Error(reply === "rejected\n" ? "模型代理指标未获受理" : "模型代理指标确认无效"));
      });
      socket.once("end", () => finish(new Error("模型代理指标确认前连接已关闭")));
      socket.once("close", () => finish(new Error("模型代理指标确认前连接已关闭")));
    }).catch(() => finish(new Error("模型代理指标连接失败")));
  });
}

function validAutoReviewIdentity(record: Record<string, unknown>): boolean {
  const validIdentity = (value: unknown): boolean => value === undefined || value === null
    || (typeof value === "string" && value.trim().length > 0 && value.length <= 128);
  if (!validIdentity(record.reviewerThreadId) || !validIdentity(record.reviewerTurnId)) return false;
  if (record.requestPurpose === undefined || record.requestPurpose === null) {
    return record.reviewerThreadId == null && record.reviewerTurnId == null;
  }
  return record.requestPurpose === "autoApprovalReview"
    && ((record.threadId === null && record.turnId === null)
      || (typeof record.threadId === "string" && typeof record.turnId === "string"
        && validIdentity(record.threadId) && validIdentity(record.turnId)));
}

function parseMetrics(value: string): ProviderProxyMetrics | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.upstreamUrl != null && sanitizeModelRequestUrl(record.upstreamUrl) !== record.upstreamUrl) return undefined;
  if ((record.operation === "imageGeneration" || record.operation === "imageEdit")
    && (record.transport !== "http" || record.inputTokens !== null || record.cachedInputTokens !== null
      || record.outputTokens !== null || record.reasoningOutputTokens !== null || record.totalTokens !== null
      || record.firstTokenMs != null || record.upstreamTtftMs != null || record.generationTiming != null
      || record.responseUsageAmount != null)) return undefined;
  if (
    !validModelRequestDiagnostics(record) || !validRequestTiming(record)
    || Object.hasOwn(record, "firstContentMs")
    || ((record.firstTokenMs !== undefined || record.totalDurationMs !== undefined || record.responseTimeMs !== undefined || record.generationTiming !== undefined)
      && record.timingBasis !== "submitted")
    || (record.timingBasis !== undefined && record.timingBasis !== "submitted")
    || !oneOf(record.transport, ["http", "websocket"])
    || !oneOf(record.responseFormat, ["sse", "json", "websocket", "unknown"])
    || !oneOf(record.operation, ["response", "compact", "imageGeneration", "imageEdit"])
    || !nullableString(record.threadId)
    || !nullableString(record.turnId)
    || !validAutoReviewIdentity(record)
    || !nullableString(record.model)
    || (record.requestModel !== undefined && !nullableString(record.requestModel))
    || (record.responseModel !== undefined && !nullableString(record.responseModel))
    || (record.traffic !== undefined && !validTrafficReference(record.traffic))
    || !nullableString(record.serviceTier)
    || !nullableString(record.reasoningEffort)
    || (record.requestServiceTier !== undefined && !nullableString(record.requestServiceTier))
    || !oneOf(record.status, ["completed", "failed", "incomplete", "unknown"])
    || !nullableHttpStatus(record.httpStatus)
    || !nullableUserAgent(record.userAgent)
    || !nullableString(record.errorType)
    || !nullableString(record.errorCode)
    || !nullableMessage(record.errorMessage)
    || !nullableString(record.incompleteReason)
    || !nullableTokenCount(record.inputTokens)
    || !nullableTokenCount(record.cachedInputTokens)
    || !nullableTokenCount(record.outputTokens)
    || !nullableTokenCount(record.reasoningOutputTokens)
    || !nullableTokenCount(record.totalTokens)
    || (record.responseUsageAmount !== undefined && record.responseUsageAmount !== null
      && responseUsageAmount(record.responseUsageAmount) === null)
    || !finiteNumber(record.requestStartedAtMs)
    || !finiteNumber(record.responseCompletedAtMs)
    || (record.totalDurationMs !== undefined
      && (typeof record.totalDurationMs !== "number"
        || !Number.isFinite(record.totalDurationMs) || record.totalDurationMs < 0))
    || (record.requestBytes !== undefined && !nullableByteCount(record.requestBytes))
    || (record.firstTokenMs !== undefined
      && (typeof record.firstTokenMs !== "number"
        || !Number.isFinite(record.firstTokenMs) || record.firstTokenMs < 0))
    || (record.upstreamTtftMs !== undefined
      && (typeof record.upstreamTtftMs !== "number"
        || !Number.isFinite(record.upstreamTtftMs) || record.upstreamTtftMs < 0))
  ) {
    return undefined;
  }
  const weeklyQuota = record.weeklyQuota;
  if (!nullableWeeklyQuota(weeklyQuota)) {
    return undefined;
  }
  const quotaWindows = record.quotaWindows;
  if (!nullableQuotaWindows(quotaWindows)) {
    return undefined;
  }
  const quotaObservedAtMs = record.quotaObservedAtMs;
  if (quotaObservedAtMs !== undefined && !nullableTokenCount(quotaObservedAtMs)) {
    return undefined;
  }
  if (quotaObservedAtMs != null && weeklyQuota == null
    && (!Array.isArray(quotaWindows) || quotaWindows.length === 0)) {
    return undefined;
  }
  const userAgent = record.userAgent;
  // This private IPC owns request facts only; Provider, source and recording time belong to Gateway.
  const metrics = Object.fromEntries(metricsFields
    .filter(key => Object.hasOwn(record, key))
    .map(key => [key, record[key]])) as unknown as ProviderProxyMetrics;
  return {
    ...metrics,
    userAgent: typeof userAgent === "string" ? userAgent : null,
    reasoningEffort: boundedString(record.reasoningEffort),
    // Prior senders may include bounded prose; never admit it across this boundary.
    errorMessage: null,
    ...(metrics.traffic === undefined ? {} : { traffic: {
      label: metrics.traffic.label,
      session: metrics.traffic.session,
      interaction: metrics.traffic.interaction,
    } }),
    weeklyQuota: metrics.weeklyQuota === null ? null : {
      limitId: metrics.weeklyQuota.limitId,
      usedPercentMillionths: metrics.weeklyQuota.usedPercentMillionths,
      resetsAt: metrics.weeklyQuota.resetsAt,
      planType: metrics.weeklyQuota.planType,
    },
    quotaWindows: metrics.quotaWindows === null ? null : metrics.quotaWindows.map(window => ({
      windowId: window.windowId,
      resetsAt: window.resetsAt,
      ...(window.usedPercentMillionths === undefined ? {} : { usedPercentMillionths: window.usedPercentMillionths }),
      ...(window.status === undefined ? {} : { status: window.status }),
    })),
    quotaObservedAtMs: metrics.quotaObservedAtMs ?? null,
  };
}

function validTrafficReference(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return typeof reference.label === "string" && /^[A-Za-z0-9._-]{1,256}$/u.test(reference.label)
    && typeof reference.session === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(reference.session)
    && typeof reference.interaction === "number"
    && Number.isSafeInteger(reference.interaction) && reference.interaction > 0;
}

function nullableQuotaWindows(value: unknown): boolean {
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const window = entry as Record<string, unknown>;
    return typeof window.windowId === "string"
      && window.windowId.length > 0
      && window.windowId.length <= 64
      && (
        window.resetsAt === null
        || (
          typeof window.resetsAt === "number"
          && Number.isSafeInteger(window.resetsAt)
          && window.resetsAt >= 0
        )
      )
      && (
        window.usedPercentMillionths === undefined
        || window.usedPercentMillionths === null
        || (
          typeof window.usedPercentMillionths === "number"
          && Number.isSafeInteger(window.usedPercentMillionths)
          && window.usedPercentMillionths >= 0
          && window.usedPercentMillionths <= 100_000_000
        )
      )
      && (
        window.status === undefined
        || window.status === null
        || (
          typeof window.status === "string"
          && window.status.length > 0
          && window.status.length <= 64
        )
      );
  });
}

function nullableByteCount(value: unknown): boolean {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function nullableWeeklyQuota(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const quota = value as Record<string, unknown>;
  return quota.limitId === "codex"
    && typeof quota.usedPercentMillionths === "number"
    && Number.isSafeInteger(quota.usedPercentMillionths)
    && quota.usedPercentMillionths >= 0
    && quota.usedPercentMillionths <= 100_000_000
    && typeof quota.resetsAt === "number"
    && Number.isSafeInteger(quota.resetsAt)
    && quota.resetsAt >= 0
    && (
      quota.planType === null
      || (
        typeof quota.planType === "string"
        && quota.planType.length > 0
        && quota.planType.length <= 64
      )
    );
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function nullableString(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length <= 128);
}

function nullableMessage(value: unknown): boolean {
  return value === null
    || (typeof value === "string" && value.length > 0 && value.length <= 500);
}

function nullableUserAgent(value: unknown): boolean {
  return value === null
    || (typeof value === "string" && value.length > 0 && value.length <= 512);
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableTokenCount(value: unknown): boolean {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function nullableHttpStatus(value: unknown): boolean {
  return value === null
    || (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
