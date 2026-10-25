import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const maximumChannelFileBytes = 5_000_000;

export class LocalFileError extends Error {
  constructor(readonly code: "invalid-path" | "invalid-file" | "too-large" | "invalid-name") {
    super("本机文件无法安全读取");
    this.name = "LocalFileError";
  }
}

export function assertChannelFileName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value === "." || value === ".."
    || Buffer.byteLength(value) > 255 || /[/\\\p{Cc}\p{Cf}\uD800-\uDFFF]/u.test(value)) {
    throw new LocalFileError("invalid-name");
  }
}

/** One bounded snapshot of a regular, non-link file. No unbounded readFile. */
export async function readBoundedLocalFile(path: string, maximumBytes: number): Promise<Buffer> {
  if (typeof path !== "string" || !isAbsolute(path) || !path || path.length > 4096 || path.includes("\0")
    || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new LocalFileError("invalid-path");
  let file;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new LocalFileError("invalid-file");
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    const same = (value: typeof stat): boolean => value.isFile() && !value.isSymbolicLink()
      && value.dev === stat.dev && value.ino === stat.ino && value.size === stat.size
      && value.mtimeMs === stat.mtimeMs && value.ctimeMs === stat.ctimeMs;
    if (!same(before) || !same(await lstat(path)) || stat.size <= 0) throw new LocalFileError("invalid-file");
    if (stat.size > maximumBytes) throw new LocalFileError("too-large");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new LocalFileError("too-large");
    if (length !== stat.size || !same(await file.stat()) || !same(await lstat(path))) {
      throw new LocalFileError("invalid-file");
    }
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof LocalFileError) throw error;
    throw new LocalFileError("invalid-file");
  } finally {
    await file?.close();
  }
}
