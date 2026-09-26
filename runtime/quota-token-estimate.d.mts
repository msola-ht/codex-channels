export type QuotaTokenEstimate =
  | { status: "sampling" | "unavailable" }
  | { status: "ready"; tokensPerPercent: number; observedDeltaPercent: number; intervalCount: number; requestCount: number };

export interface AccountQuotaWindowEstimate {
  windowId: string;
  resetsAt: number;
  tokenEstimate: QuotaTokenEstimate;
}

export function withQuotaTokenEstimates<T extends { windowId: string; resetsAt: number | null }>(
  windows: readonly T[],
  read?: () => AccountQuotaWindowEstimate[],
): Array<T & { tokenEstimate: QuotaTokenEstimate }>;
