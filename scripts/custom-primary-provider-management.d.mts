import type {
  CodexUserConfigModelOption,
  CodexUserConfigTransactionClient,
  CodexUserConfigValue,
} from "./codex-user-config.mjs";

export const primaryProviderId: "OpenAI";
export type CustomProviderConnectionSaveInput = Omit<CustomPrimaryProviderSaveInput, "operation" | "model" | "catalog" | "probeConnections"> & { operation: "update" };
export function previewCustomProviderConnectionSave(input: CustomProviderConnectionSaveInput, options?: CustomPrimaryProviderSaveOptions): ReturnType<typeof previewCustomPrimaryProviderSave>;
export function prepareCustomProviderConnectionSave(input: CustomProviderConnectionSaveInput, options?: CustomPrimaryProviderSaveOptions): Promise<{ preview: Awaited<ReturnType<typeof previewCustomPrimaryProviderSave>>; apply(): ReturnType<typeof applyCustomPrimaryProviderSave> }>;
export function applyCustomProviderConnectionSave(input: CustomProviderConnectionSaveInput, options: CustomPrimaryProviderSaveOptions & { preview: { revision?: string } }): ReturnType<typeof applyCustomPrimaryProviderSave>;
export interface CustomProviderModelsSaveInput {
  provider: string;
  model: string;
  models: import("../runtime/model-provider-responses-catalog.mjs").ResponsesModelDefinition[];
  probeConnections?: CustomPrimaryProviderSaveInput["probeConnections"];
}
export function previewCustomProviderModelsSave(input: CustomProviderModelsSaveInput, options?: CustomPrimaryProviderSaveOptions): Promise<Omit<Awaited<ReturnType<typeof previewCustomPrimaryProviderSave>>, "operation"> & { operation: "model.custom.save"; revision: string }>;
export function applyCustomProviderModelsSave(input: CustomProviderModelsSaveInput, options: CustomPrimaryProviderSaveOptions & { preview: { revision?: string } }): Promise<Awaited<ReturnType<typeof applyCustomPrimaryProviderSave>> & { operation: "model.custom.save" }>;
export function customModelProbeConnection(input: { baseUrl: string; upstreamWireApi: "responses" | "chat_completions"; apiKey: string; model: string; reasoningEffort: string; capability: "applyPatch" | "toolSearch" }): string;

export interface CustomPrimaryProviderSaveInput {
  operation: "create" | "update";
  providerId: string;
  name: string;
  baseUrl: string;
  mode: "switching" | "exclusive";
  model: string;
  catalog?: { kind: "custom"; models: import("../runtime/model-provider-responses-catalog.mjs").ResponsesModelDefinition[] };
  supportsWebsockets: boolean;
  upstreamWireApi?: "responses" | "chat_completions";
  /** Applied probe drafts bind their connection until save; not persisted or an attestation of capabilities. */
  probeConnections?: Array<{ model: string; capability: "applyPatch" | "toolSearch"; token: string }>;
  credential:
    | { action: "preserve" }
    | { action: "replace"; apiKey: string };
  confirmRemoveTopLevelBaseUrl?: boolean;
}

export interface CustomPrimaryProviderSaveOptions {
  environment?: NodeJS.ProcessEnv;
  preview?: { revision?: string };
  expectedCatalogContent?: string;
  /** Internal capability-only saves preserve both catalog and connection selections. */
  preserveDefaults?: boolean;
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
  upstreamWireApi?: "responses" | "chat_completions";
  catalog: "official" | "custom";
  models?: import("../runtime/model-provider-responses-catalog.mjs").ResponsesModelDefinition[];
  hasApiKey: true;
}

export function customPrimaryProviderIdFromBaseUrl(baseUrl: string, catalogKind: "official" | "custom", environment?: NodeJS.ProcessEnv): string;
export function validCustomPrimaryProviderBaseUrl(value: unknown): string;
export function customPrimaryProviderUrlsShareOrigin(left: string, right: string): boolean;

export function previewCustomPrimaryProviderSave(
  input: CustomPrimaryProviderSaveInput,
  options?: CustomPrimaryProviderSaveOptions,
): Promise<{
  operation: "create" | "update";
  revision: string;
  provider: CustomPrimaryProviderSaveSummary;
  transport: { scheme: "http" | "https"; cleartext: boolean };
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
    destination: "private-profile" | "private-credential";
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
  options: CustomPrimaryProviderSaveOptions & { preview: { revision?: string } },
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
