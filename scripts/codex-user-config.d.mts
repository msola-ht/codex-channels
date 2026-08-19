export type CodexUserConfigValue =
  | number
  | string
  | boolean
  | CodexUserConfigValue[]
  | { [key: string]: CodexUserConfigValue | undefined }
  | null;

export interface CodexUserConfigEdit {
  keyPath: string;
  value: CodexUserConfigValue;
}

export interface CodexUserConfigModelOption {
  available?: boolean;
  model: string;
  displayName: string;
  supportedReasoningEfforts: Array<{
    effort: string;
    description: string;
  }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
}

export interface CodexUserConfigClientLifecycle {
  connect(): Promise<unknown>;
  close(): Promise<void>;
}

export interface CodexDefaultSettingsClient extends CodexUserConfigClientLifecycle {
  listModels(): Promise<CodexUserConfigModelOption[]>;
  readDefaultModelSettings(): Promise<{
    model: string | null;
    effort: string | null;
  }>;
  writeDefaultModelSettings(model: string, effort: string): Promise<void>;
}

export interface CodexUserConfigTransactionClient extends CodexUserConfigClientLifecycle {
  readUserConfigSnapshot(): Promise<{
    config: Record<string, CodexUserConfigValue | undefined>;
    version: string;
  }>;
  writeUserConfigEdits(
    edits: CodexUserConfigEdit[],
    options?: { expectedVersion?: string },
  ): Promise<void>;
}

export interface CodexUserConfigClient
  extends CodexDefaultSettingsClient, CodexUserConfigTransactionClient {}

export function writeCodexUserConfigEdits(
  environment: NodeJS.ProcessEnv,
  edits: CodexUserConfigEdit[],
  options?: {
    expectedVersion?: string;
    createClient?: (options: {
      environment: NodeJS.ProcessEnv;
    }) => Promise<CodexUserConfigTransactionClient>;
  },
): Promise<void>;

export function updateCodexUserConfig(
  environment: NodeJS.ProcessEnv,
  createEdits: (
    config: Record<string, CodexUserConfigValue | undefined>,
  ) => CodexUserConfigEdit[],
  dependencies?: {
    createClient?: (options: {
      environment: NodeJS.ProcessEnv;
    }) => Promise<CodexUserConfigTransactionClient>;
  },
): Promise<void>;

export function readCodexUserConfigSnapshot(
  environment: NodeJS.ProcessEnv,
  dependencies?: {
    createClient?: (options: {
      environment: NodeJS.ProcessEnv;
    }) => Promise<CodexUserConfigTransactionClient>;
  },
): Promise<{
  config: Record<string, CodexUserConfigValue | undefined>;
  version: string;
}>;

export function createCodexUserConfigClient(options?: {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<CodexUserConfigClient>;
