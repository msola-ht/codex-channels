import { UserFacingError } from "../../conversation-core/index.js";
import { prepareTextFile, TextAttachmentStore, type PreparedTextAttachment } from "../text-attachment-store.js";
import type { Readable } from "node:stream";

import {
  formatTextFileDownloadFailed,
  formatTextFileTooLarge,
  formatUnsupportedTextFile,
} from "../text-file-copy.js";
import {
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
    signal?: AbortSignal,
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
    signal?: AbortSignal,
  ): Promise<FeishuTextFile>;
}

export class FeishuFileInput implements FeishuFilePort {
  private readonly cancellation = new AbortController();
  constructor(private readonly resources: FeishuFileResourcePort, private readonly attachments?: TextAttachmentStore) {}

  async discard(file: FeishuTextFile): Promise<void> { await this.attachments?.discard(file); }

  async start(): Promise<void> { await this.attachments?.start(); }
  async close(): Promise<void> {
    this.cancellation.abort();
    await this.attachments?.close();
  }

  async download(
    messageId: string,
    fileKey: string,
    fileName: string,
    inputSignal?: AbortSignal,
  ): Promise<FeishuTextFile> {
    const signal = inputSignal === undefined ? this.cancellation.signal
      : AbortSignal.any([inputSignal, this.cancellation.signal]);
    let file: FeishuTextFile | undefined;
    let stream: Readable | undefined;
    const abort = () => stream?.destroy(new Error("飞书文本文件输入已取消"));
    try {
      signal.throwIfAborted();
      if (
        !isSafeFeishuResourceIdentifier(messageId)
        || !isSafeFeishuResourceIdentifier(fileKey)
      ) {
        throw new Error("invalid Feishu file resource identifier");
      }
      const normalizedName = validateFeishuFileName(fileName);
      const resource = await this.resources.downloadFile(messageId, fileKey, signal);
      stream = resource.stream;
      stream.on("error", () => {});
      signal.addEventListener("abort", abort, { once: true });
      signal.throwIfAborted();
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
      signal.throwIfAborted();
      file = await prepareTextFile(content, normalizedName, this.attachments);
      signal.throwIfAborted();
      return file;
    } catch (error) {
      if (file !== undefined) await this.discard(file);
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
    } finally {
      signal.removeEventListener("abort", abort);
      stream?.destroy();
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
