export interface SourceUpdateResult {
  changed: boolean;
  commit?: string;
  managed: boolean;
  previousVersion?: string;
  version?: string;
}

export type SourceUpdateStage =
  | "inspect"
  | "clone-candidate"
  | "validate-candidate"
  | "build-candidate"
  | "inspect-candidate"
  | "prepare-codex-cli"
  | "stop-services"
  | "switch-source"
  | "refresh-command"
  | "local-update"
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
  refreshCommand?: boolean;
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
    services: "not-needed" | "restored" | "failed" | "unknown";
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
  ) => Promise<void> | void;
  startServices?: (
    checkout: string,
    environment: NodeJS.ProcessEnv,
    options: SourceUpdateOptions,
  ) => Promise<void> | void;
  runLocalUpdate?: (
    checkout: string,
    environment: NodeJS.ProcessEnv,
    options: SourceUpdateOptions,
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

export function inspectManagedSourceUpdatePlan(
  environment?: NodeJS.ProcessEnv,
  options?: Pick<SourceUpdateOptions, "projectDir" | "repository" | "captureCommand">,
): SourceUpdatePlan;

export function getSourceUpdateFailure(error: unknown): SourceUpdateFailure | undefined;
export function getCodexVersionMismatchRemediation(error: unknown): string[];
export function writeSourceUpdateFailure(
  error: unknown,
  writeMessage?: SourceUpdateOptions["writeMessage"],
): void;
