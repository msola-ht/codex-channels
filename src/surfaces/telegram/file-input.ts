import { UserFacingError } from "../../conversation-core/index.js";
import { TextAttachmentStore, type PreparedTextAttachment } from "../text-attachment-store.js";
import {
  formatTextFileDownloadFailed,
  formatTextFileTooLarge,
  formatUnsupportedTextFile,
} from "../text-file-copy.js";
import {
  decodeUtf8TextFile,
  maximumTextFileBytes,
  normalizeTextFileName,
  readBoundedTextFile,
  TextFileValidationError,
  type TextFileValidationErrorCode,
} from "../text-file-input.js";
import {
  createTelegramFileDownloader,
  resolveTelegramFileUrl,
  type TelegramFileApi,
  type TelegramFileDownloader,
} from "./file-download.js";

export const maximumTelegramTextFileBytes = maximumTextFileBytes;

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

export interface TelegramTextFile extends PreparedTextAttachment {
  fileName: string;
  text: string;
  bytes: number;
}

export type TelegramTextFileDownloader = TelegramFileDownloader;

export interface TelegramTextFilePort {
  start?(): Promise<void>;
  close?(): Promise<void>;
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
    private readonly attachments?: TextAttachmentStore,
  ) {
    this.downloader = downloader ?? createTelegramFileDownloader(proxyUrl);
  }

  async start(): Promise<void> { await this.attachments?.start(); }
  async close(): Promise<void> { await this.attachments?.close(); }

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
      const content = await readBoundedTextFile(response.stream);
      const text = decodeUtf8TextFile(content);
      const prepared = this.attachments === undefined ? { text } : await this.attachments.prepare(text);
      return {
        fileName: normalizedName,
        ...prepared,
        bytes: content.length,
      };
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      if (error instanceof TelegramTextFileInputError) {
        throw error;
      }
      if (error instanceof TextFileValidationError) {
        throw error.code === "too-large" ? tooLarge() : validationFailure(error.code);
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
  return normalizeTextFileName(value, { maximumUtf8Bytes: 255 });
}

function tooLarge(): TelegramTextFileInputError {
  return new TelegramTextFileInputError(
    "too-large",
    formatTextFileTooLarge("Telegram"),
  );
}

function validationFailure(reason: TextFileValidationErrorCode): TelegramTextFileInputError {
  return new TelegramTextFileInputError(
    reason === "read-timeout" ? "download-failed" : "unsupported",
    formatUnsupportedTextFile("Telegram", reason),
  );
}
