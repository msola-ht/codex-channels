import { readFileSync } from "node:fs";

import type {
  ModelPricingLookup,
  ModelPricingResolver,
  ModelRequestPricingSnapshot,
} from "../observability/index.js";

const baselineUrl = new URL(
  "../../runtime/opencode-go-pricing-baseline.json",
  import.meta.url,
);
const source = "https://opencode.ai/docs/go/";
const modelPattern = /^[a-z0-9][a-z0-9._-]{0,119}$/u;
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

interface ModelPrice {
  endpoint: string;
  aiSdkPackage: string;
  tiers: readonly PriceTier[];
  includedUsageUsd: number;
}

export interface OpenCodeGoPricingBaseline {
  sourceUpdatedAtMs: number;
  models: ReadonlyMap<string, ModelPrice>;
}

export class OpenCodeGoModelPricingResolver implements ModelPricingResolver {
  private readonly baseline: OpenCodeGoPricingBaseline;

  constructor(baseline = loadOpenCodeGoPricingBaseline()) {
    this.baseline = baseline;
  }

  resolve(lookup: ModelPricingLookup): ModelRequestPricingSnapshot | null {
    if (lookup.provider !== "opencode-go" || lookup.model === null) return null;
    const model = this.baseline.models.get(lookup.model);
    if (!model) return null;
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
      uncachedInputPricePerMillionNanos: usdPerMillionToNanos(tier.input),
      cachedInputPricePerMillionNanos: usdPerMillionToNanos(tier.cachedRead),
      outputPricePerMillionNanos: usdPerMillionToNanos(tier.output),
    };
  }
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
    || value.schemaVersion !== 1
    || value.source !== source
    || value.currency !== "USD"
    || value.unit !== "per_million_tokens"
    || !isRecord(value.models)
    || Object.keys(value.models).length === 0) {
    throw new Error("OpenCode Go 官方价格基线格式无效");
  }
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
      : [parseTier({ ...candidate, maximumInputTokens: null })];
    validateTiers(tiers);
    models.set(model, { endpoint, aiSdkPackage, tiers, includedUsageUsd });
  }
  return { sourceUpdatedAtMs, models };
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
