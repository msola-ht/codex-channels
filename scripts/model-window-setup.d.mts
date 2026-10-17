import type { ModelWindowImportEntry } from "./model-window-management.mjs";

export interface ModelWindowSetupOptions {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: Pick<NodeJS.WriteStream, "write">;
  prompts?: Record<string, unknown>;
  prompter?: {
    /** JSON.stringify([provider, model]); provider and model are never inferred from a slug. */
    selectModel(): Promise<string | "back">;
    selectContextWindow(model: ModelWindowImportEntry): Promise<number>;
  };
}

export function runModelWindowSetup(
  options?: ModelWindowSetupOptions,
): Promise<
  | { action: "back" }
  | {
      action: "configured";
      provider: string;
      model: string;
      windowPercent: number;
      contextWindow: number;
      providers: string[];
    }
>;
