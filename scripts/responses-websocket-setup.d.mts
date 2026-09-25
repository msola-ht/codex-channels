import type { CustomPrimaryProviderSetupPrompts } from "./custom-primary-provider-setup.mjs";
import type { ResponsesWebSocketProbeInput, probeResponsesWebSocket } from "./responses-websocket-probe.mjs";
export function promptResponsesWebSocket(prompts: CustomPrimaryProviderSetupPrompts, input: Omit<ResponsesWebSocketProbeInput,"mode"|"signal">, options?: { output?: {write(value:string):unknown}; probe?: typeof probeResponsesWebSocket; current?: boolean }): Promise<boolean|undefined>;
