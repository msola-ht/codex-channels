import {
  chmodSync,
  lstatSync,
  readFileSync,
} from "node:fs";

import type { Logger } from "pino";

import { writePrivateFileAtomic } from "../../runtime/private-file.mjs";

import { readBoundedFetchBody } from "./bounded-fetch-body.js";

import type {
  ModelPricingLookup,
  ModelPricingResolver,
  ModelRequestPricingSnapshot,
} from "../observability/index.js";

const primaryCatalogUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const fallbackCatalogUrl =
  "https://raw.githubusercontent.com/Wei-Shaw/model-price-repo/main/model_prices_and_context_window.json";
const defaultRefreshIntervalMs = 6 * 60 * 60 * 1_000;
const requestTimeoutMs = 10_000;
const maximumCatalogBytes = 12 * 1024 * 1024;
const cacheVersion = 1;

interface CatalogPrice {
  provider: string | null;
  input: number;
  priorityInput: number | null;
  cachedInput: number;
  priorityCachedInput: number | null;
  output: number;
  priorityOutput: number | null;
  longContextThreshold: number | null;
  longInputMultiplier: number | null;
  longCachedInputMultiplier: number | null;
  longOutputMultiplier: number | null;
}

interface PersistedCatalog {
  version: 1;
  source: "litellm" | "sub2api-mirror";
  etag: string | null;
  effectiveAtMs: number;
  entries: Record<string, CatalogPrice>;
}

export interface RemoteModelPricingCatalogOptions {
  cachePath: string;
  fetchImpl: typeof fetch;
  logger: Logger;
  refreshIntervalMs?: number;
  now?: () => number;
}

export class RemoteModelPricingCatalog implements ModelPricingResolver {
  private catalog: PersistedCatalog | null;
  private refreshTask: Promise<void> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private activeRequest: AbortController | undefined;
  private closed = false;

  constructor(private readonly options: RemoteModelPricingCatalogOptions) {
    this.catalog = loadCachedCatalog(options.cachePath, options.logger);
  }

