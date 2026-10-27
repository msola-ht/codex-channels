import { isOllamaCloudAccountProvider } from "../../runtime/ollama-cloud-accounts.mjs";
import { createHash } from "node:crypto";
import { loadConfiguredProviderCredential } from "../../runtime/model-provider-runtime.mjs";
import type { ManagedModelProviderId } from "../../runtime/model-provider-definitions.mjs";
import type { ProviderAccountAdapter, ProviderAccountUsage, CloudUsageReport, CloudUsageMetrics, CloudUsageQuery } from "../application/index.js";
import { AccountQuery, AccountQueryError } from "./account-query.js";
import { OllamaAccountCache, type OllamaAccountRateLimit } from "./ollama-account-cache.js";

const unitsPerDollar = 1_000_000_000n;
const maximumUnits = 999_999_999_999n * unitsPerDollar + unitsPerDollar - 1n;
// Public rates share a daily process cache across accounts using the same transport.
const exchangeCaches = new WeakMap<typeof fetch, OllamaAccountCache<NonNullable<CloudUsageReport["usdCny"]>>>();

function exchangeRate(fetchImpl: typeof fetch, signal: AbortSignal, beforeSubmit?: () => void) {
  let cache = exchangeCaches.get(fetchImpl);
  if (!cache) { cache = new OllamaAccountCache(undefined, 86_400_000); exchangeCaches.set(fetchImpl, cache); }
  return cache.read(async (sharedSignal, assertCurrent) => {
    const query = new AccountQuery("汇率", sharedSignal, assertCurrent, 3_000);
    return query.run(async () => {
      const { body } = await query.json(fetchImpl, "https://api.frankfurter.dev/v2/rate/USD/CNY", null, "exchange-rate", { maximumBytes: 4_096 });
      const value = record(body);
      const day = typeof value.date === "string" ? Date.parse(value.date) : NaN;
      if (value.base !== "USD" || value.quote !== "CNY" || typeof value.rate !== "number"
        || !Number.isFinite(value.rate) || value.rate <= 0 || value.rate > 100
        || typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value.date)
        || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.date
        || day > Date.now() || Date.now() - day > 7 * 86_400_000) throw new Error("汇率响应无效或过期");
      return { rate: value.rate, date: value.date };
    });
  }, false, signal, beforeSubmit).then(cached => {
    // Source age changes even while the locally cached observation is valid.
    const day = Date.parse(cached.value.date);
    if (day > Date.now() || Date.now() - day > 7 * 86_400_000) throw new Error("汇率来源已过期");
    return cached;
  });
}

// A private wrapper distinguishes numeric JSON tokens from upstream strings/objects.
class UsdAmount {
  constructor(readonly units: bigint) {}
}

