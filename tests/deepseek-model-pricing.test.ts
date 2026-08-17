import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  DeepseekModelPricingResolver,
  loadDeepseekPricingBaseline,
  parseDeepseekPricingBaseline,
  ProviderModelPricingResolver,
} from "../src/bootstrap/deepseek-model-pricing.js";

const exchangeRate = {
  usdToCny: 2,
  effectiveAtMs: 1_700_000_000_000,
  source: "open-er-api" as const,
};

describe("DeepseekModelPricingResolver", () => {
  it("loads the reviewed official CNY baseline", () => {
    const baseline = loadDeepseekPricingBaseline();

    expect(baseline).toMatchObject({
      source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
      timezone: "Asia/Shanghai",
    });
    expect(baseline.plans).toHaveLength(2);
  });

  it("uses the fixed price before the scheduled effective time", () => {
    const resolver = new DeepseekModelPricingResolver({
      exchangeRate: () => exchangeRate,
    });

    expect(resolveAt(resolver, "2026-08-16T23:59:59+08:00", "deepseek-v4-flash"))
      .toEqual({
        billingMode: "api",
        currency: "USD",
        source: "deepseek-official:open-er-api",
        effectiveAtMs: Date.parse("2026-08-13T10:49:16.000Z"),
        bucket: null,
        cachedInputPricePerMillionNanos: 10_000_000,
        uncachedInputPricePerMillionNanos: 500_000_000,
        outputPricePerMillionNanos: 1_000_000_000,
      });
  });

  it("selects Beijing peak intervals as half-open request-start windows", () => {
    const resolver = new DeepseekModelPricingResolver({
      exchangeRate: () => exchangeRate,
    });
    const cases = [
      ["2026-08-17T08:59:59+08:00", 2_250_000_000],
      ["2026-08-17T09:00:00+08:00", 4_500_000_000],
      ["2026-08-17T11:59:59+08:00", 4_500_000_000],
      ["2026-08-17T12:00:00+08:00", 2_250_000_000],
      ["2026-08-17T14:00:00+08:00", 4_500_000_000],
      ["2026-08-17T18:00:00+08:00", 2_250_000_000],
    ] as const;

    for (const [at, expectedOutput] of cases) {
      expect(resolveAt(resolver, at, "deepseek-v4-flash"))
        .toMatchObject({
          effectiveAtMs: Date.parse("2026-08-17T00:00:00+08:00"),
          outputPricePerMillionNanos: expectedOutput,
          bucket: at === "2026-08-17T08:59:59+08:00"
            || at === "2026-08-17T12:00:00+08:00"
            || at === "2026-08-17T18:00:00+08:00"
            ? "off-peak"
            : "peak",
        });
    }
  });

  it("uses the Pro prices and fails closed without FX or an exact model", () => {
    const resolver = new DeepseekModelPricingResolver({
      exchangeRate: () => exchangeRate,
    });
    expect(resolveAt(resolver, "2026-08-17T09:00:00+08:00", "deepseek-v4-pro"))
      .toMatchObject({
        cachedInputPricePerMillionNanos: 150_000_000,
        uncachedInputPricePerMillionNanos: 4_500_000_000,
        outputPricePerMillionNanos: 13_500_000_000,
      });
    expect(resolveAt(resolver, "2026-08-17T09:00:00+08:00", "deepseek-v4-unknown"))
      .toBeNull();
    expect(new DeepseekModelPricingResolver({ exchangeRate: () => null }).resolve({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      serviceTier: null,
      inputTokens: 1,
      atMs: Date.parse("2026-08-17T09:00:00+08:00"),
    })).toBeNull();
  });

  it("rejects baseline gaps, overlaps and divergent model sets", () => {
    const parsed = JSON.parse(readFileSync(
      new URL("../runtime/deepseek-pricing-baseline.json", import.meta.url),
      "utf8",
    ));
    parsed.plans[1].effectiveFrom = "2026-08-17T00:01:00+08:00";
    expect(() => parseDeepseekPricingBaseline(parsed))
      .toThrow("价格计划存在空档或重叠");

    parsed.plans[1].effectiveFrom = "2026-08-17T00:00:00+08:00";
    delete parsed.plans[1].windows[0].models["deepseek-v4-pro"];
    expect(() => parseDeepseekPricingBaseline(parsed))
      .toThrow("同一计划的模型集合不一致");
  });

  it("does not fall back to a generic catalog for DeepSeek", () => {
    const deepseek = { resolve: vi.fn(() => null) };
    const fallback = { resolve: vi.fn(() => ({
      billingMode: "unknown" as const,
      currency: "USD",
      source: "fallback",
      effectiveAtMs: 1,
      cachedInputPricePerMillionNanos: 1,
      uncachedInputPricePerMillionNanos: 1,
      outputPricePerMillionNanos: 1,
    })) };
    const resolver = new ProviderModelPricingResolver(
      fallback,
      new Map([["deepseek", deepseek]]),
    );
    const lookup = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1,
      atMs: 1,
    };

    expect(resolver.resolve(lookup)).toBeNull();
    expect(deepseek.resolve).toHaveBeenCalledWith(lookup);
    expect(fallback.resolve).not.toHaveBeenCalled();

    resolver.resolve({ ...lookup, provider: "openai" });
    expect(fallback.resolve).toHaveBeenCalledOnce();
  });
});

function resolveAt(
  resolver: DeepseekModelPricingResolver,
  at: string,
  model: string,
) {
  return resolver.resolve({
    provider: "deepseek",
    model,
    serviceTier: null,
    inputTokens: 1,
    atMs: Date.parse(at),
  });
}
