import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { UserFacingError } from "../../conversation-core/index.js";
import { ManagedImageStore, maximumManagedImageBytes, type StoredManagedImage } from "../managed-image-store.js";
import { isSupportedQqAttachmentUrl } from "./media-download.js";

export interface QqImageReference {
  url: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif";
  size?: number;
}

/** Platform transfer only; shared storage verifies private files, signatures and byte limits. */
export class QqImageStore {
  private readonly storage: ManagedImageStore;
  constructor(directory: string, private readonly fetchImpl: typeof fetch,
    private readonly cleanupFailure: () => void) {
    this.storage = new ManagedImageStore(directory, cleanupFailure);
  }
  start(): Promise<void> { return this.storage.start(); }
  close(): void { this.storage.close(); }

  async download(reference: QqImageReference, signal: AbortSignal, beforeDownload: () => void): Promise<StoredManagedImage> {
    if (!isSupportedQqAttachmentUrl(reference.url)) {
      throw new UserFacingError("image.unsupported", "QQ 图片下载地址不受支持，当前消息未提交。");
    }
    if (reference.size !== undefined && reference.size > maximumManagedImageBytes) {
      throw new UserFacingError("image.too-large", "图片超过 10 MiB 限制");
    }
    try {
      const image = await this.storage.store(async downloadSignal => {
        downloadSignal.throwIfAborted();
        beforeDownload();
        const response = await this.fetchImpl(reference.url, { signal: downloadSignal, redirect: "manual" });
        try {
          downloadSignal.throwIfAborted();
          beforeDownload();
          if (response.status !== 200 || !response.body) throw new Error("QQ 图片下载未成功");
          const rawLength = response.headers.get("content-length");
          const contentLength = rawLength === null ? undefined : Number(rawLength);
          if (rawLength !== null && (!/^\d+$/u.test(rawLength) || !Number.isSafeInteger(contentLength))) {
            throw new Error("QQ 图片长度无效");
          }
          return { stream: Readable.fromWeb(response.body as unknown as ReadableStream<Uint8Array>),
            ...(contentLength === undefined ? {} : { contentLength }) };
        } catch (error) {
          await response.body?.cancel().catch(() => {});
          throw error;
        }
      }, signal);
      if (image.mimeType !== reference.mimeType || (reference.size !== undefined && image.bytes !== reference.size)) {
        await this.discard(image);
        throw new UserFacingError("image.unsupported", "QQ 图片类型或长度与附件信息不符，当前消息未提交。");
      }
      return image;
    } catch (error) {
      if (error instanceof UserFacingError && error.code === "image.unsupported") {
        throw new UserFacingError("image.unsupported", "QQ 图片格式或附件信息无效；仅支持 PNG、JPEG 和非动画 GIF，当前消息未提交。");
      }
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError("image.unavailable", signal.aborted
        ? "QQ 图片输入已取消或超时，当前消息未提交。" : "QQ 图片下载或暂存失败，当前消息未提交。");
    }
  }

  async discard(image: StoredManagedImage): Promise<void> {
    // App Server receives inline bytes, never this temporary path.
    await unlink(image.path).catch(() => this.cleanupFailure());
  }
}
