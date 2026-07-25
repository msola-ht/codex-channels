export interface ReasoningEffortOption {
  effort: string;
  description: string;
}

export interface ModelOption {
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
}

export interface ModelSelectionPort {
  listModels(): Promise<ModelOption[]>;
  writeDefaultFastMode(enabled: boolean): Promise<void>;
}
