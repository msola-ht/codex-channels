import type { ModelWindowImportEntry } from "./model-window-management.mjs";

export interface ModelWindowSetupOptions {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: Pick<NodeJS.WriteStream, "write">;
  prompts?: Record<string, unknown>;
  prompter?: {
    selectModel(): Promise<string | "back">;
    selectWindowPercent(model: ModelWindowImportEntry): Promise<number>;
  };
}

export function runModelWindowSetup(
  options?: ModelWindowSetupOptions,
): Promise<
  | { action: "back" }
  | {
      action: "configured";
      model: string;
      windowPercent: number;
      contextWindow: number;
      providers: string[];
    }
>;
