import type { ZodType } from "zod";

/** requests_per_minute=0 disables rate/burst checks; max_concurrency remains enforced. */
export interface ModelRelayLimitConfig { max_concurrency: number; requests_per_minute: number; burst: number }
export interface ModelRelayCallerConfig {
  caller_id: string; key_id: string; credential_generation: number; secret_sha256: string;
  enabled: boolean; provider: string; models: string[];
}
export interface ModelRelayConfig extends ModelRelayLimitConfig {
  enabled: boolean; host: "127.0.0.1" | "::1"; port: number;
  accounts: Array<{ provider: string }>;
  callers: ModelRelayCallerConfig[];
}
export const modelRelayConfigSchema: ZodType<ModelRelayConfig>;
export function modelRelayConfigDigest(config: ModelRelayConfig): string;
export function relayPolicyFromConfig(config: ModelRelayConfig): {
  enabled: boolean; maxConcurrency: number; requestsPerMinute: number; burst: number;
  accounts: Array<{ provider: string }>;
  callers: Array<{ callerId: string; keyId: string; credentialGeneration: number; secretSha256: string;
    enabled: boolean; provider: string; models: string[] }>;
};

export function upgradeModelRelayLimits(value: unknown): ModelRelayConfig;
export function removeLegacyRelayCapture(value: unknown): Record<string, unknown>;
