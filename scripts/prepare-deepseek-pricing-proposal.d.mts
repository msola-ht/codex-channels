export const deepseekPricingPageUrl: string;

export interface DeepseekPricingDownload {
  html: string;
  sha256: string;
  etag: string | null;
  lastModified: string;
}

export interface DeepseekPricingProposalResult {
  status: "success" | "failure";
  changed: boolean;
  source: string;
  sourceSha256: string | null;
  sourceEtag: string | null;
  sourceLastModified: string | null;
  scheduleChanged: boolean;
  changedModels: string[];
  error?: string;
}

export function runDeepseekPricingProposal(options: {
  baselinePath: string;
  outputDirectory: string;
  download?: () => Promise<DeepseekPricingDownload>;
}): Promise<DeepseekPricingProposalResult>;

export function downloadDeepseekPricingPage(
  fetchImpl: typeof fetch,
  options?: {
    attempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  },
): Promise<DeepseekPricingDownload>;

export function parseDeepseekPricingPage(
  html: string,
  sourceUpdatedAt: string,
): Record<string, unknown>;

export function comparePricingBaselines(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
): {
  changed: boolean;
  scheduleChanged: boolean;
  changedModels: string[];
};
