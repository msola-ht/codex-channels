import type { ZodType } from "zod";

export interface ModelRelayLimitConfig { max_concurrency: number; requests_per_minute: number; burst: number }
export interface ModelRelayCallerConfig extends ModelRelayLimitConfig {
  caller_id: string; key_id: string; credential_generation: number; secret_sha256: string;
  enabled: boolean; provider: string; models: string[];
}
export interface ModelRelayConfig extends ModelRelayLimitConfig {
  enabled: boolean; host: "127.0.0.1" | "::1"; port: number;
  accounts: Array<ModelRelayLimitConfig & { provider: string }>;
  callers: ModelRelayCallerConfig[];
}
export const modelRelayConfigSchema: ZodType<ModelRelayConfig>;
export function modelRelayConfigDigest(config: ModelRelayConfig): string;
export function relayPolicyFromConfig(config: ModelRelayConfig): {
  enabled: boolean; maxConcurrency: number; requestsPerMinute: number; burst: number;
  accounts: Array<{ provider: string; maxConcurrency: number; requestsPerMinute: number; burst: number }>;
  callers: Array<{ callerId: string; keyId: string; credentialGeneration: number; secretSha256: string;
    enabled: boolean; provider: string; models: string[]; maxConcurrency: number; requestsPerMinute: number; burst: number }>;
};
