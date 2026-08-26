export type PrivateFileLock = typeof import("../runtime/private-file-lock.mjs")
  .withPrivateFileLock;

export function withModelProviderManagementTransaction<T>(
  environment: NodeJS.ProcessEnv,
  operation: () => T | Promise<T>,
  options?: { withFileLock?: PrivateFileLock },
): Promise<T>;
