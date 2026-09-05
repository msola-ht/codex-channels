import type { ManagedModelProviderId } from "../runtime/model-provider-definitions.mjs";

export class OpenCodeGoAccountProvisioningError extends Error {
  code: string;
  field: string;
}

export interface OpenCodeGoAccountConfigurationPreview {
  operation: "add" | "reconfigure";
  account: {
    id: string;
    provider: string;
    email?: string;
    phone?: string;
    displayName?: string;
    exists: boolean;
    default: boolean;
  };
  mode: "switching" | "exclusive";
  effects: {
    writesMainConfig: boolean;
    writesIsolatedProfile: boolean;
    downloadsCatalog: boolean;
    updatesExternalAgent: boolean;
  };
  confirmation: {
    required: boolean;
    field: "confirmExclusiveConfigChange";
  };
  activation: "restart-all";
}

interface ProvisioningOptions {
  environment?: NodeJS.ProcessEnv;
  loadAccounts?: (environment: NodeJS.ProcessEnv) => Array<{
    id: string;
    default: boolean;
  }>;
  loadPrimaryProvider?: (
    environment: NodeJS.ProcessEnv,
  ) => "openai" | ManagedModelProviderId;
}

export function previewOpencodeGoAccountConfiguration(
  input: {
    accountId: string;
    email?: string;
    phone?: string;
    contact?: string;
    mode?: "switching" | "exclusive";
    reconfigure?: boolean;
  },
  options?: ProvisioningOptions,
): Promise<OpenCodeGoAccountConfigurationPreview>;

export function applyOpencodeGoAccountConfiguration(
  input: {
    accountId: string;
    email?: string;
    phone?: string;
    contact?: string;
    mode?: "switching" | "exclusive";
    reconfigure?: boolean;
    apiKey: string;
    confirmExclusiveConfigChange?: boolean;
  },
  options?: ProvisioningOptions & {
    fetchImpl?: typeof fetch;
    downloadCatalog?: (fetchImpl: typeof fetch) => Promise<{
      catalog: { models: Array<Record<string, unknown>> };
      sha256: string;
    }>;
    configureRole?: (
      provider: ManagedModelProviderId,
      model: string | undefined,
      environment: NodeJS.ProcessEnv,
    ) => unknown | Promise<unknown>;
  },
): Promise<{
  action: "configured";
  model: string;
  paths: {
    configPath: string;
    profilePath: string;
    markerPath: string;
    catalogPath: string;
  };
} & OpenCodeGoAccountConfigurationPreview>;

export function readOpencodeGoOptionalJson(
  path: string,
  label: string,
): Promise<Record<string, unknown> | undefined>;

export function readOpencodeGoDefaultModelMigration(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined;
