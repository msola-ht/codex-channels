export interface ReasoningEffortOption {
  effort: string;
  description: string;
}

export type ModelInputModality = "text" | "image" | "audio";

export type ModelMultiAgentVersion = "disabled" | "v1" | "v2";

export interface ModelUpgradeNotice {
  model: string;
  retirementAtSeconds: number | null;
}

export interface ModelOption {
  provider?: string;
  available?: boolean;
  unavailableReason?: string;
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: string;
  serviceTiers: Array<{
    id: string;
    name: string;
  }>;
  defaultServiceTier: string | null;
  isDefault: boolean;
  inputModalities: ModelInputModality[];
  multiAgentVersion?: ModelMultiAgentVersion;
  upgrade?: ModelUpgradeNotice;
}

export interface ModelSelectionPort {
  listModels(): Promise<ModelOption[]>;
  writeDefaultFastMode(enabled: boolean): Promise<void>;
  readDefaultReasoningEffort(cwd: string, modelProvider?: string): Promise<string | null>;
  readDefaultServiceTier(cwd: string, modelProvider?: string): Promise<string | null>;
}
