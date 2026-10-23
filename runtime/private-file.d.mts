export class WindowsPrivatePathError extends Error {
  constructor(message: string);
}

export function readPrivateFileSync(
  path: string,
  maximumBytes?: number,
): string;

export function readPrivateConfigFile(
  path: string,
  options?: { signal?: AbortSignal; maximumBytes?: number },
): Promise<string>;

export class PrivateFileWriteCommittedError extends Error {
  constructor(cause: unknown);
}

export function writePrivateFileAtomicSync(
  path: string,
  content: string | Uint8Array,
): void;

export function writePrivateFileAtomic(
  path: string,
  content: string | Uint8Array,
  options?: { signal?: AbortSignal },
): Promise<void>;

export function securePrivateFileSync(path: string): void;
export function readCodexConfigFileSync(path: string, maximumBytes?: number): string;
export function assertCodexConfigAccessSync(path: string): void;
export function writeCodexConfigFileAtomic(path: string, content: string | Uint8Array, options?: { signal?: AbortSignal }): Promise<void>;
export function repairWindowsPrivateFileSync(path: string): void;

export function securePrivateDirectorySync(path: string): void;
export function securePrivateFile(path: string, options?: { signal?: AbortSignal }): Promise<void>;
export function securePrivateDirectory(path: string, options?: { signal?: AbortSignal }): Promise<void>;
export function assertPrivateDirectoryAccess(path: string, options?: { signal?: AbortSignal }): Promise<void>;
export function inspectPrivateDirectoryAccess(path: string, options?: { signal?: AbortSignal }): Promise<{ dev: number; ino: number }>;
export function inspectPrivateDirectoryAccessSync(path: string): { dev: number; ino: number };
export function secureAppServerSocketDirectorySync(path: string): void;

export function assertPrivateDirectoryAccessSync(path: string): void;
export function ensurePrivateDirectorySync(path: string): void;

export function assertPrivateFileAccessSync(path: string): void;

export function assertPrivateConfigAccessSync(configPath: string): void;
