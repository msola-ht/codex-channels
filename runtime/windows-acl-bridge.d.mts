export function closeWindowsAclBridge(options?: { timeoutMs?: number }): Promise<void>;
export function waitForWindowsAclBridgeExit(): Promise<void>;
export function withWindowsAclDeadline<T>(deadline: number, operation: () => T): T;
export function invokeWindowsAclSync(invocation: {
  file: string; args: string[]; windowsVerbatimArguments?: boolean;
}, input: unknown, maximumBytes: number): string;
export function invokeWindowsAcl(invocation: {
  file: string; args: string[]; windowsVerbatimArguments?: boolean;
}, input: unknown, maximumBytes: number, signal?: AbortSignal): Promise<string>;
