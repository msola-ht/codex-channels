export interface UpdateJob {
  formatVersion: 1;
  id: string;
  createdAt: string;
  originalSourceDirectory: string;
  sourceCommit: string;
  snapshotSha256: string;
  installedDirectory: string;
  npmPrefix: string;
  nodeBinary: string;
  environment: Record<string, string>;
  unitName: string;
}

export interface UpdateResult {
  version?: string;
  previousVersion?: string;
  packageSha256?: string;
  restoredServices?: string[];
  recovery?: {
    status: "not-needed" | "restored" | "failed" | "stopped";
    restoredServices: string[];
    errors: string[];
    package?: "candidate" | "previous";
  };
}

export interface UpdateReceipt {
  formatVersion: 1;
  id: string;
  updatedAt: string;
  status: "queued" | "running" | "succeeded" | "failed" | "recovery-required";
  stage: string;
  result?: UpdateResult;
  error?: string;
}

export type BackgroundUpdateJob = UpdateJob;
export type BackgroundUpdateReceipt = UpdateReceipt;

export function updateRoot(environment?: NodeJS.ProcessEnv): string;
export function assertUpdateId(id: string): string;
export function updateJobDirectory(root: string, id: string): string;
export function createUpdateDirectory(root: string, id?: string): string;
export function writeUpdateJob(root: string, job: UpdateJob): void;
export function readUpdateJob(root: string, id: string): UpdateJob;
export function writeUpdateReceipt(root: string, id: string, receipt: UpdateReceipt): void;
export function readUpdateReceipt(root: string, id: string): UpdateReceipt;
export function listUpdateJobIds(root: string): string[];
export function readActiveUpdate(root: string): string | undefined;
export function reserveUpdate(root: string, id: string): void;
export function releaseUpdate(root: string, id: string): void;
export function withUpdateLock<T>(root: string, callback: () => Promise<T> | T): Promise<T>;
export function snapshotLocalSource(source: string, destination: string): {
  sourcePath: string;
  sourceCommit: string;
  snapshotSha256: string;
};
export function copyUpdateRunner(installedPackage: string, destination: string): string;
