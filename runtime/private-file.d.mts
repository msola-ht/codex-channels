export function readPrivateFileSync(
  path: string,
  maximumBytes?: number,
): string;

export function writePrivateFileAtomicSync(
  path: string,
  content: string | Uint8Array,
): void;

export function writePrivateFileAtomic(
  path: string,
  content: string | Uint8Array,
): Promise<void>;

export function securePrivateFileSync(path: string): void;

export function securePrivateDirectorySync(path: string): void;

export function assertPrivateDirectoryAccessSync(path: string): void;

export function assertPrivateFileAccessSync(path: string): void;

export function assertPrivateConfigAccessSync(configPath: string): void;
