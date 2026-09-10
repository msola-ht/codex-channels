export function formatTokenCount(value: number): string;

export function isRecord(value: unknown): value is Record<string, unknown>;

export function formatLocalTime(ms: number): string;

export function formatDuration(value: number | null): string;

export function markdownCell(value: unknown): string;

export function csvCell(value: unknown): string;
