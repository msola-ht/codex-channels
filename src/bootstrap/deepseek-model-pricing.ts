import { readFileSync } from "node:fs";

import type { ExchangeRateSnapshot } from "../application/index.js";
import type {
  ModelPricingLookup,
  ModelPricingResolver,
  ModelRequestPricingSnapshot,
} from "../observability/index.js";

const baselineUrl = new URL(
  "../../runtime/deepseek-pricing-baseline.json",
  import.meta.url,
);
const modelPattern = /^deepseek-[a-z0-9][a-z0-9._-]{0,119}$/u;
const localRangePattern = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/u;

interface DeepseekPrice {
  cachedInput: number;
  uncachedInput: number;
  output: number;
}

interface DeepseekPricingWindow {
  kind: "all_day" | "off_peak" | "peak";
  localRanges: readonly LocalMinuteRange[];
  models: ReadonlyMap<string, DeepseekPrice>;
}

interface DeepseekPricingPlan {
  effectiveFromMs: number | null;
  effectiveUntilMs: number | null;
  windows: readonly DeepseekPricingWindow[];
}

export interface DeepseekPricingBaseline {
  source: string;
  sourceUpdatedAtMs: number;
  timezone: string;
  plans: readonly DeepseekPricingPlan[];
}

interface LocalMinuteRange {
  start: number;
  end: number;
}

export interface DeepseekModelPricingResolverOptions {
  exchangeRate: () => ExchangeRateSnapshot | null;
  baseline?: DeepseekPricingBaseline;
}

export class DeepseekModelPricingResolver implements ModelPricingResolver {
  private readonly formatter: Intl.DateTimeFormat;
  private readonly baseline: DeepseekPricingBaseline;

  constructor(private readonly options: DeepseekModelPricingResolverOptions) {
    this.baseline = options.baseline ?? loadDeepseekPricingBaseline();
    this.formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: this.baseline.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  }

  resolve(lookup: ModelPricingLookup): ModelRequestPricingSnapshot | null {
    if (lookup.provider !== "deepseek" || lookup.model === null) return null;
    const plan = this.baseline.plans.find((candidate) =>
      (candidate.effectiveFromMs === null || lookup.atMs >= candidate.effectiveFromMs)
      && (candidate.effectiveUntilMs === null || lookup.atMs < candidate.effectiveUntilMs));
    if (!plan) return null;
    const localMinute = this.localMinute(lookup.atMs);
    const peak = plan.windows.find((window) =>
      window.kind === "peak"
      && window.localRanges.some(({ start, end }) =>
        localMinute >= start && localMinute < end));
    const window = peak
      ?? plan.windows.find((candidate) => candidate.kind === "all_day")
      ?? plan.windows.find((candidate) => candidate.kind === "off_peak");
    const price = window?.models.get(lookup.model);
    if (!price) return null;
    const exchangeRate = this.options.exchangeRate();
    if (!exchangeRate) return null;
    const cachedInputPricePerMillionNanos = cnyToUsdNanos(
      price.cachedInput,
      exchangeRate.usdToCny,
    );
    const uncachedInputPricePerMillionNanos = cnyToUsdNanos(
      price.uncachedInput,
      exchangeRate.usdToCny,
    );
    const outputPricePerMillionNanos = cnyToUsdNanos(
      price.output,
      exchangeRate.usdToCny,
    );
    if (
      cachedInputPricePerMillionNanos === null
      || uncachedInputPricePerMillionNanos === null
      || outputPricePerMillionNanos === null
    ) {
      return null;
    }
    return {
      billingMode: "api",
      currency: "USD",
      source: `deepseek-official:${exchangeRate.source}`,
      effectiveAtMs: plan.effectiveFromMs ?? this.baseline.sourceUpdatedAtMs,
      cachedInputPricePerMillionNanos,
      uncachedInputPricePerMillionNanos,
      outputPricePerMillionNanos,
    };
  }

  private localMinute(atMs: number): number {
    const parts = this.formatter.formatToParts(new Date(atMs));
    const hour = Number(parts.find(({ type }) => type === "hour")?.value);
    const minute = Number(parts.find(({ type }) => type === "minute")?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      throw new Error("DeepSeek 价格时区无法转换");
    }
    return hour * 60 + minute;
  }
}

export class ProviderModelPricingResolver implements ModelPricingResolver {
  constructor(
    private readonly fallback: ModelPricingResolver,
    private readonly providerResolvers: ReadonlyMap<string, ModelPricingResolver>,
  ) {}

  resolve(lookup: ModelPricingLookup): ModelRequestPricingSnapshot | null {
    return (this.providerResolvers.get(lookup.provider) ?? this.fallback).resolve(lookup);
  }
}

export function loadDeepseekPricingBaseline(
  content = readFileSync(baselineUrl, "utf8"),
): DeepseekPricingBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek 官方价格基线不是有效 JSON");
  }
  return parseDeepseekPricingBaseline(parsed);
}