  start(): void {
    if (this.closed || this.refreshTimer) return;
    void this.refresh().catch((error) => {
      this.options.logger.warn({ err: error }, "模型价格目录首次刷新失败，继续使用本地缓存");
    });
    const interval = this.options.refreshIntervalMs ?? defaultRefreshIntervalMs;
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch((error) => {
        this.options.logger.warn({ err: error }, "模型价格目录后台刷新失败，继续使用本地缓存");
      });
    }, interval);
    this.refreshTimer.unref();
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("模型价格目录已关闭"));
    this.refreshTask ??= this.refreshOnce().finally(() => {
      this.refreshTask = undefined;
    });
    return this.refreshTask;
  }

  resolve(lookup: ModelPricingLookup): ModelRequestPricingSnapshot | null {
    const catalog = this.catalog;
    if (!catalog || !lookup.model) return null;
    const price = resolveCatalogPrice(catalog.entries, lookup.model);
    if (!price) return null;
    const priority = lookup.serviceTier === "priority";
    const longContext = price.longContextThreshold !== null
      && lookup.inputTokens !== null
      && lookup.inputTokens > price.longContextThreshold;
    const input = selectPrice(
      price.input,
      priority ? price.priorityInput : null,
      longContext ? price.longInputMultiplier : null,
    );
    const cachedInput = selectPrice(
      price.cachedInput,
      priority ? price.priorityCachedInput : null,
      longContext ? price.longCachedInputMultiplier : null,
    );
    const output = selectPrice(
      price.output,
      priority ? price.priorityOutput : null,
      longContext ? price.longOutputMultiplier : null,
    );
    const uncachedInputPricePerMillionNanos = perTokenUsdToMillionNanos(input);
    const cachedInputPricePerMillionNanos = perTokenUsdToMillionNanos(cachedInput);
    const outputPricePerMillionNanos = perTokenUsdToMillionNanos(output);
    if (
      uncachedInputPricePerMillionNanos === null
      || cachedInputPricePerMillionNanos === null
      || outputPricePerMillionNanos === null
    ) {
      return null;
    }
    return {
      billingMode: lookup.provider === "openai"
        ? "subscription"
        : lookup.provider === "deepseek"
          ? "api"
          : "unknown",
      currency: "USD",
      source: catalog.source,
      effectiveAtMs: catalog.effectiveAtMs,
      uncachedInputPricePerMillionNanos,
      cachedInputPricePerMillionNanos,
      outputPricePerMillionNanos,
    };
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
      id: "litellm" as const,
      url: primaryCatalogUrl,
    }, {
      id: "sub2api-mirror" as const,
      url: fallbackCatalogUrl,
    }];
    let lastError: unknown;
    for (const source of sources) {
      try {
        const updated = await this.fetchSource(source);
        if (updated) {
          this.catalog = updated;
          await persistCatalog(this.options.cachePath, updated);
          this.options.logger.info(
            { source: source.id, modelCount: Object.keys(updated.entries).length },
            "模型价格目录已更新",
          );
        }
        return;
      } catch (error) {
        lastError = error;
        this.options.logger.warn(
          { err: error, source: source.id },
          "模型价格目录来源不可用，尝试下一来源",
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("模型价格目录所有来源均不可用");
  }

  private async fetchSource(source: {
    id: PersistedCatalog["source"];
    url: string;
  }): Promise<PersistedCatalog | null> {
    const controller = new AbortController();
    this.activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const etag = this.catalog?.source === source.id ? this.catalog.etag : null;
      const response = await this.options.fetchImpl(source.url, {
        signal: controller.signal,
        ...(etag ? { headers: { "if-none-match": etag } } : {}),
      });
      if (response.status === 304 && this.catalog?.source === source.id) return null;
      if (!response.ok) throw new Error(`价格目录请求失败：HTTP ${response.status}`);
      const body = await readBoundedFetchBody(response, maximumCatalogBytes, {
        invalidContentLength: () => new Error("价格目录响应大小无效"),
        tooLarge: () => new Error("价格目录超过大小限制"),
        missingBody: () => new Error("价格目录响应缺少正文"),
      });
      return {
        version: cacheVersion,
        source: source.id,
        etag: response.headers.get("etag"),
        effectiveAtMs: (this.options.now ?? Date.now)(),
        entries: parseRemoteCatalog(body),
      };
    } finally {
      clearTimeout(timeout);
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
  }
}

function parseRemoteCatalog(body: Uint8Array): Record<string, CatalogPrice> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!isRecord(parsed)) throw new Error("价格目录不是 JSON 对象");
  const entries: Record<string, CatalogPrice> = {};
  for (const [rawName, rawValue] of Object.entries(parsed)) {
    const name = rawName.trim().toLowerCase();
    if (!name || name.length > 256 || !isRecord(rawValue)) continue;
    const input = finiteNonNegative(rawValue.input_cost_per_token);
    const output = finiteNonNegative(rawValue.output_cost_per_token);
    if (input === null || output === null) continue;
    const cachedInput = finiteNonNegative(rawValue.cache_read_input_token_cost)
      ?? finiteNonNegative(rawValue.input_cost_per_token_cache_hit)
      ?? input;
    const long = longContextPrices(rawValue, input, cachedInput, output);
    entries[name] = {
      provider: safeIdentifier(rawValue.litellm_provider),
      input,
      priorityInput: finiteNonNegative(rawValue.input_cost_per_token_priority),
      cachedInput,
      priorityCachedInput: finiteNonNegative(
        rawValue.cache_read_input_token_cost_priority,
      ),
      output,
      priorityOutput: finiteNonNegative(rawValue.output_cost_per_token_priority),
      ...long,
    };
  }
  if (Object.keys(entries).length === 0) {
    throw new Error("价格目录没有可用的 Token 价格");
  }
  return entries;
}

function longContextPrices(
  raw: Record<string, unknown>,
  input: number,
  cachedInput: number,
  output: number,
): Pick<CatalogPrice,
  | "longContextThreshold"
  | "longInputMultiplier"
  | "longCachedInputMultiplier"
  | "longOutputMultiplier"
