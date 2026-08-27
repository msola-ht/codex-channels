import type { CodexUserConfigTransactionClient } from "./codex-user-config.mjs";

export type PrimaryProviderActivation = "none" | "restart-all";

export interface PrimaryProviderManagementOptions {
  environment?: NodeJS.ProcessEnv;
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CodexUserConfigTransactionClient>;
  preview?: PrimaryProviderRemovalPreview;
}

export interface PrimaryProviderTarget {
  id: string;
  displayName: string;
  source: "official" | "configured" | "switching" | "backup";
  baseUrl?: string;
  model?: string | null;
}

export interface PrimaryProviderSwitchEffects {
  currentProviderId: string;
  restoresFromBackup: boolean;
  convertsSwitchingProfile: boolean;
  removesTopLevelBaseUrl: boolean;
  clearsCustomModel: boolean;
  candidateIdsToBackup: string[];
  backedUpProviderIds?: string[];
}

export interface PrimaryProviderRemovalTarget {
  id: string;
  displayName: string;
  baseUrl: string;
  state: "configured" | "switching" | "stale-switching" | "backup";
  active: boolean;
}

export interface PrimaryProviderManagementWarning {
  code: "backup-cleanup-failed";
  providerId: string;
}

export interface PrimaryProviderRemovalPreview {
  operation: "remove";
  target: PrimaryProviderRemovalTarget;
  activation: PrimaryProviderActivation;
  effects: { restoresOfficial: boolean };
}

export class PrimaryProviderManagementError extends Error {
  readonly code: string;
  readonly field: string;
}

export function previewPrimaryProviderSwitch(
  input: { providerId: string; model?: string },
  options?: PrimaryProviderManagementOptions,
): Promise<{
  operation: "switch";
  target: PrimaryProviderTarget;
  activation: "restart-all";
  effects: PrimaryProviderSwitchEffects;
}>;

export function applyPrimaryProviderSwitch(
  input: { providerId: string; model?: string },
  options?: PrimaryProviderManagementOptions,
): Promise<{
  action: "switched";
  target: PrimaryProviderTarget;
  activation: "restart-all";
  effects: PrimaryProviderSwitchEffects & { backedUpProviderIds: string[] };
  warnings: PrimaryProviderManagementWarning[];
}>;

export function previewPrimaryProviderRemoval(
  input: { providerId: string },
  options?: PrimaryProviderManagementOptions,
): Promise<PrimaryProviderRemovalPreview>;

export function applyPrimaryProviderRemoval(
  input: { providerId: string },
  options?: PrimaryProviderManagementOptions,
): Promise<{
  action: "removed";
  target: PrimaryProviderRemovalTarget;
  activation: PrimaryProviderActivation;
  effects: { restoresOfficial: boolean };
  warnings: PrimaryProviderManagementWarning[];
}>;
