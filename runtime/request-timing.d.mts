export interface GenerationTiming {
  reasoningMs: number;
  textMs: number;
  toolMs: number;
  /** Union of all observed generation intervals, excluding gaps and tool execution. */
  totalMs: number;
}
export function validGenerationTiming(value: unknown): value is GenerationTiming;
export function validRequestTiming(value: { responseTimeMs?: unknown; generationTiming?: unknown; totalDurationMs?: unknown }): boolean;
export function generationSpeed(value: { outputTokens?: number | null; generationTiming?: GenerationTiming | null } | null | undefined): number | null;
export function formatGenerationSpeed(value: Parameters<typeof generationSpeed>[0]): string;
