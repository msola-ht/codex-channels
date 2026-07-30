import type { Readable } from "node:stream";

export const maximumTextFileBytes = 1_000_000;

export type TextFileValidationErrorCode = "too-large" | "unsupported";

export class TextFileValidationError extends Error {
  constructor(readonly code: TextFileValidationErrorCode) {
    super("文本文件校验失败");
    this.name = "TextFileValidationError";
  }
}

export type TextFileNameLimit =
  | { maximumUtf8Bytes: number }
  | { maximumCodeUnits: number };

export function normalizeTextFileName(
  value: string,
  limit: TextFileNameLimit,
): string {
  const normalized = value.trim();
  if (!isNormalizedTextFileNameSafe(normalized, limit)) {
    throw new TextFileValidationError("unsupported");
  }
  return normalized;
}

export function isSafeTextFileName(
  value: string,
  limit: TextFileNameLimit,
): boolean {
  return isNormalizedTextFileNameSafe(value.trim(), limit);
}

export async function readBoundedTextFile(
  stream: Readable,
  maximumBytes = maximumTextFileBytes,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const candidate: unknown = chunk;
    if (!(candidate instanceof Uint8Array)) {
      stream.destroy();
      throw new TextFileValidationError("unsupported");
    }
    const value = Buffer.from(candidate);
    bytes += value.length;
    if (bytes > maximumBytes) {
      stream.destroy();
      throw new TextFileValidationError("too-large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes);
}

export function decodeUtf8TextFile(value: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new TextFileValidationError("unsupported");
  }
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (normalized.length === 0 || hasUnsupportedTextControl(normalized)) {
    throw new TextFileValidationError("unsupported");
  }
  return normalized;
}

function isNormalizedTextFileNameSafe(
  value: string,
  limit: TextFileNameLimit,
): boolean {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || ("maximumUtf8Bytes" in limit
      ? Buffer.byteLength(value, "utf8") > limit.maximumUtf8Bytes
      : value.length > limit.maximumCodeUnits)
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      character === "/"
      || character === "\\"
      || codePoint === undefined
      || codePoint <= 0x1f
      || codePoint === 0x7f
    ) {
      return false;
    }
  }
  return true;
}

function hasUnsupportedTextControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}
