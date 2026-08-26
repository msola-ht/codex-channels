import type {
  CodexUserConfigModelOption,
  CodexUserConfigTransactionClient,
  CodexUserConfigValue,
} from "./codex-user-config.mjs";

export const primaryProviderId: "OpenAI";

export interface CustomPrimaryProviderSaveInput {
  operation: "create" | "update";
  providerId: string;
  name: string;
  baseUrl: string;
  mode: "switching" | "exclusive";
  model: string;
  supportsWebsockets: boolean;
  credential:
    | { action: "preserve" }
    | { action: "replace"; apiKey: string };
  confirmRemoveTopLevelBaseUrl?: boolean;
}

export interface CustomPrimaryProviderSaveOptions {
  environment?: NodeJS.ProcessEnv;
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CodexUserConfigTransactionClient & {
    listModels(): Promise<CodexUserConfigModelOption[]>;
  }>;
  loadContext?: () => Promise<{
    snapshot: {
      config: Record<string, CodexUserConfigValue | undefined>;
      version?: string | number | null;
    };
    officialModels: CodexUserConfigModelOption[];
  }>;
}

export interface CustomPrimaryProviderSaveSummary {
  id: string;
  displayName: string;
  baseUrl: string;
  mode: "switching" | "exclusive";
  model: string;
  supportsWebsockets: boolean;
  catalog: "official";
  hasApiKey: true;
}

export function customPrimaryProviderIdFromBaseUrl(baseUrl: string): string;
export function validCustomPrimaryProviderBaseUrl(value: unknown): string;
export function customPrimaryProviderUrlsShareOrigin(left: string, right: string): boolean;

export function previewCustomPrimaryProviderSave(
  input: CustomPrimaryProviderSaveInput,
  options?: CustomPrimaryProviderSaveOptions,
): Promise<{
  operation: "create" | "update";
  provider: CustomPrimaryProviderSaveSummary;
  activation: "restart-all";
  effects: {
    removesTopLevelBaseUrl: boolean;
    convertsSwitchingProfile: boolean;
    consumesBackupCandidate: boolean;
    preservesApiKey: boolean;
  };
  credential: {
    action: "preserve" | "replace";
    storedAsPlaintext: true;
    destination: "private-profile" | "main-config";
  };
}>;

export function prepareCustomPrimaryProviderSave(
  input: CustomPrimaryProviderSaveInput,
  options?: CustomPrimaryProviderSaveOptions,
): Promise<{
  preview: Awaited<ReturnType<typeof previewCustomPrimaryProviderSave>>;
  apply(): ReturnType<typeof applyCustomPrimaryProviderSave>;
}>;

export function applyCustomPrimaryProviderSave(
  input: CustomPrimaryProviderSaveInput,
  options?: CustomPrimaryProviderSaveOptions,
): Promise<{
  action: "created" | "updated";
  provider: CustomPrimaryProviderSaveSummary;
  activation: "restart-all";
  effects: {
    removesTopLevelBaseUrl: boolean;
    convertsSwitchingProfile: boolean;
    consumesBackupCandidate: boolean;
    preservesApiKey: boolean;
  };
  warnings: Array<{ code: "backup-cleanup-failed"; providerId: string }>;
}>;
