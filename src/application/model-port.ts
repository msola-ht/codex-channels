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
  /** 本地守卫只约束新的请求提交，已提交请求仍按实际结果结算。 */
  listModels(beforeSubmit?: () => void): Promise<ModelOption[]>;
  listModelsForProvider?(provider: string, beforeSubmit?: () => void): Promise<ModelOption[]>;
  writeDefaultServiceTier(tier: "fast" | "ultrafast" | "default", beforeSubmit?: () => void): Promise<void>;
  readDefaultReasoningEffort(cwd: string, modelProvider?: string, beforeSubmit?: () => void): Promise<string | null>;
  readDefaultServiceTier(cwd: string, modelProvider?: string, beforeSubmit?: () => void): Promise<string | null>;
  readModelAccelerationSettings(cwd: string, modelProvider?: string, beforeSubmit?: () => void): Promise<{
    fastEnabled: boolean;
    ultrafastEnabled: boolean;
    serviceTier: string | null;
  }>;
}
