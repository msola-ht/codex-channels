export interface OpenCodeGoQuotaWindowSnapshot {
  windowId: string;
  resetsAt: number | null;
}

export function createOpencodeGoQuotaWindowsProvider(options?: {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}): () => Promise<readonly OpenCodeGoQuotaWindowSnapshot[] | null>;
