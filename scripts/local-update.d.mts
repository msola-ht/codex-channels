import type {
  ManagedModelProviderCatalogSource,
  ManagedModelProviderCatalogUpdateAdapter,
  ModelProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";

export interface DatabaseInspection {
  compatible?: boolean;
  databasePath?: string;
  exists?: boolean;
  scheduledTasks?: DatabaseInspection;
  schemaVersion?: number | null;
  targetSchemaVersion?: number;
  updateable?: boolean;
}

export interface DatabaseUpdateResult {
  backupPath?: string | null;
  changed: boolean;
  databasePath: string;
  scheduledTasks?: DatabaseUpdateResult;
  schemaVersion?: number | null;
  version?: number | null;
}

export interface LocalUpdateEnvironment {
  [key: string]: string | undefined;
}

export interface CoreServiceReadinessOptions {
  gatewayHealthy?: (configPath: string) => boolean | Promise<boolean>;
  inspectSupervisor?: (socketPath: string) => unknown | Promise<unknown>;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  socketHealthy?: (socketPath: string) => boolean | Promise<boolean>;
  stableMs?: number;
  timeoutMs?: number;
}

export interface CoreServiceInstallation {
  installed: boolean;
}

export function inspectCoreServiceInstallation(
  environment?: LocalUpdateEnvironment,
  platform?: NodeJS.Platform,
): CoreServiceInstallation;

export function inspectDatabaseUpdates(
  environment?: LocalUpdateEnvironment,
  options?: {
    inspectState?: () => DatabaseInspection;
    inspectMetrics?: () => DatabaseInspection;
    validateMetrics?: () => unknown;
  },
): { state: DatabaseInspection; metrics: DatabaseInspection };

export function updateDatabases(
  environment?: LocalUpdateEnvironment,
  options?: {
    inspect?: () => { state: DatabaseInspection; metrics: DatabaseInspection };
    onInspected?: (inspection: {
      state: DatabaseInspection;
      metrics: DatabaseInspection;
    }) => void;
    onUpdated?: (name: string, result: DatabaseUpdateResult) => void;
    updateMetrics?: () => DatabaseUpdateResult;
    updateState?: () => DatabaseUpdateResult;
  },
): { state: DatabaseUpdateResult; metrics: DatabaseUpdateResult };

export function inspectGatewayConfiguration(
  environment?: LocalUpdateEnvironment,
): { configPath: string; missingSafeDefaults: string[]; removedPaths: string[] };

export function updateGatewayConfiguration(
  environment?: LocalUpdateEnvironment,
  options?: {
    loadConfig?: () => unknown;
    now?: () => Date;
  },
): {
  addedPaths: string[];
  backupPath: string | null;
    changed: boolean;
    configPath: string;
    removedPaths: string[];
};

export function updateLocalInstallation(
  environment?: LocalUpdateEnvironment,
  options?: {
    databaseOptions?: Parameters<typeof updateDatabases>[1];
    inspectConfig?: () => {
      configPath: string;
      missingSafeDefaults?: string[];
      removedPaths?: string[];
    };
    inspectDatabases?: () => { state: DatabaseInspection; metrics: DatabaseInspection };
    inspectServices?: () => CoreServiceInstallation;
    onInspected?: (inspection: {
      config: { configPath: string; missingSafeDefaults?: string[]; removedPaths?: string[] };
      databases: { state: DatabaseInspection; metrics: DatabaseInspection };
      services: CoreServiceInstallation;
    }) => void;
    startServices?: () => void;
    stopServices?: () => void;
    updateProviderFiles?: () => unknown;
    updateProviderCatalogs?: () => unknown | Promise<unknown>;
    updateConfig?: () => unknown;
    updateDatabases?: () => unknown;
    validateOffline?: () => unknown;
    waitForServices?: () => Promise<void>;
  },
): Promise<{
  config: unknown;
  databases: unknown;
  providerCatalogs: unknown;
  servicesRestored: boolean;
}>;

export function refreshManagedProviderCatalogsForUpdate(
  environment?: LocalUpdateEnvironment,
  options?: {
    definitions?: readonly ModelProviderDefinition[];
    catalogDownloaders?: Partial<Record<
      ManagedModelProviderCatalogSource,
      () => unknown | Promise<unknown>
    >>;
    updateAdapters?: Partial<Record<
      Exclude<ManagedModelProviderCatalogUpdateAdapter, "none">,
      (
        environment: LocalUpdateEnvironment,
        options: {
          definition: ModelProviderDefinition;
          downloadCatalog: () => Promise<unknown>;
        },
      ) => unknown | Promise<unknown>
    >>;
    onUpdated?: (event: {
      definition: ModelProviderDefinition;
      result: unknown;
    }) => void;
  },
): Promise<Record<string, unknown>>;

export function validateLocalInstallation(
  environment?: LocalUpdateEnvironment,
): {
  config: { configPath: string; missingSafeDefaults: string[] };
  state: DatabaseInspection;
  metrics: DatabaseInspection;
};

export function waitForCoreServices(
  environment?: LocalUpdateEnvironment,
  options?: CoreServiceReadinessOptions,
): Promise<void>;

export function waitForCoreServiceTarget(
  target: "gateway" | "app-server" | "all",
  environment?: LocalUpdateEnvironment,
  options?: CoreServiceReadinessOptions,
): Promise<void>;
