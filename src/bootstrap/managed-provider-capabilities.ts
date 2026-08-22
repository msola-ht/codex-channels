import {
  assertManagedModelProviderCapabilities,
  type ModelProviderDefinition,
} from "../../runtime/model-provider-definitions.mjs";

import type {
  ExchangeRateSnapshot,
  ProviderAccountAdapter,
} from "../application/index.js";
import type {
  ModelPricingResolver,
} from "../observability/index.js";
import {
  DeepseekModelPricingResolver,
} from "./deepseek-model-pricing.js";
import { createDeepseekAccountAdapter } from "./deepseek-account-adapter.js";
import {
  OpenCodeGoModelPricingResolver,
} from "./opencode-go-model-pricing.js";
import { createOpencodeGoAccountAdapter } from "./opencode-go-account-adapter.js";

export interface ManagedProviderPricingFactoryOptions {
  exchangeRate: () => ExchangeRateSnapshot | null;
}

export interface ManagedProviderAccountFactoryOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  metricsDatabasePath: string;
}

/**
 * Builds the specialized pricing registry from the fixed capability kinds.
 * Provider IDs remain an explicit allow-list so an unconfigured or unknown
 * provider cannot silently receive a specialized resolver.
 */
export function createManagedProviderPricingResolvers(
  definitions: readonly ModelProviderDefinition[],
  options: ManagedProviderPricingFactoryOptions,
): ReadonlyMap<string, ModelPricingResolver> {
  const groups = groupDefinitionsByCapability(definitions, "pricingAdapter");
  const resolvers = new Map<string, ModelPricingResolver>();
  for (const group of groups.values()) {
    const adapter = assertManagedModelProviderCapabilities(group[0]!)["pricingAdapter"];
    const providerIds = new Set<string>(group.map(({ id }) => id));
    const providerMatcher = (provider: string): boolean => providerIds.has(provider);
    let resolver: ModelPricingResolver | undefined;
    switch (adapter) {
      case "none":
        resolver = { resolve: () => null };
        break;
      case "remote":
        break;
      case "deepseek":
        resolver = new DeepseekModelPricingResolver({
          exchangeRate: options.exchangeRate,
          providerMatcher,
        });
        break;
      case "opencode-go":
        resolver = new OpenCodeGoModelPricingResolver(undefined, providerMatcher);
        break;
      default:
        throw new Error(`未知受管 Provider 计价适配器：${String(adapter)}`);
    }
    if (!resolver) continue;
    for (const definition of group) {
      if (resolvers.has(definition.id)) {
        throw new Error(`受管 Provider 计价适配器冲突：${definition.id}`);
      }
      resolvers.set(definition.id, resolver);
    }
  }
  return resolvers;
}

export function createManagedProviderAccountAdapters(
  definitions: readonly ModelProviderDefinition[],
  options: ManagedProviderAccountFactoryOptions,
): ProviderAccountAdapter[] {
  const adapters: ProviderAccountAdapter[] = [];
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const definition of definitions) {
    const capabilities = assertManagedModelProviderCapabilities(definition);
    switch (capabilities.accountAdapter) {
      case "none":
        break;
      case "deepseek":
        adapters.push(createDeepseekAccountAdapter({
          environment,
          fetchImpl,
          provider: definition.id,
        }));
        break;
      case "opencode-go":
        adapters.push(createOpencodeGoAccountAdapter({
          environment,
          fetchImpl,
          metricsDatabasePath: options.metricsDatabasePath,
          provider: definition.id,
        }));
        break;
      default:
        throw new Error(
          `未知受管 Provider 账户适配器：${String(capabilities.accountAdapter)}`,
        );
    }
  }
  return adapters;
}

export function managedProviderNeedsExchangeRate(
  definitions: readonly ModelProviderDefinition[],
  activeProviders: ReadonlySet<string>,
): boolean {
  return definitions.some((definition) => {
    const capabilities = assertManagedModelProviderCapabilities(definition);
    return capabilities.needsExchangeRate && activeProviders.has(definition.id);
  });
}

function groupDefinitionsByCapability(
  definitions: readonly ModelProviderDefinition[],
  key: "pricingAdapter",
): Map<string, ModelProviderDefinition[]> {
  const groups = new Map<string, ModelProviderDefinition[]>();
  for (const definition of definitions) {
    const capabilities = assertManagedModelProviderCapabilities(definition);
    const adapter = capabilities[key];
    const group = groups.get(adapter) ?? [];
    group.push(definition);
    groups.set(adapter, group);
  }
  return groups;
}
