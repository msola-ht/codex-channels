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
  serviceTiers: Array<{ id: string; name: string }>;
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
  readUserConfigSnapshot(options?: { includeApprovalsReviewerPolicy?: boolean; includeAcceleration?: boolean }): Promise<{
    config: Record<string, CodexUserConfigValue | undefined>;
    version: string;
    toolConfig?: Record<string, CodexUserConfigValue | undefined>;
    approvalsReviewerPolicy?: { allowedReviewers: string[] | null; autoReviewDisabled: boolean };
    acceleration?: { fastEnabled: boolean; ultrafastEnabled: boolean };
  }>;
  writeUserConfigEdits(
    edits: CodexUserConfigEdit[],
    options?: { expectedVersion?: string },
  ): Promise<{ status: "ok" | "okOverridden"; version: string }>;
}

export interface CodexUserConfigClient
  extends CodexDefaultSettingsClient, CodexUserConfigTransactionClient {}

export function closePendingCodexUserConfigReads(): Promise<void>;
export function closeCodexUserConfigClients(): Promise<void>;

export function withCodexUserConfigClient<T extends CodexUserConfigClientLifecycle, R>(
  environment: NodeJS.ProcessEnv,
  createClient: (options: { environment: NodeJS.ProcessEnv }) => Promise<T>,
  signal: AbortSignal | undefined,
  operation: (client: T) => Promise<R>,
  options?: { preserveOperationResult?: boolean },
): Promise<R>;

export function readWithCodexUserConfigClient<T extends CodexUserConfigClientLifecycle, R>(
  environment: NodeJS.ProcessEnv,
  createClient: (options: { environment: NodeJS.ProcessEnv }) => Promise<T>,
  signal: AbortSignal | undefined,
  read: (client: T) => Promise<R>,
): Promise<R>;

export function createSharedCodexUserConfigClient(options?: { environment?: NodeJS.ProcessEnv }): Promise<CodexUserConfigClient>;
export function resolveCodexUserConfigBinary(environment?: NodeJS.ProcessEnv): string;

/** Handoff for an already-running updater; only disables daemon auto-start. */

export function disableCodexDaemonAutoStart(
  environment?: NodeJS.ProcessEnv,
  dependencies?: {
    createClient?: (options: { environment: NodeJS.ProcessEnv }) => Promise<CodexUserConfigTransactionClient>;
  },
): Promise<void>;

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
    signal?: AbortSignal;
    createClient?: (options: {
      environment: NodeJS.ProcessEnv;
    }) => Promise<CodexUserConfigTransactionClient>;
  },
): Promise<{
  config: Record<string, CodexUserConfigValue | undefined>;
  version: string;
}>;

export function areCodexUserConfigEditsApplied(
  config: Record<string, CodexUserConfigValue | undefined>,
  edits: CodexUserConfigEdit[],
): boolean;

export function createCodexUserConfigClient(options?: {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  codexBinary?: string;
}): Promise<CodexUserConfigClient>;
