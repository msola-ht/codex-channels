import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertManagedModelProviderCapabilities,
  deepseekProviderDefinition,
  expandManagedModelProviderDefinitions,
  loadManagedModelProviderWatcherDefinitions,
  managedModelProviderDefinitions,
  opencodeGoAccountDefinition,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import { writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
import {
  createManagedProviderAccountAdapters,
  createManagedProviderPricingResolvers,
  managedProviderNeedsExchangeRate,
} from "../src/bootstrap/managed-provider-capabilities.js";

describe("managed Provider capability registry", () => {
  it("uses one canonical Profile name for CLI selection and the profile file", () => {
    for (const definition of [
      ...managedModelProviderDefinitions,
      opencodeGoAccountDefinition("lunare"),
    ]) {
      expect(definition.profileName).toMatch(/^sf-/u);
      expect(definition.profileFileName).toBe(`${definition.profileName}.config.toml`);
    }
  });

  it("fails closed when a future Provider Profile file diverges from its canonical name", () => {
    const futureProvider = {
      ...deepseekProviderDefinition,
      id: "future-provider",
      profileName: "sf-future-provider",
      profileFileName: "sf-other.config.toml",
    } as unknown as typeof deepseekProviderDefinition;
    expect(() => expandManagedModelProviderDefinitions([futureProvider], process.env))
      .toThrow("受管 Provider Profile 定义无效：future-provider");
  });

  it("declares the reviewed capability kinds and preserves them for Go accounts", () => {
    expect(deepseekProviderDefinition.capabilities).toEqual({
      catalogSource: "deepseek-official",
      pricingAdapter: "deepseek",
      accountAdapter: "deepseek",
      instanceAdapter: "single",
      catalogUpdateAdapter: "deepseek",
      needsExchangeRate: true,
    });
    expect(opencodeGoAccountDefinition("lunare").capabilities)
      .toBe(opencodeGoProviderDefinition.capabilities);
  });

  it("expands every single-instance base definition into the runtime registry", () => {
    const futureProvider = {
      ...deepseekProviderDefinition,
      id: "future-provider",
      capabilities: {
        ...deepseekProviderDefinition.capabilities,
        instanceAdapter: "single",
      },
    } as unknown as typeof deepseekProviderDefinition;

    expect(expandManagedModelProviderDefinitions(
      [deepseekProviderDefinition, futureProvider],
      process.env,
    ).map(({ id }) => id)).toEqual(["deepseek", "future-provider"]);
  });

  it("supports a managed Provider without pricing, account, or catalog update adapters", () => {
    const futureProvider = {
      ...deepseekProviderDefinition,
      id: "future-provider",
      capabilities: {
        ...deepseekProviderDefinition.capabilities,
        catalogSource: "none",
        pricingAdapter: "none",
        accountAdapter: "none",
        catalogUpdateAdapter: "none",
      },
    } as unknown as typeof deepseekProviderDefinition;

    expect(assertManagedModelProviderCapabilities(futureProvider)).toMatchObject({
      catalogSource: "none",
      pricingAdapter: "none",
      accountAdapter: "none",
      catalogUpdateAdapter: "none",
    });
    const pricing = createManagedProviderPricingResolvers([futureProvider], {
      exchangeRate: () => null,
    });
    expect(pricing.get("future-provider")?.resolve({
      provider: "future-provider",
      model: "future-model",
      serviceTier: null,
      inputTokens: 1,
      atMs: 1,
    })).toBeNull();
    expect(createManagedProviderAccountAdapters([futureProvider], {
      metricsDatabasePath: join(tmpdir(), "codexc-future-provider.sqlite3"),
    })).toEqual([]);
  });

  it("keeps the shared Go definition and configured account definitions in one watcher set", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-provider-definitions-"));
    try {
      const environment = {
        ...process.env,
        CODEX_HOME: home,
        CODEX_CONNECT_HOME: join(home, ".codex-connect"),
      };
      expect(loadManagedModelProviderWatcherDefinitions(environment).map(({ id }) => id))
        .toEqual(["deepseek", "opencode-go"]);

      writeOpencodeGoAccounts(environment, [
        { id: "opencode-go", default: true },
        { id: "lunare", default: false },
      ]);
      expect(loadManagedModelProviderWatcherDefinitions(environment).map(({ id }) => id))
        .toEqual(["deepseek", "opencode-go", "opencode-go", "opencode-go-lunare"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("selects pricing and account adapters by capability without merging provider keys", () => {
    const definitions = [
      deepseekProviderDefinition,
      opencodeGoAccountDefinition("lunare"),
    ];
    const pricing = createManagedProviderPricingResolvers(definitions, {
      exchangeRate: () => ({
        usdToCny: 2,
        effectiveAtMs: 1_700_000_000_000,
        source: "cache",
      }),
    });
    expect([...pricing.keys()]).toEqual(["deepseek", "opencode-go-lunare"]);
    expect(pricing.get("deepseek")?.resolve({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1,
      atMs: Date.parse("2026-08-21T09:00:00.000Z"),
    })).not.toBeNull();
    expect(pricing.get("opencode-go-lunare")?.resolve({
      provider: "opencode-go-lunare",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1,
      atMs: Date.parse("2026-08-21T09:00:00.000Z"),
    })).not.toBeNull();
    expect(pricing.get("opencode-go-lunare")?.resolve({
      provider: "opencode-go-unknown",
      model: "deepseek-v4-flash",
      serviceTier: null,
      inputTokens: 1,
      atMs: Date.parse("2026-08-21T09:00:00.000Z"),
    })).toBeNull();

    const accounts = createManagedProviderAccountAdapters(definitions, {
      environment: process.env,
      fetchImpl: fetch,
      metricsDatabasePath: join(tmpdir(), "codexc-provider-capabilities.sqlite3"),
    });
    expect(accounts.map(({ provider }) => provider)).toEqual([
      "deepseek",
      "opencode-go-lunare",
    ]);
    expect(managedProviderNeedsExchangeRate(definitions, new Set(["deepseek"]))).toBe(true);
    expect(managedProviderNeedsExchangeRate(definitions, new Set(["opencode-go-lunare"])))
      .toBe(false);
  });

  it("fails closed for unknown capability kinds", () => {
    const invalid = {
      ...deepseekProviderDefinition,
      capabilities: {
        ...deepseekProviderDefinition.capabilities,
        pricingAdapter: "unknown",
      },
    } as unknown as typeof deepseekProviderDefinition;
    expect(() => assertManagedModelProviderCapabilities(invalid))
      .toThrow("受管 Provider 能力定义无效");
    expect(() => createManagedProviderPricingResolvers([invalid], {
      exchangeRate: () => null,
    })).toThrow("受管 Provider 能力定义无效");
  });
});
