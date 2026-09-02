import { describe, expect, it } from "vitest";

import {
  OpenCodeGoModelPricingResolver,
  loadOpenCodeGoPricingBaseline,
} from "../src/bootstrap/opencode-go-model-pricing.js";

describe("OpenCodeGoModelPricingResolver", () => {
  it("tracks limited-free models without creating a numeric price", () => {
    const baseline = loadOpenCodeGoPricingBaseline(JSON.stringify({
      schemaVersion: 3,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-21T14:49:25.000Z",
      currency: "USD",
      unit: "per_million_tokens",
      timezone: "UTC",
      peakHours: ["01:00-04:00", "06:00-10:00"],
      models: {
        "ox-alpha-free": {
          endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
          aiSdkPackage: "@ai-sdk/openai-compatible",
          pricingStatus: "limited-free",
        },
      },
    }));

    expect(baseline.limitedFreeModels.has("ox-alpha-free")).toBe(true);
    expect(baseline.models.has("ox-alpha-free")).toBe(false);
    expect(new OpenCodeGoModelPricingResolver(baseline).resolve({
      provider: "ocg-main",
      model: "ox-alpha-free",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: Date.parse("2026-08-21T15:00:00.000Z"),
    })).toBeNull();
  });

  it("rejects numeric prices on a limited-free model", () => {
    expect(() => loadOpenCodeGoPricingBaseline(JSON.stringify({
      schemaVersion: 3,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-21T14:49:25.000Z",
      currency: "USD",
      unit: "per_million_tokens",
      timezone: "UTC",
      peakHours: ["01:00-04:00", "06:00-10:00"],
      models: {
        "ox-alpha-free": {
          endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
          aiSdkPackage: "@ai-sdk/openai-compatible",
          pricingStatus: "limited-free",
          input: 0,
        },
      },
    }))).toThrow("限时免费模型条目无效");
  });

  it("uses OpenCode Go prices independently from the DeepSeek provider", () => {
    const resolver = new OpenCodeGoModelPricingResolver();

    expect(resolver.resolve({
      provider: "ocg-main",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: Date.parse("2026-08-16T05:00:00.000Z"),
    })).toMatchObject({
      billingMode: "subscription",
      currency: "USD",
      source: "opencode-go-official",
      bucket: "off-peak",
      uncachedInputPricePerMillionNanos: 220_000_000,
      cachedInputPricePerMillionNanos: 7_000_000,
      outputPricePerMillionNanos: 660_000_000,
    });
    expect(resolver.resolve({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: Date.parse("2026-08-16T05:00:00.000Z"),
    })).toBeNull();
  });

  it("applies OpenCode Go prices to account-scoped providers", () => {
    const resolver = new OpenCodeGoModelPricingResolver();

    expect(resolver.resolve({
      provider: "ocg-lunare",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: Date.parse("2026-08-16T05:00:00.000Z"),
    })).toMatchObject({
      billingMode: "subscription",
      currency: "USD",
      source: "opencode-go-official",
      bucket: "off-peak",
    });
    expect(resolver.resolve({
      provider: "deepseek-extra",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: Date.parse("2026-08-16T05:00:00.000Z"),
    })).toBeNull();
  });

  it("selects the Peak price inside official Peak hours", () => {
    const resolver = new OpenCodeGoModelPricingResolver();

    expect(resolver.resolve({
      provider: "ocg-main",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: Date.parse("2026-08-16T02:00:00.000Z"),
    })).toMatchObject({
      bucket: "peak",
      uncachedInputPricePerMillionNanos: 440_000_000,
      cachedInputPricePerMillionNanos: 14_000_000,
      outputPricePerMillionNanos: 1_320_000_000,
    });
  });

  it("prices the OpenCode Go Vision model with its own included usage", () => {
    const resolver = new OpenCodeGoModelPricingResolver();
    const baseline = loadOpenCodeGoPricingBaseline();

    expect(baseline.models.get("deepseek-v4-flash-vision-exp")?.includedUsageUsd)
      .toBe(15);
    expect(resolver.resolve({
      provider: "ocg-main",
      model: "deepseek-v4-flash-vision-exp",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: Date.parse("2026-08-21T02:00:00.000Z"),
    })).toMatchObject({
      bucket: "peak",
      uncachedInputPricePerMillionNanos: 440_000_000,
      cachedInputPricePerMillionNanos: 14_000_000,
      outputPricePerMillionNanos: 1_320_000_000,
    });
  });

  it("selects the matching long-context price tier", () => {
    const resolver = new OpenCodeGoModelPricingResolver();

    expect(resolver.resolve({
      provider: "ocg-main",
      model: "qwen3.7-plus",
      serviceTier: null,
      inputTokens: 300_000,
      atMs: Date.now(),
    })).toMatchObject({
      uncachedInputPricePerMillionNanos: 1_200_000_000,
      outputPricePerMillionNanos: 4_800_000_000,
    });
  });

  it("rejects an incomplete tiered baseline", () => {
    expect(() => loadOpenCodeGoPricingBaseline(JSON.stringify({
      schemaVersion: 3,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-14T05:48:32.000Z",
      currency: "USD",
      unit: "per_million_tokens",
      timezone: "UTC",
      peakHours: ["01:00-04:00", "06:00-10:00"],
      models: {
        "test-model": {
          endpoint: "https://opencode.ai/zen/go/v1/responses",
          aiSdkPackage: "@ai-sdk/openai",
          tiers: [{
            maximumInputTokens: 100_000,
            input: 1,
            output: 2,
            cachedRead: 0.1,
          }],
          includedUsageUsd: 10,
        },
      },
    }))).toThrow("未完整覆盖输入范围");
  });

  it("rejects an incomplete Peak/Off-Peak baseline", () => {
    expect(() => loadOpenCodeGoPricingBaseline(JSON.stringify({
      schemaVersion: 3,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-14T05:48:32.000Z",
      currency: "USD",
      unit: "per_million_tokens",
      timezone: "UTC",
      peakHours: ["01:00-04:00", "06:00-10:00"],
      models: {
        "test-model": {
          endpoint: "https://opencode.ai/zen/go/v1/responses",
          aiSdkPackage: "@ai-sdk/openai",
          peakOffPeak: {
            offPeak: {
              input: 1,
              output: 2,
              cachedRead: 0.1,
              cachedWrite: null,
            },
          },
          includedUsageUsd: 10,
        },
      },
    }))).toThrow("峰谷档位无效");
  });

  it("rejects a baseline without official Peak hours", () => {
    expect(() => loadOpenCodeGoPricingBaseline(JSON.stringify({
      schemaVersion: 3,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-14T05:48:32.000Z",
      currency: "USD",
      unit: "per_million_tokens",
      timezone: "UTC",
      peakHours: [],
      models: {
        "test-model": {
          endpoint: "https://opencode.ai/zen/go/v1/responses",
          aiSdkPackage: "@ai-sdk/openai",
          input: 1,
          output: 2,
          cachedRead: 0.1,
          cachedWrite: null,
          includedUsageUsd: 10,
        },
      },
    }))).toThrow("官方价格基线格式无效");
  });

  it("rejects a model endpoint outside the official API boundary", () => {
    const baseline = {
      schemaVersion: 3,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-14T05:48:32.000Z",
      currency: "USD",
      unit: "per_million_tokens",
      timezone: "UTC",
      peakHours: ["01:00-04:00", "06:00-10:00"],
      models: {
        "test-model": {
          endpoint: "https://example.test/zen/go/v1/responses",
          aiSdkPackage: "@ai-sdk/openai",
          input: 1,
          output: 2,
          cachedRead: 0.1,
          cachedWrite: null,
          includedUsageUsd: 10,
        },
      },
    };

    expect(() => loadOpenCodeGoPricingBaseline(JSON.stringify(baseline)))
      .toThrow("模型端点无效");
  });
});