export function createOllamaCloudAccountAdapter(options: {
  provider: ManagedModelProviderId;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): ProviderAccountAdapter {
  if (!isOllamaCloudAccountProvider(options.provider)) throw new Error("Ollama Cloud 账户身份无效");
  const balanceCache = new OllamaAccountCache<{ usage: Extract<ProviderAccountUsage, { kind: "balance" }>; allowanceUsd: string | null }>();
  const planCache = new OllamaAccountCache<string | null>();
  const usageCaches = new Map<CloudUsageQuery["range"], OllamaAccountCache<Pick<CloudUsageReport, "from" | "until" | "totals" | "groups" | "remainder">>>();
  const usageRateLimit: OllamaAccountRateLimit = { retryAt: 0 };
  const reports = new Map<CloudUsageQuery["range"], CloudUsageReport>();
  let identity = "";
  let authenticationFailure: { error: AccountQueryError; until: number } | undefined;
  const invalidateAuthentication = (error: unknown): void => {
    if (!(error instanceof AccountQueryError) || error.diagnostic.reason !== "authentication") return;
    if (authenticationFailure?.error === error) return;
    authenticationFailure = { error, until: Date.now() + 30_000 };
    balanceCache.clear();
    planCache.clear();
    reports.clear();
    for (const cache of usageCaches.values()) cache.clear();
  };
  const credential = (): string => {
    const key = loadConfiguredProviderCredential(options.provider, options.environment ?? process.env).apiKey;
    const current = createHash("sha256").update(key).digest("hex");
    if (identity !== current) {
      balanceCache.clear();
      planCache.clear();
      for (const cache of usageCaches.values()) cache.clear();
      usageCaches.clear();
      reports.clear();
      usageRateLimit.retryAt = 0;
      delete usageRateLimit.failure;
      authenticationFailure = undefined;
      identity = current;
    }
    return key;
  };
  const balance = (key: string, refresh: boolean, signal?: AbortSignal, beforeSubmit?: () => void) => balanceCache.read(async (sharedSignal, assertCurrent) => {
    const query = new AccountQuery("Ollama Cloud", sharedSignal, assertCurrent);
    return query.run(async () => {
      const { body } = await query.json(options.fetchImpl ?? fetch, "https://ollama.com/api/balance", key, "balance", { parseJson: parseBalanceJson });
      const allowance = record(record(body).included).allowance_usd;
      return { usage: balanceUsage(body, options.provider), allowanceUsd: allowance instanceof UsdAmount ? decimal(allowance.units) : null };
    });
  }, refresh, signal, beforeSubmit);
  return {
    provider: options.provider,
    async accountUsage(signal, beforeSubmit) {
      const query = new AccountQuery("Ollama Cloud", signal, beforeSubmit);
      let key: string | undefined;
      return query.run(async () => {
        key = credential();
        if (authenticationFailure && Date.now() < authenticationFailure.until) throw authenticationFailure.error;
        const { body } = await query.json(options.fetchImpl ?? fetch, "https://ollama.com/api/balance", key, "balance", { parseJson: parseBalanceJson });
        if (credential() !== key) throw new Error("Ollama 账户凭据已变化");
        return balanceUsage(body, options.provider);
      }).catch(error => {
        if (key && createHash("sha256").update(key).digest("hex") === identity) invalidateAuthentication(error);
        throw error;
      });
    },
    async cloudUsage(selection, signal, beforeSubmit) {
      const query = new AccountQuery("Ollama Cloud", signal, beforeSubmit);
      return query.run(async () => {
        if (!["24h", "7d", "30d"].includes(selection.range)) throw new Error("不支持的用量范围");
        if (selection.cacheOnly && selection.refresh) throw new Error("缓存读取不能强制刷新");
        const key = credential();
        if (authenticationFailure && Date.now() < authenticationFailure.until) throw authenticationFailure.error;
        if (selection.cacheOnly) {
          const previous = reports.get(selection.range);
          if (!previous || Date.now() - previous.observedAtMs >= 300_000) return undefined;
          const age = (observed: number | null) => observed === null ? Infinity : Date.now() - observed;
          // Balance, plan and FX are account-wide: a 7d/30d channel refresh must
          // also update the 24h WebUI card without re-querying upstream usage.
          const currentBalance = balanceCache.peek();
          const currentPlan = planCache.peek();
          const exchange = exchangeCaches.get(options.fetchImpl ?? fetch)?.peek(86_400_000);
          const exchangeDay = exchange ? Date.parse(exchange.value.date) : NaN;
          return { ...previous, query: selection,
            stale: previous.stale || age(previous.observedAtMs) >= 30_000,
            balanceUsd: currentBalance?.value.usage.balances[0]?.totalBalance ?? null,
            allowanceUsd: currentBalance?.value.allowanceUsd ?? null,
            includedBalanceUsd: currentBalance?.value.usage.balances[0]?.grantedBalance ?? null,
            purchasedBalanceUsd: currentBalance?.value.usage.balances[0]?.toppedUpBalance ?? null,
            balanceObservedAtMs: currentBalance?.observedAtMs ?? null,
            balanceStale: currentBalance?.stale ?? true,
            plan: currentPlan?.value ?? null,
            planObservedAtMs: currentPlan?.observedAtMs ?? null,
            planStale: currentPlan?.stale ?? true,
            usdCny: exchange && !exchange.stale && exchangeDay <= Date.now()
              && Date.now() - exchangeDay <= 7 * 86_400_000 ? exchange.value : null };
        }
        let cache = usageCaches.get(selection.range);
        if (!cache) { cache = new OllamaAccountCache(usageRateLimit); usageCaches.set(selection.range, cache); }
        const usage = cache.read(async (sharedSignal, assertCurrent) => {
          const request = new AccountQuery("Ollama Cloud", sharedSignal, assertCurrent);
          return request.run(async () => {
            const { body } = await request.json(options.fetchImpl ?? fetch,
              `https://ollama.com/api/usage?range=${selection.range}&scope=self&group_by=model`, key, "usage", {
                parseJson: parseBalanceJson, maximumBytes: 262_144,
              });
            return usageReport(body, selection.range);
          });
        }, selection.refresh === true, query.signal, beforeSubmit);
        const plan = planCache.read(async (sharedSignal, assertCurrent) => {
          // Optional account metadata must not consume the entire report deadline.
          const request = new AccountQuery("Ollama Cloud", sharedSignal, assertCurrent, 3_000);
          return request.run(async () => {
            const { body } = await request.json(options.fetchImpl ?? fetch, "https://ollama.com/api/me", key, "plan", { method: "POST" });
            return accountPlan(body);
          });
        }, selection.refresh === true, query.signal, beforeSubmit);
        const [usageResult, balanceResult, planResult, exchangeResult] = await Promise.allSettled([
          usage, balance(key, selection.refresh === true, query.signal, beforeSubmit), plan,
          exchangeRate(options.fetchImpl ?? fetch, query.signal, beforeSubmit),
        ]);
        query.assertCurrent();
        if (credential() !== key) throw new Error("Ollama 账户凭据已变化");
        if (authenticationFailure && Date.now() < authenticationFailure.until) throw authenticationFailure.error;
        for (const result of [usageResult, balanceResult, planResult]) {
          if (result.status === "rejected" && result.reason instanceof AccountQueryError && result.reason.diagnostic.reason === "authentication") {
            invalidateAuthentication(result.reason);
            throw result.reason;
          }
        }
        if (usageResult.status === "rejected") throw usageResult.reason;
        const currentBalance = balanceResult.status === "fulfilled" ? balanceResult.value : undefined;
        const currentPlan = planResult.status === "fulfilled" ? planResult.value : undefined;
        const report: CloudUsageReport = { kind: "cloud-usage", provider: options.provider, query: selection,
          ...usageResult.value.value, observedAtMs: usageResult.value.observedAtMs, stale: usageResult.value.stale,
          balanceUsd: currentBalance?.value.usage.balances[0]?.totalBalance ?? null,
          allowanceUsd: currentBalance?.value.allowanceUsd ?? null,
          includedBalanceUsd: currentBalance?.value.usage.balances[0]?.grantedBalance ?? null,
          purchasedBalanceUsd: currentBalance?.value.usage.balances[0]?.toppedUpBalance ?? null,
          plan: currentPlan?.value ?? null, planObservedAtMs: currentPlan?.observedAtMs ?? null, planStale: currentPlan?.stale ?? false,
          usdCny: exchangeResult.status === "fulfilled" ? exchangeResult.value.value : null,
          balanceObservedAtMs: currentBalance?.observedAtMs ?? null, balanceStale: currentBalance?.stale ?? false };
        reports.set(selection.range, report);
        return report;
      });
    },
  };
}

function accountPlan(value: unknown): string | null {
  const body = record(value);
  // Cloud currently returns Plan; the official client's JSON contract uses plan.
  // Accept these two observed spellings only, and reject contradictory values.
  if (body.Plan !== undefined && body.plan !== undefined && body.Plan !== body.plan) throw new Error("Ollama 套餐字段不一致");
  const plan = body.Plan ?? body.plan;
  if (plan == null || plan === "") return null;
  if (typeof plan !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9 -]{0,63}$/u.test(plan)) throw new Error("Ollama 套餐字段无效");
  return plan;
}

function parseBalanceJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }): unknown => {
    if (key !== "balance_usd" && key !== "usage_usd" && key !== "allowance_usd") return value;
    if ((key === "usage_usd" || key === "allowance_usd") && value === null) return value;
    // Use the source token, never the already rounded IEEE-754 value.
    if (typeof value !== "number" || typeof context?.source !== "string" || context.source.length > 64) {
      throw new Error("Ollama 余额金额缺少精确数字表示");
    }
    const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(context.source);
    if (!match) throw new Error("Ollama 余额金额必须是非负数");
    const exponent = Number(match[3] ?? "0");
    const fraction = match[2] ?? "";
    const scale = fraction.length - exponent;
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30 || scale > 9) throw new Error("Ollama 余额金额精度不受支持");
    const units = BigInt(`${match[1]}${fraction}`) * 10n ** BigInt(9 - scale);
    if (units > maximumUnits) throw new Error("Ollama 余额金额超出范围");
    return new UsdAmount(units);
  }) as unknown;
}

function balanceUsage(value: unknown, provider: string): Extract<ProviderAccountUsage, { kind: "balance" }> {
  const body = record(value);
  const included = record(body.included).balance_usd;
  const purchased = record(body.purchased).balance_usd;
  // Legacy session/weekly plans have no USD included balance; never invent zero.
  if (!(included instanceof UsdAmount) || !(purchased instanceof UsdAmount)) throw new Error("Ollama 余额响应缺少 USD 金额");
  const total = included.units + purchased.units;
  if (total > maximumUnits) throw new Error("Ollama 余额合计超出范围");
  return { kind: "balance", provider, available: true, balances: [{
    currency: "USD", totalBalance: decimal(total),
    grantedBalance: decimal(included.units), toppedUpBalance: decimal(purchased.units),
  }] };
}

