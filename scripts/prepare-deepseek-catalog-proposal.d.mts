export interface DeepseekCatalogReasoningLevel {
  effort: string;
  description: string;
}

export interface DeepseekCatalogBaselineModel {
  slug: string;
  digest: string;
  displayName: string;
  description: string;
  contextWindow: number;
  maxContextWindow: number;
  effectiveContextWindowPercent: number;
  inputModalities: string[];
  defaultReasoningLevel: string;
  supportedReasoningLevels: DeepseekCatalogReasoningLevel[];
  visibility: string;
  minimalClientVersion: string;
  supportedInApi: boolean;
  supportsSearchTool: boolean;
  supportsParallelToolCalls: boolean;
  multiAgentVersion: string;
}

export interface DeepseekCatalogBaseline {
  schemaVersion: 1;
  source: string;
  models: DeepseekCatalogBaselineModel[];
}

export interface DeepseekCatalogProposalResult {
  status: "success";
  changed: boolean;
  source: string;
  sourceSha256: string;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface DeepseekCatalogProposalOptions {
  baselinePath: string;
  outputDirectory: string;
  download?: () => Promise<{
    catalog: unknown;
    sha256: string;
  }>;
}

export function runDeepseekCatalogProposal(
  options: DeepseekCatalogProposalOptions,
): Promise<DeepseekCatalogProposalResult>;
export function normalizeDeepseekCatalog(catalog: unknown): DeepseekCatalogBaseline;
export function compareBaselines(
  baseline: DeepseekCatalogBaseline,
  candidate: DeepseekCatalogBaseline,
): {
  changed: boolean;
  added: string[];
  removed: string[];
  modified: string[];
};
