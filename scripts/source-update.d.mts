export interface SourceUpdateResult {
  changed: boolean;
  commit?: string;
  managed: boolean;
  previousVersion?: string;
  version?: string;
}

export type SourceUpdateStage =
  | "inspect"
  | "update-installation"
  | "clone-candidate"
  | "validate-candidate"
  | "build-candidate"
  | "inspect-candidate"
  | "prepare-codex-cli"
  | "validate-codex-contract"
  | "install-codex-cli"
  | "stop-services"
  | "switch-source"
  | "refresh-command"
  | "configure-codex-daemon"
  | "restore-services"
  | "cleanup";

export interface SourceUpdatePlan {
  operation: "source-update";
  revision: string;
  managed: boolean;
  checkout?: string;
  currentCommit?: string;
  currentVersion?: string;
  targetCommit?: string;
  updateAvailable?: boolean;
  steps: SourceUpdateStage[];
}

export interface PreparedSourceUpdatePlan extends SourceUpdatePlan {
  requiresServiceInterruption: boolean;
  services: { installed: boolean };
  targetVersion: string;
}

export interface SourceUpdateProgress {
  operation: "source-update";
  stage: SourceUpdateStage;
  status: "started" | "completed" | "failed";
  completedStages: SourceUpdateStage[];
}

export interface SourceUpdateFailure {
  operation: "source-update";
  code: "source-update-failed";
  stage: SourceUpdateStage;
  completedStages: SourceUpdateStage[];
  recovery: {
    services: "not-needed" | "restored" | "failed" | "unknown" | "stopped";
    source: "unchanged" | "restore-failed" | "switched" | "switched-backup-retained";
    backupPath?: string;
  };
  recommendation: string;
}

export interface SourceUpdateOptions {
  expectedRevision?: string;
  projectDir?: string;
  repository?: string;
  captureCommand?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => string;
  runCommand?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => void;
  confirmCodexCliInstall?: (request: {
    currentVersion?: string;
    requiredVersion: string;
  }) => Promise<boolean> | boolean;
  installCodexCli?: (
    version: string,
    checkout: string,
    environment: NodeJS.ProcessEnv,
    options: SourceUpdateOptions,
  ) => Promise<void> | void;
  installCodexCliForValidation?: (
    version: string,
    checkout: string,
    environment: NodeJS.ProcessEnv,
    options: SourceUpdateOptions,
  ) => Promise<string> | string;
  validateCodexContract?: (
    checkout: string,
    environment: NodeJS.ProcessEnv,
    options: SourceUpdateOptions,
  ) => Promise<void> | void;
  writeMessage?: (kind: "note" | "success" | "failure" | "remediation", message: string) => void;
  buildCheckout?: (
    checkout: string,
    environment: NodeJS.ProcessEnv,
    options: SourceUpdateOptions,
  ) => Promise<void> | void;
  inspectStaged?: (
    checkout: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<{ services: { installed: boolean } }>;
  stopServices?: (
    checkout: string,
    environment: NodeJS.ProcessEnv,
    options: SourceUpdateOptions,
    services: readonly { target: string; running: boolean }[],
  ) => Promise<void> | void;
  inspectServices?: (environment: NodeJS.ProcessEnv) => Promise<{ target: string; running: boolean }[]> | { target: string; running: boolean }[];
  startServices?: (
    checkout: string,
    environment: NodeJS.ProcessEnv,
    options: SourceUpdateOptions,
    services: readonly { target: string; running: boolean }[],
  ) => Promise<void> | void;
  installGlobalPackage?: (
    checkout: string,
    environment: NodeJS.ProcessEnv,
    options: SourceUpdateOptions,
  ) => Promise<void> | void;
  renamePath?: (oldPath: string, newPath: string) => void;
  onPrepared?: (plan: PreparedSourceUpdatePlan) => void;
  onProgress?: (progress: SourceUpdateProgress) => void;
}

export function managedSourceCheckout(
  environment?: NodeJS.ProcessEnv,
  projectDir?: string,
): string | undefined;

export function updateManagedSourceInstallation(
  environment?: NodeJS.ProcessEnv,
  options?: SourceUpdateOptions,
): Promise<SourceUpdateResult>;

export function updateInstalledPackage(
  environment?: NodeJS.ProcessEnv,
  options?: SourceUpdateOptions,
): Promise<void>;

export function inspectManagedSourceUpdatePlan(
  environment?: NodeJS.ProcessEnv,
  options?: Pick<SourceUpdateOptions, "projectDir" | "repository" | "captureCommand">,
): SourceUpdatePlan;

export function getSourceUpdateFailure(error: unknown): SourceUpdateFailure | undefined;
export function assertCodexVersion(expected: string, environment: NodeJS.ProcessEnv, captureCommand?: SourceUpdateOptions["captureCommand"]): void;
export function validateCodexContract(checkout: string, environment: NodeJS.ProcessEnv, options: SourceUpdateOptions): void;
export function buildCheckout(checkout: string, environment: NodeJS.ProcessEnv, options: SourceUpdateOptions): Promise<void>;
export function packageVersion(checkout: string): string;
export function codexVersion(checkout: string): string;
export function isGatewayVersionCompatible(gatewayVersion: string, expectedCodexVersion: string): boolean;
export function getCodexVersionMismatchRemediation(error: unknown): string[];
export function writeSourceUpdateFailure(
  error: unknown,
  writeMessage?: SourceUpdateOptions["writeMessage"],
): void;
