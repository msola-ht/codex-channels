export function writePrivateFileAtomicSync(
  path: string,
  content: string | Uint8Array,
): void;

export function writePrivateFileAtomic(
  path: string,
  content: string | Uint8Array,
): Promise<void>;
