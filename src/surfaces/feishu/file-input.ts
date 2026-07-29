import type { Readable } from "node:stream";

import {
  formatTextFileDownloadFailed,
  formatTextFileTooLarge,
  formatUnsupportedTextFile,
} from "../text-file-copy.js";
import { isSafeFeishuResourceIdentifier } from "./media.js";

export const maximumFeishuTextFileBytes = 1_000_000;

export type FeishuFileInputErrorCode =
  | "download-failed"
  | "too-large"
  | "unsupported";

export class FeishuFileInputError extends Error {
  constructor(readonly code: FeishuFileInputErrorCode, message: string) {
    super(message);
    this.name = "FeishuFileInputError";
  }
}

export interface FeishuTextFile {
  fileName: string;
  text: string;
  bytes: number;
}

export interface FeishuFileResourcePort {
  downloadFile(
    messageId: string,
    fileKey: string,
  ): Promise<{
    stream: Readable;
    contentLength?: number;
  }>;
}

export interface FeishuFilePort {
  download(
    messageId: string,
    fileKey: string,
    fileName: string,
  ): Promise<FeishuTextFile>;
}

export class FeishuFileInput implements FeishuFilePort {
  constructor(private readonly resources: FeishuFileResourcePort) {}

  async download(
    messageId: string,
    fileKey: string,
    fileName: string,
  ): Promise<FeishuTextFile> {
    try {
      if (
        !isSafeFeishuResourceIdentifier(messageId)
        || !isSafeFeishuResourceIdentifier(fileKey)
      ) {
        throw new Error("invalid Feishu file resource identifier");
      }
      const normalizedName = validateFeishuFileName(fileName);
      const resource = await this.resources.downloadFile(messageId, fileKey);
      if (
        resource.contentLength !== undefined
        && (
          !Number.isSafeInteger(resource.contentLength)
          || resource.contentLength < 0
          || resource.contentLength > maximumFeishuTextFileBytes
        )
      ) {
        resource.stream.destroy();
        throw tooLarge();
      }
      const content = await readBoundedFile(resource.stream);
      return {
        fileName: normalizedName,
        text: decodeUtf8Text(content),
        bytes: content.length,
      };
    } catch (error) {
      if (error instanceof FeishuFileInputError) {
        throw error;
      }
      // SDK 响应、资源标识、文件名和底层流异常不得越过飞书边界。
      throw new FeishuFileInputError(
        "download-failed",
        formatTextFileDownloadFailed("飞书"),
      );
    }
  }
}

export function isSafeFeishuFileName(value: string): boolean {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || Buffer.byteLength(normalized, "utf8") > 255
    || normalized === "."
    || normalized === ".."
  ) {
    return false;
  }
  for (const character of normalized) {
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

function validateFeishuFileName(value: string): string {
  const normalized = value.trim();
  if (!isSafeFeishuFileName(normalized)) {
    throw unsupportedFile();
  }
  return normalized;
}

async function readBoundedFile(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const candidate: unknown = chunk;
    if (!(candidate instanceof Uint8Array)) {
      stream.destroy();
      throw unsupportedFile();
    }
    const value = Buffer.from(candidate);
    bytes += value.length;
    if (bytes > maximumFeishuTextFileBytes) {
      stream.destroy();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, bytes);
}

function decodeUtf8Text(value: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw unsupportedFile();
  }
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (normalized.length === 0 || hasUnsupportedTextControl(normalized)) {
    throw unsupportedFile();
  }
  return normalized;
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

function tooLarge(): FeishuFileInputError {
  return new FeishuFileInputError(
    "too-large",
    formatTextFileTooLarge("飞书"),
  );
}

function unsupportedFile(): FeishuFileInputError {
  return new FeishuFileInputError(
    "unsupported",
    formatUnsupportedTextFile("飞书"),
  );
}
