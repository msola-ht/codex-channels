import { describe, expect, it } from "vitest";

import {
  OpenCodeGoModelPricingResolver,
  loadOpenCodeGoPricingBaseline,
} from "../src/bootstrap/opencode-go-model-pricing.js";

describe("OpenCodeGoModelPricingResolver", () => {
  it("uses OpenCode Go prices independently from the DeepSeek provider", () => {
    const resolver = new OpenCodeGoModelPricingResolver();

    expect(resolver.resolve({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: Date.now(),
    })).toMatchObject({
      billingMode: "subscription",
      currency: "USD",
      source: "opencode-go-official",
      uncachedInputPricePerMillionNanos: 140_000_000,
      cachedInputPricePerMillionNanos: 2_800_000,
      outputPricePerMillionNanos: 280_000_000,
    });
    expect(resolver.resolve({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: Date.now(),
    })).toBeNull();
  });

  it("selects the matching long-context price tier", () => {
    const resolver = new OpenCodeGoModelPricingResolver();

    expect(resolver.resolve({
      provider: "opencode-go",
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
      schemaVersion: 1,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-14T05:48:32.000Z",
      currency: "USD",
      unit: "per_million_tokens",
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

  it("rejects a model endpoint outside the official API boundary", () => {
    const baseline = {
      schemaVersion: 1,
      source: "https://opencode.ai/docs/go/",
      sourceUpdatedAt: "2026-08-14T05:48:32.000Z",
      currency: "USD",
      unit: "per_million_tokens",
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
