import type { SamplingParameters } from "./model-catalog.mjs";
import type { ClinePassRequestProfile } from "./chat-reasoning.mjs";

export class ProviderModelGuard {
  constructor(path: string, isModelValid: (model: unknown) => boolean, options?: {
    parseCatalog?: (content: string) => unknown;
    blockedPaths?: readonly string[];
  });
  isEnabled(model: string, signal?: AbortSignal): Promise<boolean>;
  modelCapabilities(model: string, signal?: AbortSignal): Promise<{ reasoningEfforts: string[]; sampling?: SamplingParameters; clineRequestProfile?: ClinePassRequestProfile; clineProviderOptions?: import("./cline-provider-options.mjs").ClineProviderOptions } | undefined>;
  close(): Promise<void>;
}
