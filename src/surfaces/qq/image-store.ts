import type { Logger } from "pino";
import type { ConversationInput } from "../../application/index.js";
import { UserFacingError } from "../../conversation-core/index.js";
import { ManagedImageStore, maximumManagedImageBytes } from "../managed-image-store.js";
import { imageBatchLimitError, toInlineImage } from "../surface-input-batcher.js";
import type { QqInboundImage } from "./inbound.js";
import type { QqNetwork } from "./network.js";

/** Downloads only attachment metadata from an admitted QQ event, never message text URLs. */
export class QqImageStore {
  private readonly storage: ManagedImageStore;
  private readonly lifetime = new AbortController();
  private starting: Promise<void> | undefined;

  constructor(directory: string, private readonly download: QqNetwork["downloadAttachment"], logger: Logger) {
    this.storage = new ManagedImageStore(directory, () => logger.warn({ reason: "image-cleanup-failed" }, "QQ 图片暂存清理未确认"));
  }

  async prepare(images: readonly QqInboundImage[], text: string, signal: AbortSignal, assertAllowed: () => void): Promise<ConversationInput> {
    const current = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(30_000)]);
    current.throwIfAborted();
    const limits = imageBatchLimitError(images.map(image => image.size === undefined ? {} : { bytes: image.size }), 4, 20 * 1024 * 1024);
    if (limits) throw limits;
    const inline = [];
    try {
      assertAllowed();
      this.starting ??= this.storage.start();
      await waitForStart(this.starting, current);
      current.throwIfAborted();
      for (const image of images) {
        current.throwIfAborted();
        const stored = await this.storage.store(async downloadSignal => {
          const url = new URL(image.url);
          if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid-url");
          const response = await this.download(url, downloadSignal, assertAllowed);
          if (response.contentLength !== undefined && response.contentLength > maximumManagedImageBytes) {
            response.stream.destroy();
            throw new UserFacingError("image.too-large", "图片超过 10 MiB 限制");
          }
          return response;
        }, current);
        current.throwIfAborted();
        if (stored.mimeType !== image.contentType) throw new UserFacingError("image.type-mismatch", "图片内容与声明类型不一致");
        inline.push(await toInlineImage(stored));
        const error = imageBatchLimitError(inline, 4, 20 * 1024 * 1024);
        if (error) throw error;
      }
      current.throwIfAborted();
      assertAllowed();
      return { text, images: inline.map(({ url }) => ({ url })) };
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError("image.download-failed", "QQ 图片读取未确认，请重新发送图片", { reason: current.aborted ? "cancelled" : "download-failed" });
    }
  }

  close(): void {
    this.lifetime.abort();
    this.storage.close();
  }
}

function waitForStart(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("QQ 图片准备已取消"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
