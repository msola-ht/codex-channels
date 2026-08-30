export function readWindowsSecureRecordSync(
  directory: string,
  key: string,
  environment?: NodeJS.ProcessEnv,
): string | null;

export function writeWindowsSecureRecordSync(
  directory: string,
  key: string,
  value: string,
  environment?: NodeJS.ProcessEnv,
): void;

export function removeWindowsSecureRecordSync(
  directory: string,
  key: string,
): void;

export function windowsSecureRecordPath(
  directory: string,
  key: string,
): string;
