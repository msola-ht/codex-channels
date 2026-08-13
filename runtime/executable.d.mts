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
