import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "pino";

import type {
  ExchangeRatePort,
  ExchangeRateSnapshot,
} from "../application/index.js";

const primaryRateUrl = "https://open.er-api.com/v6/latest/USD";
const fallbackRateUrl = "https://api.frankfurter.app/latest?from=USD&to=CNY";
const defaultRefreshIntervalMs = 6 * 60 * 60 * 1_000;
const requestTimeoutMs = 10_000;
const maximumRateBytes = 256 * 1024;
const minimumUsdToCny = 0.1;
const maximumUsdToCny = 1_000;
const cacheVersion = 1;

interface PersistedExchangeRate {
  version: 1;
  source: ExchangeRateSnapshot["source"];
  effectiveAtMs: number;
  usdToCny: number;
}

export interface RemoteExchangeRateOptions {
  cachePath: string;
  fetchImpl: typeof fetch;
  logger: Logger;
  refreshIntervalMs?: number;
  now?: () => number;
}

export class RemoteExchangeRate implements ExchangeRatePort {
  private snapshot: ExchangeRateSnapshot | null;
  private refreshTask: Promise<void> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private activeRequest: AbortController | undefined;
  private closed = false;

  constructor(private readonly options: RemoteExchangeRateOptions) {
    this.snapshot = loadCachedExchangeRate(options.cachePath, options.logger);
  }

  start(): void {
    if (this.closed || this.refreshTimer) return;
    void this.refresh().catch((error) => {
      this.options.logger.warn({ err: error }, "汇率首次刷新失败，继续使用本地缓存");
    });
    const interval = this.options.refreshIntervalMs ?? defaultRefreshIntervalMs;
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch((error) => {
        this.options.logger.warn({ err: error }, "汇率后台刷新失败，继续使用本地缓存");
      });
    }, interval);
    this.refreshTimer.unref();
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("汇率组件已关闭"));
    this.refreshTask ??= this.refreshOnce().finally(() => {
      this.refreshTask = undefined;
    });
    return this.refreshTask;
  }

  resolve(): ExchangeRateSnapshot | null {
    return this.snapshot;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.activeRequest?.abort();
    await this.refreshTask?.catch(() => undefined);
  }

  private async refreshOnce(): Promise<void> {
    const sources = [{
      id: "open-er-api" as const,
      url: primaryRateUrl,
    }, {
      id: "ecb" as const,
      url: fallbackRateUrl,
    }];
    let lastError: unknown;
    for (const source of sources) {
      try {
        const updated = await this.fetchSource(source);
        if (updated) {
          this.snapshot = updated;
          await persistExchangeRate(this.options.cachePath, updated);
          this.options.logger.info(
            { source: source.id, usdToCny: updated.usdToCny },
            "USD/CNY 汇率已更新",
          );
        }
        return;
      } catch (error) {
        lastError = error;
        this.options.logger.warn(
          { err: error, source: source.id },
          "汇率来源不可用，尝试下一来源",
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("所有汇率来源均不可用");
  }

  private async fetchSource(source: {
    id: "open-er-api" | "ecb";
    url: string;
  }): Promise<ExchangeRateSnapshot | null> {
    const controller = new AbortController();
    this.activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await this.options.fetchImpl(source.url, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`汇率请求失败：HTTP ${response.status}`);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maximumRateBytes) {
        throw new Error("汇率响应超过大小限制");
      }
      const body = await readBoundedResponseBody(response);
      const usdToCny = parseUsdToCny(body);
      return {
        source: source.id,
        effectiveAtMs: (this.options.now ?? Date.now)(),
        usdToCny,
      };
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
  }
}

function parseUsdToCny(body: Uint8Array): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("汇率响应不是有效 JSON");
  }
  const rates = isRecord(parsed) ? isRecord(parsed.rates) ? parsed.rates : undefined : undefined;
  const cny = rates?.CNY;
  if (
    typeof cny !== "number"
    || !Number.isFinite(cny)
    || cny < minimumUsdToCny
    || cny > maximumUsdToCny
  ) {
    throw new Error("汇率响应缺少有效 USD/CNY 值");
  }
  return cny;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? true
    : false;
}

function loadCachedExchangeRate(path: string, logger: Logger): ExchangeRateSnapshot | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("汇率缓存必须是普通文件");
    }
    if (stat.size > maximumRateBytes) {
      throw new Error("汇率缓存超过大小限制");
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPersistedExchangeRate(parsed)) throw new Error("汇率缓存格式无效");
    chmodSync(path, 0o600);
    return {
      usdToCny: parsed.usdToCny,
      effectiveAtMs: parsed.effectiveAtMs,
      source: parsed.source,
    };
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      logger.warn({ err: error }, "汇率缓存不可用，等待远程刷新");
    }
    return null;
  }
}

function isPersistedExchangeRate(value: unknown): value is PersistedExchangeRate {
  if (!isRecord(value) || value.version !== cacheVersion) return false;
  if (
    value.source !== "open-er-api"
    && value.source !== "ecb"
    && value.source !== "cache"
  ) {
    return false;
  }
  if (!Number.isSafeInteger(value.effectiveAtMs) || Number(value.effectiveAtMs) <= 0) {
    return false;
  }
  const rate = value.usdToCny;
  return typeof rate === "number"
    && Number.isFinite(rate)
    && rate >= minimumUsdToCny
    && rate <= maximumUsdToCny;
}

async function persistExchangeRate(
  path: string,
  snapshot: ExchangeRateSnapshot,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const persisted: PersistedExchangeRate = {
    version: cacheVersion,
    source: snapshot.source,
    effectiveAtMs: snapshot.effectiveAtMs,
    usdToCny: snapshot.usdToCny,
  };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(persisted)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readBoundedResponseBody(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error("汇率响应缺少正文");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumRateBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("汇率响应超过大小限制");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
