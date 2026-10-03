import type { ZodType } from "zod";

/** requests_per_minute=0 disables rate/burst checks; max_concurrency remains enforced. */
export interface ModelRelayLimitConfig { max_concurrency: number; requests_per_minute: number; burst: number }
export interface ModelRelayCallerConfig {
  caller_id: string; display_name?: string; key_id: string; credential_generation: number; secret_sha256: string;
  enabled: boolean; models: string[]; reasoning?: "passthrough" | "off";
}
export interface ModelRelayConfig extends ModelRelayLimitConfig {
  enabled: boolean; host: string; port: number;
  callers: ModelRelayCallerConfig[];
  retired_callers?: Array<Pick<ModelRelayCallerConfig, "caller_id" | "key_id" | "credential_generation"> & { provider: string }>;
}
export const modelRelayConfigSchema: ZodType<ModelRelayConfig>;
export function modelRelayConfigDigest(config: ModelRelayConfig): string;
export function relayPolicyFromConfig(config: ModelRelayConfig): {
  enabled: boolean; maxConcurrency: number; requestsPerMinute: number; burst: number;
  accounts: Array<{ provider: string }>;
  retiredCallers: Array<{ callerId: string; keyId: string; credentialGeneration: number }>;
  callers: Array<{ callerId: string; keyId: string; credentialGeneration: number; secretSha256: string;
    enabled: boolean; models: string[]; reasoning: "passthrough" | "off" }>;
};

export const relayDisplayNameSchema: ZodType<string>;


export const relayKeyModelsSchema: ZodType<string[]>;
