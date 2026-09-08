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
}): () => Promise<readonly OpenCodeGoQuotaWindowSnapshot[] | null>;
