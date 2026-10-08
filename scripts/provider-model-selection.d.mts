export interface ProviderModelSelectionEntry {
  id: string;
  name: string;
  reasoningEffort?: string;
}

export interface ProviderModelSelectionOptions {
  models: ProviderModelSelectionEntry[];
  requiredModels?: string[];
}

export function validateEnabledModelSelection(selected: unknown, options: ProviderModelSelectionOptions): string[];

export function promptEnabledProviderModels(
  prompts: {
    multiselect?(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    isCancel(value: unknown): boolean;
  },
  output: { write(value: string): unknown },
  options: ProviderModelSelectionOptions & {
    enabledModels: string[];
    label: string;
    defaultModelWhenUnrequired?: string;
  },
): Promise<string[] | undefined>;
