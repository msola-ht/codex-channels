export type ServiceInstallStage =
  | "validate-config"
  | "preflight"
  | "write-definitions"
  | "activate-core"
  | "verify-core";

export interface ServiceInstallPreview {
  operation: "install";
  revision: string;
  operatingSystem: "linux" | "darwin";
  serviceManager: "systemd" | "launchd";
  configPath: string;
  services: Array<{
    target: "gateway" | "app-server" | "webui" | "center";
    displayName: string;
    identifier: string;
    destination: string;
    startsOnInstall: boolean;
  }>;
  steps: ServiceInstallStage[];
  activation: "none";
}

export interface ServiceInstallProgress {
  operation: "install";
  revision: string;
  stage: ServiceInstallStage;
  status: "started" | "completed" | "failed";
  completedStages: ServiceInstallStage[];
}

export interface ServiceInstallResult extends ServiceInstallPreview {
  action: "installed";
  completedStages: ServiceInstallStage[];
}

export class ServiceInstallManagementError extends Error {
  code: string;
  stage: ServiceInstallStage;
  completedStages: ServiceInstallStage[];
  recovery: "unsupported" | "set-home" | "recreate-plan" | "fix-and-retry" | "retry-install" | "inspect-services";
}

export interface ServiceInstallOptions {
  operatingSystem?: NodeJS.Platform;
  projectDir?: string;
  nodeExecutable?: string;
  validateConfig?: (environment: NodeJS.ProcessEnv) => unknown;
  preflight?: (
    plan: unknown,
    environment: NodeJS.ProcessEnv,
    options: ServiceInstallOptions,
  ) => unknown;
  activateCore?: (
    plan: unknown,
    environment: NodeJS.ProcessEnv,
    options: ServiceInstallOptions,
  ) => unknown;
  waitForCore?: (
    target: "all",
    environment: NodeJS.ProcessEnv,
    options?: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  writeDefinition?: (path: string, content: string) => void;
  spawnCommand?: typeof import("node:child_process").spawnSync;
  controllerStdio?: import("node:child_process").StdioOptions;
  readinessOptions?: Record<string, unknown>;
  onProgress?: (progress: ServiceInstallProgress) => void;
}

export function previewServiceInstall(
  environment?: NodeJS.ProcessEnv,
  options?: ServiceInstallOptions,
): ServiceInstallPreview;

export function prepareServiceInstall(
  environment?: NodeJS.ProcessEnv,
  options?: ServiceInstallOptions,
): {
  preview: ServiceInstallPreview;
  execute(options?: ServiceInstallOptions): Promise<ServiceInstallResult>;
};

export function installServices(
  environment?: NodeJS.ProcessEnv,
  options?: ServiceInstallOptions,
): Promise<ServiceInstallResult>;

export function writeServiceDefinitions(
  environment?: NodeJS.ProcessEnv,
  options?: ServiceInstallOptions,
): {
  action: "definitions-written";
  revision: string;
  operatingSystem: "linux" | "darwin";
  serviceManager: "systemd" | "launchd";
  services: ServiceInstallPreview["services"];
};
