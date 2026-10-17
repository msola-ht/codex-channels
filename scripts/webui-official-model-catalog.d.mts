export type OfficialModelCatalogErrorCode = "cache_missing" | "invalid_catalog" | "cache_unavailable" | "stale_revision" | "invalid_input" | "write_failed" | "export_failed";
export type OfficialModelCatalogExportFailureReason = "launch" | "timeout" | "output-limit" | "exit" | "decode" | "cancelled" | "termination-unconfirmed";
export class OfficialModelCatalogError extends Error {
  constructor(code: OfficialModelCatalogErrorCode, reason?: OfficialModelCatalogExportFailureReason);
  code: OfficialModelCatalogErrorCode;
  reason?: OfficialModelCatalogExportFailureReason;
}
export interface OpenAiModelCatalogEntry {
  model: string;
  displayName: string;
  contextWindow: number | null;
  maxContextWindow: number | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  serviceTiers: Array<{ id: string; name: string; description: string | null; speedMultiplier: number | null }>;
  approvals: Array<{ mode: "on_request" | "on_request_auto_review" | "never" | "unless_trusted"; state: "default" | "empty" | "custom" }>;
  editable: boolean;
  details: OpenAiModelDetails;
}
export interface OpenAiModelDetails {
  include_skills_usage_instructions: boolean | null;
  include_plugin_usage_instructions: boolean | null;
  include_apps_usage_instructions: boolean | null;
  supports_reasoning_summary_parameter: boolean | null;
  default_reasoning_summary: string | null;
  support_verbosity: boolean | null;
  default_verbosity: string | null;
  apply_patch_tool_type: string | null;
  web_search_tool_type: string | null;
  truncation_policy: { mode: "tokens" | "bytes"; limit: number } | null;
  supports_image_detail_original: boolean | null;
  input_modalities: string[] | null;
  effective_context_window_percent: number | null;
  auto_compact_token_limit: number | null;
  shell_type: string | null;
  tool_mode: string | null;
  experimental_supported_tools: string[] | null;
  supports_search_tool: boolean | null;
  supports_experimental_context: boolean | null;
  supports_reasoning_effort_updates: boolean | null;
  node_repl_auto_review_required: boolean | null;
  node_repl_disabled: boolean | null;
  multi_agent_version: string | null;
  multi_agent_reasoning_effort: string | null;
  use_responses_lite: boolean | null;
}
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
