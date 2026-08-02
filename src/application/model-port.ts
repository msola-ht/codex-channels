export interface ReasoningEffortOption {
  effort: string;
  description: string;
}

export type ModelInputModality = "text" | "image" | "audio";

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
}

export interface ModelSelectionPort {
  listModels(): Promise<ModelOption[]>;
  writeDefaultFastMode(enabled: boolean): Promise<void>;
  readDefaultServiceTier(cwd: string, modelProvider?: string): Promise<string | null>;
}
