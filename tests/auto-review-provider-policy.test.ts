import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadAutoReviewProviderPolicy, resolveAutoReviewProviderPolicy } from "../runtime/auto-review-provider-policy.mjs";
import { configuredHome, testEnvironment } from "./model-provider-runtime-test-fixture.js";

describe("Auto-review Provider policy", () => {
  it.each(["exclusive", "switching"] as const)("classifies the configured %s managed Provider without credentials as an eligibility signal", async (mode) => {
    const home = await configuredHome(mode);
    try {
      const policy = loadAutoReviewProviderPolicy(testEnvironment(home));
      expect(policy.primarySupported).toBe(mode === "switching");
      expect(policy.supportedProviders.has("openai")).toBe(mode === "switching");
      expect(policy.supportedProviders.has("ds-test")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("allows official OpenAI and fixed custom Providers using the official catalog", () => {
    const official = resolveAutoReviewProviderPolicy({
      primaryProvider: "openai", customSwitchingProviders: [],
    });
    expect(official.primarySupported).toBe(true);
    expect([...official.supportedProviders]).toEqual(["openai"]);
    const custom = resolveAutoReviewProviderPolicy({
      primaryProvider: "openai",
      customPrimaryProvider: { id: "compatible" },
      customSwitchingProviders: [],
    });
    expect(custom.primarySupported).toBe(true);
    expect([...custom.supportedProviders]).toEqual(["openai", "compatible"]);
  });

  it("does not let a fixed custom catalog inherit the primary OpenAI routing alias", () => {
    const policy = resolveAutoReviewProviderPolicy({
      primaryProvider: "openai",
      customPrimaryProvider: { id: "rs-example", catalogPath: "/fixture/models.json" },
      customSwitchingProviders: [],
    });
    expect(policy.primarySupported).toBe(false);
    expect(policy.supportedProviders.size).toBe(0);
  });

  it("allows only official catalog switching Providers alongside an unsupported primary", () => {
    const policy = resolveAutoReviewProviderPolicy({
      primaryProvider: "ds-example",
      customSwitchingProviders: [
        { provider: "compatible", catalogSource: { kind: "official" } },
        { provider: "rs-example", catalogSource: { kind: "custom", path: "/fixture/models.json" } },
      ],
    });
    expect(policy.primarySupported).toBe(false);
    expect([...policy.supportedProviders]).toEqual(["compatible"]);
    expect(policy.supportedProviders.has("unknown")).toBe(false);
  });
});
