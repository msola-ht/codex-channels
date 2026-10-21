export class PrivateFileLockReleaseError<T = unknown> extends Error {
  constructor(result: T, cause: unknown);
  readonly result: T;
}

export function withPrivateFileLock<T>(
  targetPath: string,
  operation: () => T | Promise<T>,
  options?: { label?: string; timeoutMs?: number },
): Promise<T>;