function decimal(units: bigint): string {
  const fraction = (units % unitsPerDollar).toString().padStart(9, "0").replace(/0+$/u, "");
  return `${units / unitsPerDollar}${fraction ? `.${fraction}` : ""}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ollama 余额响应结构无效");
  return value as Record<string, unknown>;
}

function usageReport(value: unknown, range: CloudUsageQuery["range"]): Pick<CloudUsageReport, "from" | "until" | "totals" | "groups" | "remainder"> {
  const body = record(value);
  if (body.range !== range || body.scope !== "self" || body.group_by !== "model"
    || body.granularity !== (range === "24h" ? "hour" : "day")
    || typeof body.from !== "string" || typeof body.until !== "string"
    || !Number.isFinite(Date.parse(body.from)) || !Number.isFinite(Date.parse(body.until))
    || Date.parse(body.from) >= Date.parse(body.until)) throw new Error("Ollama 用量范围无效");
  const totals = record(body.totals);
  if (!Array.isArray(totals.groups) || totals.groups.length > 10) throw new Error("Ollama 模型分组无效");
  const seen = new Set<string>();
  const groups = totals.groups.map(value => {
    const group = record(value);
    if (typeof group.model !== "string" || !group.model || group.model.length > 128 || /[\s\p{Cc}\p{Cf}]/u.test(group.model)
      || seen.has(group.model)) throw new Error("Ollama 模型标识无效");
    seen.add(group.model);
    return { ...usageMetrics(group), model: group.model };
  });
  const remainder = totals.remainder == null ? null : usageMetrics(record(totals.remainder));
  const totalMetrics = usageMetrics(totals);
  const parts = [...groups, ...(remainder ? [remainder] : [])];
  if (parts.reduce((sum, item) => sum + BigInt(item.requestCount), 0n) !== BigInt(totalMetrics.requestCount)) throw new Error("Ollama 用量分组请求数不一致");
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const) {
    if (totalMetrics[key] !== null && parts.every(item => item[key] !== null)
      && parts.reduce((sum, item) => sum + BigInt(item[key]!), 0n) !== BigInt(totalMetrics[key])) throw new Error("Ollama 用量分组计数不一致");
  }
  return { from: body.from, until: body.until, totals: totalMetrics, groups, remainder };
}

function usageMetrics(value: Record<string, unknown>): CloudUsageMetrics {
  const count = (key: string, required = false): number | null => {
    const field = value[key];
    if (field == null && !required) return null;
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new Error("Ollama 用量计数无效");
    return field;
  };
  const inputTokens = count("input_tokens");
  const cachedInputTokens = count("cached_input_tokens");
  if (inputTokens !== null && cachedInputTokens !== null && cachedInputTokens > inputTokens) throw new Error("Ollama 缓存计数超过输入");
  if (value.usage_usd != null && !(value.usage_usd instanceof UsdAmount)) throw new Error("Ollama 用量金额无效");
  return { requestCount: count("request_count", true)!, inputTokens, cachedInputTokens,
    outputTokens: count("output_tokens"), usageUsd: value.usage_usd instanceof UsdAmount ? decimal(value.usage_usd.units) : null };
}
