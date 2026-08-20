import { readFileSync } from "node:fs";

import { isOpencodeGoProvider } from "../../runtime/opencode-go-accounts.mjs";
import type {
  ModelPricingLookup,
  ModelPricingResolver,
  ModelRequestPricingSnapshot,
} from "../observability/index.js";
import {
  isMinuteInLocalRanges,
  localMinuteOf,
  type LocalMinuteRange,
} from "./pricing-bucket.js";

const baselineUrl = new URL(
  "../../runtime/opencode-go-pricing-baseline.json",
  import.meta.url,
);
const source = "https://opencode.ai/docs/go/";
const modelPattern = /^[a-z0-9][a-z0-9._-]{0,119}$/u;
const localRangePattern = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/u;
const allowedEndpointPaths = new Set([
  "/zen/go/v1/responses",
  "/zen/go/v1/chat/completions",
  "/zen/go/v1/messages",
]);
const allowedAiSdkPackages = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@ai-sdk/anthropic",
]);

interface PriceTier {
  maximumInputTokens: number | null;
  input: number;
  output: number;
  cachedRead: number;
}

interface PeakOffPeakPrice {
  offPeak: PriceTier;
  peak: PriceTier;
}

interface ModelPrice {
  endpoint: string;
  aiSdkPackage: string;
  tiers: readonly PriceTier[];
  peakOffPeak?: PeakOffPeakPrice;
  includedUsageUsd: number;
}

export interface OpenCodeGoPricingBaseline {
  sourceUpdatedAtMs: number;
  timezone: "UTC";
  peakRanges: readonly LocalMinuteRange[];
  models: ReadonlyMap<string, ModelPrice>;
}

export class OpenCodeGoModelPricingResolver implements ModelPricingResolver {
  private readonly baseline: OpenCodeGoPricingBaseline;

  constructor(baseline = loadOpenCodeGoPricingBaseline()) {
    this.baseline = baseline;
  }

  resolve(
    lookup: ModelPricingLookup,
    bucket?: "peak" | "off-peak",
  ): ModelRequestPricingSnapshot | null {
    if (!isOpencodeGoProvider(lookup.provider) || lookup.model === null) return null;
    const model = this.baseline.models.get(lookup.model);
    if (!model) return null;
    if (model.peakOffPeak) {
      const peak = bucket === undefined
        ? isOpenCodeGoPeakMinute(new Date(lookup.atMs), this.baseline)
        : bucket === "peak";
      const price = peak ? model.peakOffPeak.peak : model.peakOffPeak.offPeak;
      return {
        billingMode: "subscription",
        currency: "USD",
        source: "opencode-go-official",
        effectiveAtMs: this.baseline.sourceUpdatedAtMs,
        bucket: peak ? "peak" : "off-peak",
        uncachedInputPricePerMillionNanos: usdPerMillionToNanos(price.input),
        cachedInputPricePerMillionNanos: usdPerMillionToNanos(price.cachedRead),
        outputPricePerMillionNanos: usdPerMillionToNanos(price.output),
      };
    }
    const inputTokens = lookup.inputTokens;
    const tier = model.tiers.find(({ maximumInputTokens }) =>
      maximumInputTokens === null
      || (inputTokens !== null && inputTokens <= maximumInputTokens));
    if (!tier) return null;
    return {
      billingMode: "subscription",
      currency: "USD",
      source: "opencode-go-official",
      effectiveAtMs: this.baseline.sourceUpdatedAtMs,
      bucket: null,
      uncachedInputPricePerMillionNanos: usdPerMillionToNanos(tier.input),
      cachedInputPricePerMillionNanos: usdPerMillionToNanos(tier.cachedRead),
      outputPricePerMillionNanos: usdPerMillionToNanos(tier.output),
    };
  }
}

export function isOpenCodeGoPeakMinute(
  date: Date,
  baseline = loadOpenCodeGoPricingBaseline(),
): boolean {
  return isMinuteInLocalRanges(
    localMinuteOf(date, "UTC"),
    baseline.peakRanges,
  );
}

