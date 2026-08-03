export interface ApiProviderSetupResult {
  action: "back" | "created" | "updated" | "removed";
  provider?: unknown;
  configPath?: string;
}

export declare function runApiProviderSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: unknown;
  writeConfig?: (configPath: string, document: unknown) => void;
}): Promise<ApiProviderSetupResult>;
