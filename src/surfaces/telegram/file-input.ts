import type { Readable } from "node:stream";

import {
  formatTextFileDownloadFailed,
  formatTextFileTooLarge,
  formatUnsupportedTextFile,
} from "../text-file-copy.js";
import {
  createTelegramFileDownloader,
  resolveTelegramFileUrl,
  type TelegramFileApi,
  type TelegramFileDownloader,
} from "./file-download.js";

export const maximumTelegramTextFileBytes = 1_000_000;

export type TelegramTextFileInputErrorCode =
  | "download-failed"
  | "too-large"
  | "unsupported";

export class TelegramTextFileInputError extends Error {
  constructor(
    readonly code: TelegramTextFileInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TelegramTextFileInputError";
  }
}

export interface TelegramTextFile {
  fileName: string;
  text: string;
  bytes: number;
}

export type TelegramTextFileDownloader = TelegramFileDownloader;

export interface TelegramTextFilePort {
  download(
    api: TelegramFileApi,
    fileId: string,
    fileName: string,
  ): Promise<TelegramTextFile>;
}

export class TelegramTextFileInput implements TelegramTextFilePort {
  private readonly downloader: TelegramTextFileDownloader;

  constructor(
    private readonly token: string,
    proxyUrl: string | undefined,
    downloader?: TelegramTextFileDownloader,
  ) {
    this.downloader = downloader ?? createTelegramFileDownloader(proxyUrl);
  }

  async download(
    api: TelegramFileApi,
    fileId: string,
    fileName: string,
  ): Promise<TelegramTextFile> {
    try {
      const normalizedName = validateFileName(fileName);
      const url = await resolveTelegramFileUrl(api, fileId, this.token);
      const response = await this.downloader(
        url,
      );
      if (
        response.invalidContentLength === true
        || (
          response.contentLength !== undefined
        && (
          !Number.isSafeInteger(response.contentLength)
          || response.contentLength < 0
        )
        )
      ) {
        response.stream.destroy();
        throw new Error("invalid Telegram file length");
      }
      if (
        response.contentLength !== undefined
        && response.contentLength > maximumTelegramTextFileBytes
      ) {
        response.stream.destroy();
        throw tooLarge();
      }
      const content = await readBoundedFile(response.stream);
      return {
        fileName: normalizedName,
        text: decodeUtf8Text(content),
        bytes: content.length,
      };
    } catch (error) {
      if (error instanceof TelegramTextFileInputError) {
        throw error;
      }
      // Bot API、文件地址、下载流和正文异常不得越过 Telegram 边界。
      throw new TelegramTextFileInputError(
        "download-failed",
        formatTextFileDownloadFailed("Telegram"),
      );
    }
  }
}

function validateFileName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || Buffer.byteLength(normalized, "utf8") > 255
    || normalized === "."
    || normalized === ".."
    || hasInvalidFileNameCharacter(normalized)
  ) {
    throw unsupportedFile();
  }
  return normalized;
}

function hasInvalidFileNameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      character === "/"
      || character === "\\"
      || codePoint === undefined
      || codePoint <= 0x1f
      || codePoint === 0x7f
    ) {
      return true;
    }
  }
  return false;
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
    if (bytes > maximumTelegramTextFileBytes) {
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

function tooLarge(): TelegramTextFileInputError {
  return new TelegramTextFileInputError(
    "too-large",
    formatTextFileTooLarge("Telegram"),
  );
}

function unsupportedFile(): TelegramTextFileInputError {
  return new TelegramTextFileInputError(
    "unsupported",
    formatUnsupportedTextFile("Telegram"),
  );
}
