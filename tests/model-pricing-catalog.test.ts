import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { RemoteModelPricingCatalog } from "../src/bootstrap/model-pricing-catalog.js";

describe("RemoteModelPricingCatalog", () => {
  it("refreshes prices and resolves cached, priority and long-context rates", async () => {
    const cachePath = join(temporaryDirectory(), "model-pricing.json");
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(String(input)).toContain("BerriAI/litellm");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({
        "gpt-test": {
          input_cost_per_token: 2e-6,
          input_cost_per_token_priority: 4e-6,
          input_cost_per_token_above_272k_tokens: 4e-6,
          cache_read_input_token_cost: 2e-7,
          cache_read_input_token_cost_priority: 4e-7,
          cache_read_input_token_cost_above_272k_tokens: 4e-7,
          output_cost_per_token: 12e-6,
          output_cost_per_token_priority: 24e-6,
          output_cost_per_token_above_272k_tokens: 18e-6,
          litellm_provider: "openai",
        },
      }), {
        status: 200,
        headers: { etag: "catalog-v1" },
      });
    });
    const catalog = new RemoteModelPricingCatalog({
      cachePath,
      fetchImpl,
      logger: pino({ level: "silent" }),
      now: () => 1_700_000_000_000,
    });

    await catalog.refresh();

    expect(catalog.resolve({
      provider: "openai",
      model: "gpt-test",
      serviceTier: "priority",
      inputTokens: 300_000,
      atMs: 1_700_000_000_100,
    })).toEqual({
      billingMode: "subscription",
      currency: "USD",
      source: "litellm",
      effectiveAtMs: 1_700_000_000_000,
      uncachedInputPricePerMillionNanos: 8_000_000_000,
      cachedInputPricePerMillionNanos: 800_000_000,
      outputPricePerMillionNanos: 36_000_000_000,
    });
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({
      version: 1,
      source: "litellm",
      etag: "catalog-v1",
    });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 304 }));
    await catalog.refresh();
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual({
      "if-none-match": "catalog-v1",
    });
    await catalog.close();
  });

  it("loads the last valid cache and falls back to the Sub2API mirror", async () => {
    const directory = temporaryDirectory();
    const cachePath = join(directory, "model-pricing.json");
    const sourceCalls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      sourceCalls.push(url);
      if (url.includes("BerriAI")) throw new Error("primary unavailable");
      return new Response(JSON.stringify({
        "deepseek-v4-flash": {
          input_cost_per_token: 1.4e-7,
          input_cost_per_token_cache_hit: 2.8e-9,
          output_cost_per_token: 2.8e-7,
          litellm_provider: "deepseek",
        },
      }), { status: 200 });
    });
    const first = new RemoteModelPricingCatalog({
      cachePath,
      fetchImpl,
      logger: pino({ level: "silent" }),
      now: () => 1_700_000_000_000,
    });
    await first.refresh();
    await first.close();

    const reloaded = new RemoteModelPricingCatalog({
      cachePath,
      fetchImpl: vi.fn(),
      logger: pino({ level: "silent" }),
    });
    expect(sourceCalls).toHaveLength(2);
    expect(reloaded.resolve({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1_000,
      atMs: 1_700_000_000_100,
    })).toMatchObject({
      billingMode: "api",
      source: "sub2api-mirror",
      uncachedInputPricePerMillionNanos: 140_000_000,
      cachedInputPricePerMillionNanos: 2_800_000,
      outputPricePerMillionNanos: 280_000_000,
    });
    await reloaded.close();
  });
});

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "codexc-model-pricing-"));
}
