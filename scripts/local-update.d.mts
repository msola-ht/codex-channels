export interface DatabaseInspection {
  compatible?: boolean;
  databasePath?: string;
  exists?: boolean;
  schemaVersion?: number | null;
  targetSchemaVersion?: number;
  updateable?: boolean;
}

export interface DatabaseUpdateResult {
  backupPath?: string | null;
  changed: boolean;
  databasePath: string;
  schemaVersion?: number | null;
  version?: number | null;
}

export interface LocalUpdateEnvironment {
  [key: string]: string | undefined;
}

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
): { configPath: string; missingSafeDefaults: string[] };

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
};

export function updateLocalInstallation(
  environment?: LocalUpdateEnvironment,
  options?: {
    databaseOptions?: Parameters<typeof updateDatabases>[1];
    inspectConfig?: () => { configPath: string; missingSafeDefaults?: string[] };
    inspectDatabases?: () => { state: DatabaseInspection; metrics: DatabaseInspection };
    onInspected?: (inspection: {
      config: { configPath: string; missingSafeDefaults?: string[] };
      databases: { state: DatabaseInspection; metrics: DatabaseInspection };
    }) => void;
    startServices?: () => void;
    stopServices?: () => void;
    updateConfig?: () => unknown;
    updateDatabases?: () => unknown;
    validateOffline?: () => unknown;
    waitForServices?: () => Promise<void>;
  },
): Promise<{ config: unknown; databases: unknown }>;

export function validateLocalInstallation(
  environment?: LocalUpdateEnvironment,
): {
  config: { configPath: string; missingSafeDefaults: string[] };
  state: DatabaseInspection;
  metrics: DatabaseInspection;
};

export function waitForCoreServices(
  environment?: LocalUpdateEnvironment,
  options?: {
    gatewayHealthy?: (configPath: string) => boolean | Promise<boolean>;
    inspectSupervisor?: (socketPath: string) => unknown | Promise<unknown>;
    intervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    socketHealthy?: (socketPath: string) => boolean | Promise<boolean>;
    stableMs?: number;
    timeoutMs?: number;
  },
): Promise<void>;
