import type { RelayReasoningEffort } from "./chat-reasoning.mjs";
export interface ClineRelayModel {
  id: string; name?: string; contextWindow?: number; maxTokens?: number; capabilities?: string[];
  modalities?: { input: string[]; output: string[] };
  reasoningOptions?: Array<{ type: "toggle" } | { type: "effort"; values: (RelayReasoningEffort | "default" | null)[] } | { type: "budget_tokens"; min?: number; max?: number }>;
}
export interface ClineRelayCatalog { version: 1; commit: string; downloadedAt: number; models: ClineRelayModel[] }
export type ClineRelayCatalogSnapshot = { status: "ready"; catalog: ClineRelayCatalog; efforts: Record<string, RelayReasoningEffort[]>; revision: string } | { status: "missing" | "invalid" };
export function clineRelayCatalogPath(environment: NodeJS.ProcessEnv): string;
export function readClineRelayCatalog(environment?: NodeJS.ProcessEnv): ClineRelayCatalogSnapshot;
export function clineRelayReasoningEfforts(model: ClineRelayModel): RelayReasoningEffort[];
export function clinePassReasoningEfforts(model: ClineRelayModel): Array<RelayReasoningEffort | "enabled">;
export function clineRelayInputModalities(model: ClineRelayModel): string[];
export const clineRelayCatalogSchema: import("zod").ZodType<ClineRelayCatalog>;
export const clineRelayModelSchema: import("zod").ZodType<ClineRelayModel>;
