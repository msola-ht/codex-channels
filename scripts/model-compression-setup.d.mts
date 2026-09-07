import type { ModelCompressionImportEntry } from "./model-compression-management.mjs";

export interface ModelCompressionSetupOptions {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: Pick<NodeJS.WriteStream, "write">;
  prompts?: Record<string, unknown>;
  prompter?: {
    selectModel(): Promise<string | "back">;
    selectAutoCompactPercent(model: ModelCompressionImportEntry): Promise<number>;
  };
}

export function runModelCompressionSetup(
  options?: ModelCompressionSetupOptions,
): Promise<
  | { action: "back" }
  | {
      action: "configured";
      model: string;
      autoCompactPercent: number;
      autoCompactLimit: number;
      providers: string[];
    }
>;