> {
  for (const threshold of [272_000, 200_000]) {
    const suffix = `_above_${threshold / 1_000}k_tokens`;
    const longInput = finiteNonNegative(raw[`input_cost_per_token${suffix}`]);
    const longCached = finiteNonNegative(
      raw[`cache_read_input_token_cost${suffix}`],
    );
    const longOutput = finiteNonNegative(raw[`output_cost_per_token${suffix}`]);
    if (longInput !== null || longCached !== null || longOutput !== null) {
      return {
        longContextThreshold: threshold,
        longInputMultiplier: multiplier(longInput, input),
        longCachedInputMultiplier: multiplier(longCached, cachedInput),
        longOutputMultiplier: multiplier(longOutput, output),
      };
    }
  }
  const configuredThreshold = safePositiveInteger(
    raw.long_context_input_token_threshold,
  );
  return {
    longContextThreshold: configuredThreshold,
    longInputMultiplier: finitePositive(raw.long_context_input_cost_multiplier),
    longCachedInputMultiplier: finitePositive(raw.long_context_input_cost_multiplier),
    longOutputMultiplier: finitePositive(raw.long_context_output_cost_multiplier),
  };
}

function resolveCatalogPrice(
  entries: Record<string, CatalogPrice>,
  model: string,
): CatalogPrice | null {
  const normalized = model.trim().toLowerCase();
  const lastSegment = normalized.split("/").at(-1) ?? normalized;
  return entries[normalized] ?? entries[lastSegment] ?? null;
}

function selectPrice(
  standard: number,
  tierSpecific: number | null,
  longMultiplier: number | null,
): number {
  const selected = tierSpecific ?? standard;
  return longMultiplier === null ? selected : selected * longMultiplier;
}

function perTokenUsdToMillionNanos(value: number): number | null {
  const converted = Math.round(value * 1_000_000_000_000_000);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
}

function multiplier(value: number | null, base: number): number | null {
  return value === null || base <= 0 ? null : value / base;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function safePositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/u.test(value)
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadCachedCatalog(path: string, logger: Logger): PersistedCatalog | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("价格缓存必须是普通文件");
    }
    if (stat.size > maximumCatalogBytes) {
      throw new Error("价格缓存超过大小限制");
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPersistedCatalog(parsed)) throw new Error("价格缓存格式无效");
    chmodSync(path, 0o600);
    return parsed;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      logger.warn({ err: error }, "模型价格缓存不可用，等待远程刷新");
    }
    return null;
  }
}

function isPersistedCatalog(value: unknown): value is PersistedCatalog {
  if (!isRecord(value) || value.version !== cacheVersion) return false;
  if (value.source !== "litellm" && value.source !== "sub2api-mirror") return false;
  if (value.etag !== null && typeof value.etag !== "string") return false;
  if (!Number.isSafeInteger(value.effectiveAtMs) || Number(value.effectiveAtMs) <= 0) {
    return false;
  }
  if (!isRecord(value.entries) || Object.keys(value.entries).length === 0) {
    return false;
  }
  return Object.values(value.entries).every(isCatalogPrice);
}

function isCatalogPrice(value: unknown): value is CatalogPrice {
  if (!isRecord(value)) return false;
  return [
    "input",
    "cachedInput",
    "output",
  ].every((key) => finiteNonNegative(value[key]) !== null)
    && [
      "priorityInput",
      "priorityCachedInput",
      "priorityOutput",
      "longInputMultiplier",
      "longCachedInputMultiplier",
      "longOutputMultiplier",
    ].every((key) => value[key] === null || finitePositive(value[key]) !== null)
    && (value.provider === null || safeIdentifier(value.provider) !== null)
    && (value.longContextThreshold === null
      || safePositiveInteger(value.longContextThreshold) !== null);
}

async function persistCatalog(path: string, catalog: PersistedCatalog): Promise<void> {
  await writePrivateFileAtomic(path, `${JSON.stringify(catalog)}\n`);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
