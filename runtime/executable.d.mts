export function effectiveCodexBinary(
  configuredBinary: string,
  environment?: NodeJS.ProcessEnv,
): string;

export function resolveExecutable(
  command: string,
  environment?: NodeJS.ProcessEnv,
): string;

export function resolveOptionalExecutable(
  command: string,
  environment?: NodeJS.ProcessEnv,
): string | undefined;

export interface ExecutableInvocation {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

export function executableInvocation(
  executable: string,
  args?: readonly string[],
  environment?: NodeJS.ProcessEnv,
): ExecutableInvocation;

export function resolveExecutableInvocation(
  command: string,
  args?: readonly string[],
  environment?: NodeJS.ProcessEnv,
): ExecutableInvocation;
