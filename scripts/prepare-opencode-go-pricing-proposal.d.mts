export interface OpenCodeGoPricingProposalResult {
  status: "success" | "failure";
  changed: boolean;
  source: string;
  sourceSha256: string | null;
  sourceEtag: string | null;
  sourceLastModified: string | null;
  changedModels: string[];
  error?: string;
}

export const openCodeGoPageUrl: string;
export function parseOpenCodeGoPricingPage(html: string): Record<string, unknown>;
export function downloadOpenCodeGoPage(
  fetchImpl: typeof fetch,
  options?: {
    attempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<{
  html: string;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
}>;
export function runOpenCodeGoPricingProposal(options: {
  baselinePath: string;
  outputDirectory: string;
  download?: () => Promise<{
    html: string;
    sha256: string;
    etag: string | null;
    lastModified: string | null;
  }>;
}): Promise<OpenCodeGoPricingProposalResult>;
