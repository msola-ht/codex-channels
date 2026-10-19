import type { ModelDefinition } from "./model-catalog.mjs";

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
  /** Custom definition declarations, independent of conservative compiled defaults. */
  declaredCapabilities?: Pick<ModelDefinition, "reasoningEfforts" | "supportsImages" | "applyPatchToolType" | "supportsSearchTool" | "supportsWebSearch">;
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
  supports_web_search: boolean | null;
  supports_experimental_context: boolean | null;
  supports_reasoning_effort_updates: boolean | null;
  node_repl_auto_review_required: boolean | null;
  node_repl_disabled: boolean | null;
  multi_agent_version: string | null;
  multi_agent_reasoning_effort: string | null;
  use_responses_lite: boolean | null;
}

export class ModelCatalogPresentationError extends Error {}
export function projectModelCatalogEntries(models: unknown, editable?: boolean, definitions?: ModelDefinition[]): OpenAiModelCatalogEntry[];
export function projectModelPrompts(messages: unknown): Array<{ group: "general" | "approvals" | "collaboration" | "review" | "permissions" | "agents" | "budget" | "confirmation" | "tools"; entries: Array<{ path: string; text: string }> }>;
