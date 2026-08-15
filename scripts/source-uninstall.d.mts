export interface SourceUninstallResult {
  checkout: string;
  launcher: string;
}

export interface SourceUninstallOptions {
  projectDir?: string;
  uninstallServices?: (
    checkout: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<void> | void;
  uninstallGlobalPackage?: (
    prefixes: string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<void> | void;
}

export function uninstallManagedSourceInstallation(
  environment?: NodeJS.ProcessEnv,
  options?: SourceUninstallOptions,
): Promise<SourceUninstallResult>;
