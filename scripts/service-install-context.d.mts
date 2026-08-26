export interface ServiceInstallContext {
  cliEntry: string;
  codexBinary: string;
  executablePath: string;
  nodeBinary: string;
  packageDir: string;
  runtime: { configPath: string; dataDir: string };
  runtimeDir: string;
  socketPath: string;
  workdir: string;
}

export function resolveServiceInstallContext(
  additionalPathEntries: string[],
  options?: {
    environment?: NodeJS.ProcessEnv;
    projectDir?: string;
    nodeExecutable?: string;
  },
): ServiceInstallContext;

export function ensureServiceInstallRuntimeDirectory(
  context: ServiceInstallContext,
): void;

export function prepareServiceInstallContext(
  additionalPathEntries: string[],
): ServiceInstallContext;
