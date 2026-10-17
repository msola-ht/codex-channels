import type { CustomPrimaryProviderSetupPrompts } from "./custom-primary-provider-setup.mjs";
import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs";
import type { probeCustomModelCapabilities } from "./custom-model-capability-probe.mjs";

export function promptCustomModelCapabilities(prompts: CustomPrimaryProviderSetupPrompts, input: {
  baseUrl: string; apiKey: string; upstreamWireApi: "responses" | "chat_completions";
  models: ResponsesModelDefinition[]; environment?: NodeJS.ProcessEnv;
}, options?: { output?: { write(value: string): unknown }; probe?: typeof probeCustomModelCapabilities; optionalProbe?: boolean }): Promise<{ models: ResponsesModelDefinition[]; probeConnections: Array<{ model: string; capability: "applyPatch" | "toolSearch"; token: string }> } | undefined>;
