export interface SourceUninstallResult {
  checkout?: string;
  prefixes: string[];
}

export interface SourceUninstallOptions {
  projectDir?: string;
  uninstallServices?: (
    projectDir: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<void> | void;
  uninstallGlobalPackage?: (
    prefixes: string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<void> | void;
}

export function uninstallInstallation(
  environment?: NodeJS.ProcessEnv,
  options?: SourceUninstallOptions,
): Promise<SourceUninstallResult>;
