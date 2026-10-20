import type { ProviderModelContextPreview } from "./provider-model-management.mjs";

export interface ModelWindowImportEntry {
  provider: string;
  providers: string[];
  revision: string;
  model: string;
  displayName: string;
  contextWindow: number | null;
  maxContextWindow: number | null;
}

export interface ModelWindowSetupOptions {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: Pick<NodeJS.WriteStream, "write">;
  prompts?: Record<string, unknown>;
  prompter?: {
    /** JSON.stringify([provider, model]); provider and model are never inferred from a slug. */
    selectModel(): Promise<string | "back">;
    selectContextWindow(model: ModelWindowImportEntry): Promise<number>;
    confirmSave(preview: ProviderModelContextPreview): Promise<boolean>;
  };
}

export function runModelWindowSetup(
  options?: ModelWindowSetupOptions,
): Promise<
  | { action: "back" }
  | {
      action: "configured" | "unchanged";
      provider: string;
      model: string;
      windowPercent: number;
      contextWindow: number;
      providers: string[];
      activation: "restart-app-server" | "none";
      activationResult: ReturnType<typeof import("./config-activation-result.mjs").configActivationResult>;
    }
>;
