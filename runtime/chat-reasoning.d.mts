export type RelayReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface RelayExtraModel { id: string; reasoning_efforts: RelayReasoningEffort[]; reasoning: "passthrough" | RelayReasoningEffort }
export function supportsChatReasoningOff(provider: string, model: string): boolean;
