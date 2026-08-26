export function withPrivateFileLock<T>(
  targetPath: string,
  operation: () => T | Promise<T>,
  options?: { label?: string; timeoutMs?: number },
): Promise<T>;
