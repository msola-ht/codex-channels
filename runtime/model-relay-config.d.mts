import type { RelayExtraModel } from "./chat-reasoning.mjs";
export type { RelayExtraModel, RelayReasoningEffort } from "./chat-reasoning.mjs";
import type { ZodType } from "zod";

/** requests_per_minute=0 disables rate/burst checks; max_concurrency remains enforced. */
export interface ModelRelayLimitConfig { max_concurrency: number; requests_per_minute: number; burst: number }
export interface ModelRelayCallerConfig {
  caller_id: string; display_name?: string; key_id: string; credential_generation: number; secret_sha256: string;
  enabled: boolean; provider: string; reasoning?: "passthrough" | "off";
}
export const relayExtraModelSchema: ZodType<RelayExtraModel>;
export const relayExtraModelsSchema: ZodType<RelayExtraModel[]>;
export interface ModelRelayConfig extends ModelRelayLimitConfig {
  enabled: boolean; host: string; port: number;
  accounts: Array<{ provider: string; models: string[]; extra_models?: RelayExtraModel[] }>;
  callers: ModelRelayCallerConfig[];
  retired_callers?: Array<Pick<ModelRelayCallerConfig, "caller_id" | "key_id" | "provider" | "credential_generation">>;
}
export const modelRelayConfigSchema: ZodType<ModelRelayConfig>;
export function modelRelayConfigDigest(config: ModelRelayConfig): string;
export function relayPolicyFromConfig(config: ModelRelayConfig): {
  enabled: boolean; maxConcurrency: number; requestsPerMinute: number; burst: number;
  accounts: Array<{ provider: string }>;
  retiredCallers: Array<{ callerId: string; keyId: string; credentialGeneration: number }>;
  callers: Array<{ callerId: string; keyId: string; credentialGeneration: number; secretSha256: string;
    enabled: boolean; provider: string; models: string[]; reasoning: "passthrough" | "off" }>;
};

export function upgradeModelRelayLimits(value: unknown): ModelRelayConfig;
export function removeLegacyRelayCapture(value: unknown): Record<string, unknown>;
export const relayDisplayNameSchema: ZodType<string>;

export function upgradeModelRelayModels(value: unknown): ModelRelayConfig;
