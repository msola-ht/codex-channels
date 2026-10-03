export type RelayReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RelayModelCapability { id: string; reasoning_efforts: RelayReasoningEffort[] }
export function supportsChatReasoningOff(provider: string, model: string): boolean;
