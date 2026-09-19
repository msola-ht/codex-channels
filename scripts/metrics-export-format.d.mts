export function formatRequestCount(value: number): string;
export function formatTokenCount(value: number): string;
export function formatElapsedDuration(durationMs: number): string;

export function isRecord(value: unknown): value is Record<string, unknown>;

export function formatLocalTime(ms: number): string;
export function formatLocalTimeZone(ms?: number): string;

export function markdownCell(value: unknown): string;

export function csvCell(value: unknown): string;
