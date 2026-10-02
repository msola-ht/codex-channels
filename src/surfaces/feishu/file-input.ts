import { UserFacingError } from "../../conversation-core/index.js";
import { TextAttachmentStore, type PreparedTextAttachment } from "../text-attachment-store.js";
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
  type TextFileValidationErrorCode,
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

export interface FeishuTextFile extends PreparedTextAttachment {
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
  discard?(file: FeishuTextFile): Promise<void>;
  start?(): Promise<void>;
  close?(): Promise<void>;
  download(
    messageId: string,
    fileKey: string,
    fileName: string,
  ): Promise<FeishuTextFile>;
}

export class FeishuFileInput implements FeishuFilePort {
  constructor(private readonly resources: FeishuFileResourcePort, private readonly attachments?: TextAttachmentStore) {}

  async discard(file: FeishuTextFile): Promise<void> { await this.attachments?.discard(file); }

  async start(): Promise<void> { await this.attachments?.start(); }
  async close(): Promise<void> { await this.attachments?.close(); }

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
        )
      ) {
        resource.stream.destroy();
        throw new Error("invalid Feishu file length");
      }
      if (resource.contentLength !== undefined && resource.contentLength > maximumFeishuTextFileBytes) {
        resource.stream.destroy();
        throw tooLarge();
      }
      const content = await readBoundedTextFile(resource.stream);
      const text = decodeUtf8TextFile(content);
      const prepared = this.attachments === undefined ? { text } : await this.attachments.prepare(text);
      return {
        fileName: normalizedName,
        ...prepared,
        bytes: content.length,
      };
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      if (error instanceof FeishuFileInputError) {
        throw error;
      }
      if (error instanceof TextFileValidationError) {
        throw error.code === "too-large" ? tooLarge() : validationFailure(error.code);
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

function validationFailure(reason: TextFileValidationErrorCode): FeishuFileInputError {
  return new FeishuFileInputError(
    reason === "read-timeout" ? "download-failed" : "unsupported",
    formatUnsupportedTextFile("飞书", reason),
  );
}
