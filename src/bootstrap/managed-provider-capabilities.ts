import {
  assertManagedModelProviderCapabilities,
  type ModelProviderDefinition,
} from "../../runtime/model-provider-definitions.mjs";

import type {
  ProviderAccountAdapter,
} from "../application/index.js";
import { createDeepseekAccountAdapter } from "./deepseek-account-adapter.js";
import { createOpencodeGoAccountAdapter } from "./opencode-go-account-adapter.js";

export interface ManagedProviderAccountFactoryOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  metricsDatabasePath: string;
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
