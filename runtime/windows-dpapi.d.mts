export function protectForCurrentWindowsUserSync(
  value: Buffer,
  environment?: NodeJS.ProcessEnv,
): Buffer;

export function unprotectForCurrentWindowsUserSync(
  value: Buffer,
  environment?: NodeJS.ProcessEnv,
): Buffer;

export function protectForCurrentWindowsUser(
  value: Buffer,
  environment?: NodeJS.ProcessEnv,
  options?: { signal?: AbortSignal },
): Promise<Buffer>;

export function unprotectForCurrentWindowsUser(
  value: Buffer,
  environment?: NodeJS.ProcessEnv,
  options?: { signal?: AbortSignal },
): Promise<Buffer>;
