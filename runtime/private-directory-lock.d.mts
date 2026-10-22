export class PrivateDirectoryLockBusyError extends Error {}

/** The synchronous operation returned; its result does not imply a file commit. */
export class PrivateDirectoryLockReleaseError<T = unknown> extends Error {
  constructor(result: T, cause: unknown);
  readonly result: T;
}

/** The caller owns creation and protection of the lock's parent directory. */
export function withPrivateDirectoryLockSync<T>(
  lockPath: string,
  operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T;
