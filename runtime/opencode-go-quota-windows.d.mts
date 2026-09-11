export interface OpenCodeGoQuotaWindowSnapshot {
  windowId: string;
  resetsAt: number | null;
  usedPercentMillionths: number | null;
  status: string | null;
}

export function createOpencodeGoQuotaWindowsProvider(options?: {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  provider?: string;
  nowMs?: () => number;
}): (signal?: AbortSignal) => Promise<readonly OpenCodeGoQuotaWindowSnapshot[] | null>;