export function parseDeepseekPricingBaseline(value: unknown): DeepseekPricingBaseline {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.source !== "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"
    || value.currency !== "CNY"
    || value.unit !== "per_million_tokens"
    || value.timezone !== "Asia/Shanghai"
    || !Array.isArray(value.plans)
    || value.plans.length === 0
    || value.plans.length > 20) {
    throw new Error("DeepSeek 官方价格基线格式无效");
  }
  const sourceUpdatedAtMs = parseIsoTimestamp(value.sourceUpdatedAt, "来源更新时间");
  const plans = value.plans.map((candidate, index) => parsePlan(candidate, index));
  if (plans[0]?.effectiveFromMs !== null || plans.at(-1)?.effectiveUntilMs !== null) {
    throw new Error("DeepSeek 价格计划必须覆盖完整时间范围");
  }
  for (let index = 1; index < plans.length; index += 1) {
    if (plans[index - 1]?.effectiveUntilMs !== plans[index]?.effectiveFromMs) {
      throw new Error("DeepSeek 价格计划存在空档或重叠");
    }
  }
  const expectedModels = modelSet(plans[0]);
  for (const plan of plans) {
    const models = modelSet(plan);
    if (models.size !== expectedModels.size
      || [...expectedModels].some((model) => !models.has(model))) {
      throw new Error("DeepSeek 价格计划的模型集合不一致");
    }
  }
  return {
    source: value.source,
    sourceUpdatedAtMs,
    timezone: value.timezone,
    plans,
  };
}

function parsePlan(value: unknown, index: number): DeepseekPricingPlan {
  if (!isRecord(value) || !Array.isArray(value.windows) || value.windows.length === 0) {
    throw new Error(`DeepSeek 第 ${index + 1} 个价格计划无效`);
  }
  const effectiveFromMs = value.effectiveFrom === null
    ? null
    : parseIsoTimestamp(value.effectiveFrom, "价格生效时间");
  const effectiveUntilMs = value.effectiveUntil === null
    ? null
    : parseIsoTimestamp(value.effectiveUntil, "价格失效时间");
  if (effectiveFromMs !== null
    && effectiveUntilMs !== null
    && effectiveFromMs >= effectiveUntilMs) {
    throw new Error("DeepSeek 价格计划时间范围无效");
  }
  const windows = value.windows.map(parseWindow);
  const kinds = new Set(windows.map(({ kind }) => kind));
  if (kinds.size !== windows.length) throw new Error("DeepSeek 价格时段重复");
  const validAllDay = windows.length === 1 && kinds.has("all_day");
  const validPeak = windows.length === 2
    && kinds.has("off_peak")
    && kinds.has("peak");
  if (!validAllDay && !validPeak) throw new Error("DeepSeek 价格时段组合无效");
  if (validPeak) {
    const offPeak = windows.find(({ kind }) => kind === "off_peak")!;
    const peak = windows.find(({ kind }) => kind === "peak")!;
    if (offPeak.localRanges.length !== 0 || peak.localRanges.length === 0) {
      throw new Error("DeepSeek 峰谷价格时段无效");
    }
  }
  const expectedModels = windows[0]!.models;
  for (const window of windows.slice(1)) {
    if (window.models.size !== expectedModels.size
      || [...expectedModels.keys()].some((model) => !window.models.has(model))) {
      throw new Error("DeepSeek 同一计划的模型集合不一致");
    }
  }
  return { effectiveFromMs, effectiveUntilMs, windows };
}

function parseWindow(value: unknown): DeepseekPricingWindow {
  if (!isRecord(value)
    || (value.kind !== "all_day" && value.kind !== "off_peak" && value.kind !== "peak")
    || !Array.isArray(value.localRanges)
    || !isRecord(value.models)
    || Object.keys(value.models).length === 0) {
    throw new Error("DeepSeek 价格时段无效");
  }
  const localRanges = value.localRanges.map(parseLocalRange)
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index - 1]!.end > localRanges[index]!.start) {
      throw new Error("DeepSeek 本地价格时段重叠");
    }
  }
  const models = new Map<string, DeepseekPrice>();
  for (const [model, candidate] of Object.entries(value.models)) {
    if (!modelPattern.test(model) || models.has(model) || !isRecord(candidate)) {
      throw new Error("DeepSeek 价格模型条目无效");
    }
    models.set(model, {
      cachedInput: price(candidate.cachedInput, model),
      uncachedInput: price(candidate.uncachedInput, model),
      output: price(candidate.output, model),
    });
  }
  return { kind: value.kind, localRanges, models };
}

function parseLocalRange(value: unknown): LocalMinuteRange {
  if (typeof value !== "string") throw new Error("DeepSeek 本地价格时段无效");
  const match = localRangePattern.exec(value);
  if (!match) throw new Error("DeepSeek 本地价格时段无效");
  const start = timeToMinute(match[1]!, match[2]!);
  const end = timeToMinute(match[3]!, match[4]!);
  if (start >= end) throw new Error("DeepSeek 本地价格时段无效");
  return { start, end };
}

function timeToMinute(hourText: string, minuteText: string): number {
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59 || (hour === 24 && minute !== 0)) {
    throw new Error("DeepSeek 本地价格时段无效");
  }
  return hour * 60 + minute;
}

function price(value: unknown, model: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new Error(`DeepSeek 模型价格无效：${model}`);
  }
  return value;
}

function parseIsoTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error(`DeepSeek ${label}无效`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error(`DeepSeek ${label}无效`);
  }
  return timestamp;
}

function modelSet(plan: DeepseekPricingPlan): ReadonlySet<string> {
  return new Set(plan.windows[0]!.models.keys());
}

function cnyToUsdNanos(cny: number, usdToCny: number): number | null {
  if (!Number.isFinite(usdToCny) || usdToCny <= 0) return null;
  const converted = Math.round(cny / usdToCny * 1_000_000_000);
  return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
