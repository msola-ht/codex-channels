export const contextWindowPresetTokens: readonly [131072, 262144, 393216, 524288, 1048576];
export const openAiContextWindowPresetTokens: readonly [272000, 372000, 500000];
export function contextWindowPresetLabel(tokens: number): string;
export function isValidCustomModelId(id: unknown): id is string;
export function withModelContextWindow(model: ModelDefinition, contextWindow: number): ModelDefinition;
export interface SamplingParameters {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
}
export const customModelSamplingDefaults: Readonly<Required<SamplingParameters>>;
export interface ModelDefinition {
  id: string;
  name: string;
  description?: string;
  contextWindow: number;
  maxContextWindow?: number;
  /** Omitted is unknown; an empty array explicitly declares no reasoning support. */
  reasoningEfforts?: string[];
  defaultReasoningEffort: string | null;
  reasoningDescriptions?: Record<string, string>;
  supportsImages?: boolean;
  supportsImageDetailOriginal?: boolean;
  supportsVerbosity?: boolean;
  defaultVerbosity?: "low" | "medium" | "high" | null;
  supportsReasoningSummary?: boolean;
  defaultReasoningSummary?: "auto" | "concise" | "detailed" | "none";
  effectiveContextWindowPercent?: number;
  autoCompactTokenLimit?: number;
  truncationPolicy?: {mode: "tokens" | "bytes"; limit: number};
  sampling?: SamplingParameters;
  /** Omitted is unknown; null explicitly declares no apply_patch support. */
  applyPatchToolType?: "freeform" | null;
  instructions?: string;
  modelMessages?: Record<string, unknown>;
  /** Local Codex tool declarations; omission preserves historical v5 compilation. */
  experimentalSupportedTools?: string[];
  supportsSearchTool?: boolean;
  /** Historical v5 metadata retained for snapshot consistency; no search policy effect. */
  supportsWebSearch?: boolean;
  /** followContext is retained only when reading historical v5 metadata; it has no runtime effect. */
  template?: {source: "official" | "deepseek"; model: string; followContext?: boolean};
}
export function validateSamplingParameters(value: unknown): SamplingParameters | undefined;
export function validateModelDefinitions(values: unknown, defaultModel: string, options?: { allowReasoningToggle?: boolean }): ModelDefinition[];
export function compileModelDefinitions(definitions: ModelDefinition[], defaultModel: string, options?: { allowReasoningToggle?: boolean }): { definitions: ModelDefinition[]; models: Record<string, unknown>[] };
export function modelDefinitionsFromCatalog(catalog: unknown, source?: "official" | "deepseek", options?: { allowReasoningToggle?: boolean }): ModelDefinition[];
export function normalizeDeepseekCatalogCapabilities(catalog: { models: Record<string, unknown>[] }): { models: Record<string, unknown>[] };
