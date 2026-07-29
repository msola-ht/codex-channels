import type { Readable } from "node:stream";

import {
  formatTextFileDownloadFailed,
  formatTextFileTooLarge,
  formatUnsupportedTextFile,
} from "../text-file-copy.js";
import {
  decodeUtf8TextFile,
  isSafeTextFileName,
  maximumTextFileBytes,
  normalizeTextFileName,
  readBoundedTextFile,
  TextFileValidationError,
} from "../text-file-input.js";
import { isSafeFeishuResourceIdentifier } from "./media.js";

export const maximumFeishuTextFileBytes = maximumTextFileBytes;

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
      const content = await readBoundedTextFile(resource.stream);
      return {
        fileName: normalizedName,
        text: decodeUtf8TextFile(content),
        bytes: content.length,
      };
    } catch (error) {
      if (error instanceof FeishuFileInputError) {
        throw error;
      }
      if (error instanceof TextFileValidationError) {
        throw error.code === "too-large" ? tooLarge() : unsupportedFile();
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
  return isSafeTextFileName(value, { maximumUtf8Bytes: 255 });
}

function validateFeishuFileName(value: string): string {
  return normalizeTextFileName(value, { maximumUtf8Bytes: 255 });
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