export function loadOpenCodeGoPricingBaseline(
  content = readFileSync(baselineUrl, "utf8"),
): OpenCodeGoPricingBaseline {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("OpenCode Go 官方价格基线不是有效 JSON");
  }
  if (!isRecord(value)
    || value.schemaVersion !== 2
    || value.source !== source
    || value.currency !== "USD"
    || value.unit !== "per_million_tokens"
    || value.timezone !== "UTC"
    || !Array.isArray(value.peakHours)
    || value.peakHours.length === 0
    || !value.peakHours.every(isValidLocalRange)
    || !isRecord(value.models)
    || Object.keys(value.models).length === 0) {
    throw new Error("OpenCode Go 官方价格基线格式无效");
  }
  const peakRanges = value.peakHours.map(parseLocalRange);
  const sourceUpdatedAtMs = Date.parse(String(value.sourceUpdatedAt));
  if (!Number.isFinite(sourceUpdatedAtMs)) {
    throw new Error("OpenCode Go 官方价格基线更新时间无效");
  }
  const models = new Map<string, ModelPrice>();
  for (const [model, candidate] of Object.entries(value.models)) {
    if (!modelPattern.test(model) || !isRecord(candidate)) {
      throw new Error("OpenCode Go 官方价格模型条目无效");
    }
    const endpoint = validatedEndpoint(candidate.endpoint);
    const aiSdkPackage = validatedAiSdkPackage(candidate.aiSdkPackage);
    const includedUsageUsd = positivePrice(candidate.includedUsageUsd);
    const tiers = Array.isArray(candidate.tiers)
      ? candidate.tiers.map(parseTier)
      : [];
    const peakOffPeak = candidate.peakOffPeak === undefined
      ? undefined
      : parsePeakOffPeak(candidate.peakOffPeak);
    if (tiers.length > 0 && peakOffPeak !== undefined) {
      throw new Error("OpenCode Go 官方价格档位与峰谷档位不能混用");
    }
    if (tiers.length > 0) {
      validateTiers(tiers);
    } else if (peakOffPeak !== undefined) {
      validatePeakOffPeak(peakOffPeak);
    } else {
      tiers.push(parseTier({ ...candidate, maximumInputTokens: null }));
    }
    models.set(model, {
      endpoint,
      aiSdkPackage,
      tiers,
      ...(peakOffPeak === undefined ? {} : { peakOffPeak }),
      includedUsageUsd,
    });
  }
  return { sourceUpdatedAtMs, timezone: "UTC", peakRanges, models };
}

function parseTier(value: unknown): PriceTier {
  if (!isRecord(value)) throw new Error("OpenCode Go 官方价格档位无效");
  const maximumInputTokens = value.maximumInputTokens;
  if (maximumInputTokens !== null
    && (!Number.isSafeInteger(maximumInputTokens) || Number(maximumInputTokens) <= 0)) {
    throw new Error("OpenCode Go 官方价格档位阈值无效");
  }
  return {
    maximumInputTokens: maximumInputTokens === null ? null : Number(maximumInputTokens),
    input: positivePrice(value.input),
    output: positivePrice(value.output),
    cachedRead: positivePrice(value.cachedRead),
  };
}

function validateTiers(tiers: readonly PriceTier[]): void {
  if (tiers.length === 0 || tiers.length > 10 || tiers.at(-1)?.maximumInputTokens !== null) {
    throw new Error("OpenCode Go 官方价格档位未完整覆盖输入范围");
  }
  let previous = 0;
  for (const tier of tiers) {
    if (tier.maximumInputTokens !== null) {
      if (tier.maximumInputTokens <= previous) {
        throw new Error("OpenCode Go 官方价格档位顺序无效");
      }
      previous = tier.maximumInputTokens;
    }
  }
}

function parsePeakOffPeak(value: unknown): PeakOffPeakPrice {
  if (!isRecord(value) || !isRecord(value.offPeak) || !isRecord(value.peak)) {
    throw new Error("OpenCode Go 官方价格峰谷档位无效");
  }
  return {
    offPeak: parseTier({ ...value.offPeak, maximumInputTokens: null }),
    peak: parseTier({ ...value.peak, maximumInputTokens: null }),
  };
}

function validatePeakOffPeak(price: PeakOffPeakPrice): void {
  if (
    price.offPeak.maximumInputTokens !== null
    || price.peak.maximumInputTokens !== null
  ) {
    throw new Error("OpenCode Go 官方价格峰谷档位无效");
  }
}

function parseLocalRange(value: string): LocalMinuteRange {
  const match = localRangePattern.exec(value);
  if (!match) throw new Error("OpenCode Go 官方价格 Peak 时段无效");
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  return {
    start: startHour * 60 + startMinute,
    end: endHour * 60 + endMinute,
  };
}

function isValidLocalRange(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = localRangePattern.exec(value);
  if (!match) return false;
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    return false;
  }
  return startHour * 60 + startMinute < endHour * 60 + endMinute;
}

function positivePrice(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("OpenCode Go 官方模型价格无效");
  }
  return value;
}

function validatedEndpoint(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("OpenCode Go 官方模型端点无效");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("OpenCode Go 官方模型端点无效");
  }
  if (endpoint.protocol !== "https:"
    || endpoint.origin !== "https://opencode.ai"
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== ""
    || !allowedEndpointPaths.has(endpoint.pathname)) {
    throw new Error("OpenCode Go 官方模型端点无效");
  }
  return endpoint.href;
}

function validatedAiSdkPackage(value: unknown): string {
  if (typeof value !== "string" || !allowedAiSdkPackages.has(value)) {
    throw new Error("OpenCode Go 官方 AI SDK Package 无效");
  }
  return value;
}

function usdPerMillionToNanos(value: number): number {
  const nanos = Math.round(value * 1_000_000_000);
  if (!Number.isSafeInteger(nanos)) throw new Error("OpenCode Go 官方模型价格超出范围");
  return nanos;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
