export interface ProviderSelectionOptions {
  environment?: NodeJS.ProcessEnv;
  primaryProvider?: string;
  customPrimaryProvider?: { id: string } | null;
  managedProfileDefinitions?: ReadonlyArray<{ id: string; profileName: string }>;
  customSwitchingProfiles?: ReadonlyArray<{ providerId: string; profileName: string }>;
}
export function resolveProviderSelection(value: string, options?: ProviderSelectionOptions): {
  provider: string;
  profileName?: string;
};
