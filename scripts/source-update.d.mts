export interface SourceUpdateResult {
  changed: boolean;
  commit?: string;
  managed: boolean;
  previousVersion?: string;
  version?: string;
}

export interface SourceUpdateOptions {
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
  renamePath?: (oldPath: string, newPath: string) => void;
}

export function managedSourceCheckout(
  environment?: NodeJS.ProcessEnv,
  projectDir?: string,
): string | undefined;

export function updateManagedSourceInstallation(
  environment?: NodeJS.ProcessEnv,
  options?: SourceUpdateOptions,
): Promise<SourceUpdateResult>;
