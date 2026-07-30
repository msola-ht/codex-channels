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
      const content = await readBoundedTextFile(response.stream);
      return {
        fileName: normalizedName,
        text: decodeUtf8TextFile(content),
        bytes: content.length,
      };
    } catch (error) {
      if (error instanceof TelegramTextFileInputError) {
        throw error;
      }
      if (error instanceof TextFileValidationError) {
        throw error.code === "too-large" ? tooLarge() : unsupportedFile();
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

function unsupportedFile(): TelegramTextFileInputError {
  return new TelegramTextFileInputError(
    "unsupported",
    formatUnsupportedTextFile("Telegram"),
  );
}
