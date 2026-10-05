import type { SourceUpdateOptions } from "./source-update.mjs";
import type { DatabaseInspection } from "./local-installation.mjs";

export type LocalSourceDeploymentStage = "validate-candidate" | "build-candidate" | "validate-codex-contract" | "inspect-candidate" | "prepare-packages" | "stop-services" | "install-package" | "validate-databases" | "restore-services" | "verify-deployment" | "recover-deployment";
export interface LocalSourceDeploymentRecovery {
  status: "not-needed" | "restored" | "stopped" | "failed";
  package?: "candidate" | "previous";
  restoredServices: string[];
  errors: string[];
}
export interface LocalSourceDeploymentResult {
  version?: string;
  previousVersion?: string;
  packageSha256?: string;
  restoredServices: string[];
  recovery?: LocalSourceDeploymentRecovery;
}
export interface LocalSourceDeploymentFailure {
  stage: LocalSourceDeploymentStage;
  summary: string;
  recovery: LocalSourceDeploymentRecovery;
  errors: string[];
}
export interface LocalSourceDeploymentProgress {
  status: "started" | "completed";
  version?: string;
  previousVersion?: string;
  restoredServices: string[];
  recovery?: LocalSourceDeploymentRecovery;
  failedStage?: LocalSourceDeploymentStage;
}
export interface LocalSourceDeploymentInspection {
  config: { configPath: string };
  services: { installed: boolean };
  databases: {
    state: DatabaseInspection;
    metrics: DatabaseInspection;
    sessionDisplayCache: DatabaseInspection;
  };
}
export interface LocalSourceDeploymentService {
  target: "app-server" | "gateway" | "webui" | "model-relay";
  running: boolean;
  loaded: boolean;
  state: string;
}
export type PackageManifestEntry = { path: string; kind: "directory" } | { path: string; kind: "link"; target: string } | { path: string; kind: "file"; sha256: string; executable: boolean };
export interface PreparedLocalSourcePackage {
  tarball: string;
  sha256: string;
  manifestPath: string;
  manifestSha256: string;
  version: string;
}
export interface LocalSourceDeploymentOptions {
  jobDirectory: string;
  sourceDirectory: string;
  runnerDirectory: string;
  installedDirectory: string;
  npmPrefix: string;
  nodeBinary?: string;
  environment?: NodeJS.ProcessEnv;
  onProgress?: (stage: LocalSourceDeploymentStage, details: LocalSourceDeploymentProgress) => void | Promise<void>;
  platform?: NodeJS.Platform;
  executeCommand?: (command: string, args: string[], options: { cwd: string; environment: NodeJS.ProcessEnv; timeoutMs: number }) => string;
  buildCandidate?: (directory: string, environment: NodeJS.ProcessEnv, options: SourceUpdateOptions) => void | Promise<void>;
  validateContract?: (directory: string, environment: NodeJS.ProcessEnv, options: SourceUpdateOptions) => void | Promise<void>;
  inspectPackage?: (directory: string, environment: NodeJS.ProcessEnv) => LocalSourceDeploymentInspection | Promise<LocalSourceDeploymentInspection>;
  inspectServices?: (environment: NodeJS.ProcessEnv) => LocalSourceDeploymentService[] | Promise<LocalSourceDeploymentService[]>;
  inspectInvocationId?: (environment: NodeJS.ProcessEnv) => string | Promise<string>;
  verifyServiceExecutables?: (services: LocalSourceDeploymentService[], installedDirectory: string, nodeBinary: string, environment: NodeJS.ProcessEnv) => void | Promise<void>;
  serviceAction?: (action: "start" | "stop", target: string, directory: string, environment: NodeJS.ProcessEnv) => void | Promise<void>;
  preparePackage?: (context: LocalSourceDeploymentOptions, directory: string, label: "previous" | "candidate") => PreparedLocalSourcePackage | Promise<PreparedLocalSourcePackage>;
  installPackage?: (prepared: PreparedLocalSourcePackage, installedDirectory: string, environment: NodeJS.ProcessEnv) => void | Promise<void>;
}
export function deployLocalSource(options: LocalSourceDeploymentOptions): Promise<LocalSourceDeploymentResult>;
export function recoverLocalSource(options: LocalSourceDeploymentOptions): Promise<LocalSourceDeploymentResult>;
export function packageManifest(directory: string): PackageManifestEntry[];
