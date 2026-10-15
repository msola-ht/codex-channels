export type RelayReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const relayModelReasoningModes: readonly ["passthrough", "off", "minimal", "low", "medium", "high", "xhigh", "max", "off-reasoning-effort", "off-reasoning-enabled", "off-reasoning-effort-field", "off-thinking", "off-enable-thinking"];
export type RelayModelReasoning = typeof relayModelReasoningModes[number];
export interface RelayModelCapability { id: string; reasoning_efforts: RelayReasoningEffort[] }
export function supportsChatReasoningOff(provider: string, model: string): boolean;
