import type { CustomPrimaryProviderSetupPrompts } from "./custom-primary-provider-setup.mjs";
import type { ResponsesToolSearchProbeInput, probeResponsesToolSearch } from "./responses-tool-search-probe.mjs";
export function promptResponsesToolSearch(prompts: CustomPrimaryProviderSetupPrompts, input: Omit<ResponsesToolSearchProbeInput,"signal">, options?: { output?: {write(value:string):unknown}; probe?: typeof probeResponsesToolSearch; current?: boolean }): Promise<boolean|undefined>;
