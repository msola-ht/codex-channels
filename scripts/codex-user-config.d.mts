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

export interface CodexUserConfigClient {
  connect(): Promise<unknown>;
  readUserConfigSnapshot(): Promise<{
    config: Record<string, CodexUserConfigValue | undefined>;
    version: string;
  }>;
  writeUserConfigEdits(
    edits: CodexUserConfigEdit[],
    options?: { expectedVersion?: string },
  ): Promise<void>;
  close(): Promise<void>;
}

export function writeCodexUserConfigEdits(
  environment: NodeJS.ProcessEnv,
  edits: CodexUserConfigEdit[],
  dependencies?: {
    createClient?: (options: {
      environment: NodeJS.ProcessEnv;
    }) => Promise<CodexUserConfigClient>;
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
    }) => Promise<CodexUserConfigClient>;
  },
): Promise<void>;

export function createCodexUserConfigClient(options?: {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<CodexUserConfigClient>;
