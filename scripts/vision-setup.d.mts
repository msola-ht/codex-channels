export interface VisionSetupResult {
  action?: "back";
  mode?: "disabled" | "responses_api";
  configPath?: string;
}

export declare function runVisionSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: unknown;
  writeConfig?: (configPath: string, document: unknown) => void;
}): Promise<VisionSetupResult>;
