import type {
  AppServerSupervisorInspection,
} from "../runtime/app-server-supervisor.mjs";

export interface DatabaseInspection {
  compatible?: boolean;
  databasePath?: string;
  exists?: boolean;
  scheduledTasks?: DatabaseInspection;
  schemaVersion?: number | null;
  targetSchemaVersion?: number;
}

export interface LocalUpdateEnvironment {
  [key: string]: string | undefined;
}

export interface CoreServiceReadinessOptions {
  gatewayHealthy?: (configPath: string) => boolean | Promise<boolean>;
  inspectSupervisor?: (socketPath: string) => unknown | Promise<unknown>;
  inspectSupervisorState?: (socketPath: string) =>
    AppServerSupervisorInspection | Promise<AppServerSupervisorInspection>;
  intervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  socketHealthy?: (socketPath: string) => boolean | Promise<boolean>;
  stableMs?: number;
  timeoutMs?: number;
}

export interface CoreServiceInstallation { installed: boolean; }
export function inspectCoreServiceInstallation(environment?: LocalUpdateEnvironment, platform?: NodeJS.Platform): CoreServiceInstallation;
export function inspectGatewayConfiguration(environment?: LocalUpdateEnvironment): { configPath: string };
export function inspectDatabaseUpdates(environment?: LocalUpdateEnvironment): { required: boolean; state: DatabaseInspection; metrics: DatabaseInspection; sessionDisplayCache: DatabaseInspection };
export function applyDatabaseUpdates(environment?: LocalUpdateEnvironment): void | Promise<void>;
export function inspectSessionDisplayCache(environment?: LocalUpdateEnvironment): DatabaseInspection;

export function waitForCoreServiceTarget(
  target: "gateway" | "app-server" | "all",
  environment?: LocalUpdateEnvironment,
  options?: CoreServiceReadinessOptions,
): Promise<void>;
