import type { Logger } from "pino";
import { finished } from "node:stream/promises";
import { UserFacingError } from "../../conversation-core/index.js";
import { TextAttachmentStore, prepareTextFile, type PreparedTextAttachment } from "../text-attachment-store.js";
import { formatTextFileDownloadFailed, formatTextFileTooLarge, formatUnsupportedTextFile } from "../text-file-copy.js";
import { maximumTextFileBytes, normalizeTextFileName, readBoundedTextFile, TextFileValidationError } from "../text-file-input.js";
import type { QqInboundFile } from "./inbound.js";
import type { QqNetwork } from "./network.js";

export interface QqTextFile extends PreparedTextAttachment {
  readonly fileName: string;
  readonly bytes: number;
}

/** Owns bounded UTF-8 downloads and private text staging for one QQ generation. */
export class QqFileInput {
  private readonly attachments: TextAttachmentStore;
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<QqTextFile>>();
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(directory: string, private readonly download: QqNetwork["downloadAttachment"], logger: Logger) {
    this.attachments = new TextAttachmentStore(directory,
      () => logger.warn({ reason: "text-cleanup-failed" }, "QQ 文本附件暂存清理未确认"));
  }

  prepare(file: QqInboundFile, signal: AbortSignal, assertAllowed: () => void): Promise<QqTextFile> {
    const task = this.prepareFile(file, signal, assertAllowed);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }

  private async prepareFile(file: QqInboundFile, signal: AbortSignal, assertAllowed: () => void): Promise<QqTextFile> {
    const current = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(30_000)]);
    try {
      current.throwIfAborted();
      assertAllowed();
      const fileName = normalizeTextFileName(file.filename, { maximumUtf8Bytes: 255 });
      if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maximumTextFileBytes)) {
        throw new TextFileValidationError("too-large");
      }
      this.starting ??= this.attachments.start();
      await waitForWork(this.starting, current);
      current.throwIfAborted();
      assertAllowed();
      const resource = await this.download(new URL(file.url), current, assertAllowed);
      const abort = () => resource.stream.destroy(new Error("QQ 文本附件准备已取消"));
      const streamClosed = finished(resource.stream, { cleanup: true }).catch(() => {});
      current.addEventListener("abort", abort, { once: true });
      try {
        if (current.aborted) { abort(); current.throwIfAborted(); }
        const length = resource.contentLength;
        if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw new Error("invalid-length");
        if (length !== undefined && length > maximumTextFileBytes) throw new TextFileValidationError("too-large");
        const bytes = await readBoundedTextFile(resource.stream);
        current.throwIfAborted();
        if (length !== undefined && length !== bytes.length || file.size !== undefined && file.size !== bytes.length) {
          throw new Error("length-mismatch");
        }
        assertAllowed();
        const prepared = await waitForWork(prepareTextFile(bytes, fileName, this.attachments), current);
        current.throwIfAborted();
        assertAllowed();
        // Keep complete staging for the shared 24-hour retention, including an
        // uncertain submission or cancellation after persistence.
        return prepared;
      } finally {
        current.removeEventListener("abort", abort);
        resource.stream.destroy();
        await streamClosed;
      }
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      if (error instanceof TextFileValidationError) {
        throw new UserFacingError(error.code === "too-large" ? "attachment.too-large"
          : error.code === "read-timeout" ? "attachment.download-failed" : "attachment.unsupported",
          error.code === "too-large" ? formatTextFileTooLarge("QQ") : formatUnsupportedTextFile("QQ", error.code), { reason: error.code });
      }
      throw new UserFacingError("attachment.download-failed", formatTextFileDownloadFailed("QQ"),
        { reason: current.aborted ? "cancelled" : "download-failed" });
    }
  }

  close(): Promise<void> {
    this.lifetime.abort();
    return this.closing ??= this.closeResources();
  }

  private async closeResources(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
    await this.starting?.catch(() => {});
    await this.attachments.close();
  }
}

function waitForWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("QQ 文本附件准备已取消"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
