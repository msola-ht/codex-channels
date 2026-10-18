export type OfficialModelCatalogErrorCode = "cache_missing" | "invalid_catalog" | "cache_unavailable" | "stale_revision" | "invalid_input" | "write_failed" | "export_failed";
export type OfficialModelCatalogExportFailureReason = "launch" | "timeout" | "output-limit" | "exit" | "decode" | "cancelled" | "termination-unconfirmed";
export class OfficialModelCatalogError extends Error {
  constructor(code: OfficialModelCatalogErrorCode, reason?: OfficialModelCatalogExportFailureReason);
  code: OfficialModelCatalogErrorCode;
  reason?: OfficialModelCatalogExportFailureReason;
}
import type { OpenAiModelCatalogEntry } from "../runtime/model-catalog-presentation.mjs";
export type { OpenAiModelCatalogEntry, OpenAiModelDetails } from "../runtime/model-catalog-presentation.mjs";
export interface OpenAiModelCatalog {
  source: "codex-cache";
  revision: string;
  scope: string;
  fetchedAt: string;
  clientVersion: string | null;
  models: OpenAiModelCatalogEntry[];
}
export interface OpenAiModelContextInput { revision: string; model: string; contextWindow: number }
export interface OpenAiModelContextPreview extends OpenAiModelContextInput {
  scope: string;
  displayName: string;
  previousContextWindow: number | null;
  maxContextWindow: number;
}
export interface OpenAiModelCacheWriteResult {
  revision: string | null;
  scope: string;
  consistency: "confirmed" | "unknown";
  backupCreated: true;
}
export interface OpenAiModelDifference {
  model: string;
  before: OpenAiModelCatalogEntry | null;
  after: OpenAiModelCatalogEntry | null;
}
export interface OpenAiModelRefreshPreview {
  revision: string;
  scope: string;
}
export type OpenAiModelRefreshResult = OpenAiModelCacheWriteResult & {
  cacheChanged: boolean;
  outputMatchesCache: boolean;
  differences: OpenAiModelDifference[];
};
export function loadOpenAiModelCatalog(environment?: NodeJS.ProcessEnv): Promise<OpenAiModelCatalog>;
export function closeOpenAiModelExports(): Promise<void>;
export function waitForOpenAiModelExportsExit(): Promise<void>;
export interface OpenAiModelPrompts {
  revision: string;
  model: string;
  groups: Array<{ group: "general" | "approvals" | "collaboration" | "review" | "permissions" | "agents" | "budget" | "confirmation" | "tools"; entries: Array<{ path: string; text: string }> }>;
}
export function loadOpenAiModelPrompts(input: unknown, environment?: NodeJS.ProcessEnv): Promise<OpenAiModelPrompts>;
export function previewOpenAiModelContext(input: unknown, environment?: NodeJS.ProcessEnv, options?: { signal?: AbortSignal }): Promise<OpenAiModelContextPreview>;
export function applyOpenAiModelContext(input: unknown, environment?: NodeJS.ProcessEnv, options?: { signal?: AbortSignal }): Promise<OpenAiModelCacheWriteResult & { model: string; contextWindow: number }>;
export function previewOpenAiModelRefresh(input: unknown, environment?: NodeJS.ProcessEnv, options?: { signal?: AbortSignal }): Promise<OpenAiModelRefreshPreview>;
export function applyOpenAiModelRefresh(input: unknown, environment?: NodeJS.ProcessEnv, options?: { signal?: AbortSignal }): Promise<OpenAiModelRefreshResult>;
