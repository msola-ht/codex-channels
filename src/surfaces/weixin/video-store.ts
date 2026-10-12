import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { UserFacingError } from "../../conversation-core/index.js";
import { VideoAttachmentStore, maximumVideoAttachmentBytes, type PreparedVideoAttachment, type VideoAttachmentScope } from "../video-attachment-store.js";
import { downloadWeixinCdnBytes, resolveWeixinCdnUrl } from "./cdn-download.js";
import { decryptWeixinMedia, parseWeixinMediaAesKey } from "./media-crypto.js";
import type { WeixinFileReference, WeixinVideoReference } from "./protocol-types.js";

export class WeixinVideoStore {
  private readonly storage: VideoAttachmentStore;
  private readonly controller = new AbortController();
  private active = 0;
  private readonly downloads = new Set<Promise<PreparedVideoAttachment>>();

  constructor(directory: string, onCleanupFailure: (error: unknown) => void, private readonly fetchImpl: typeof fetch = fetch) {
    this.storage = new VideoAttachmentStore(directory, "weixin", onCleanupFailure);
  }

  start(): Promise<void> { return this.storage.start(); }
  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.downloads]);
    await this.storage.close();
  }
  discard(file: PreparedVideoAttachment): Promise<void> { return this.storage.discard(file); }
  retain(file: PreparedVideoAttachment): void { this.storage.retain(file); }

  download(reference: WeixinVideoReference | WeixinFileReference, scope: VideoAttachmentScope, inputSignal?: AbortSignal): Promise<PreparedVideoAttachment> {
    const task = this.downloadOnce(reference, scope, inputSignal);
    this.downloads.add(task);
    void task.finally(() => this.downloads.delete(task)).catch(() => undefined);
    return task;
  }

  private async downloadOnce(reference: WeixinVideoReference | WeixinFileReference, scope: VideoAttachmentScope, inputSignal?: AbortSignal): Promise<PreparedVideoAttachment> {
    const signal = inputSignal ? AbortSignal.any([inputSignal, this.controller.signal]) : this.controller.signal;
    if (this.active >= 2 || signal.aborted) throw new UserFacingError("video.unavailable", "视频接收已停止或繁忙");
    this.active++;
    try {
      signal.throwIfAborted();
      const isFile = "fileName" in reference;
      const limit = maximumVideoAttachmentBytes + 16;
      const tooLarge = () => new UserFacingError("video.too-large", "视频超过 64 MiB 限制");
      if (!isFile && reference.encryptedBytes !== undefined && reference.encryptedBytes > limit) throw tooLarge();
      if (!isFile && !reference.mediaAesKey) throw new Error("missing key");
      let declaredLength: number | undefined;
      if (isFile && reference.declaredLength !== undefined) {
        if (!/^(0|[1-9]\d{0,15})$/u.test(reference.declaredLength)) throw new Error("invalid length");
        declaredLength = Number(reference.declaredLength);
        if (!Number.isSafeInteger(declaredLength)) throw new Error("invalid length");
        if (declaredLength > maximumVideoAttachmentBytes) throw tooLarge();
      }
      const key = reference.mediaAesKey === undefined ? undefined : parseWeixinMediaAesKey(reference.mediaAesKey);
      const encrypted = await downloadWeixinCdnBytes({ fetchImpl: this.fetchImpl,
        url: resolveWeixinCdnUrl(reference), maximumBytes: key ? limit : maximumVideoAttachmentBytes, tooLarge, signal });
      signal.throwIfAborted();
      if (!isFile && reference.encryptedBytes !== undefined && encrypted.length !== reference.encryptedBytes) throw new Error("invalid encrypted length");
      const bytes = key ? decryptWeixinMedia(encrypted, key) : encrypted;
      if (bytes.length > maximumVideoAttachmentBytes) throw tooLarge();
      if (declaredLength !== undefined && declaredLength !== bytes.length) throw new Error("invalid plaintext length");
      if (isFile && reference.declaredMd5 !== undefined) {
        if (!/^[a-f0-9]{32}$/iu.test(reference.declaredMd5)
          || createHash("md5").update(bytes).digest("hex") !== reference.declaredMd5.toLowerCase()) throw new Error("invalid checksum");
      }
      return await this.storage.store({ stream: Readable.from([bytes]), contentLength: bytes.length }, scope, signal);
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      // CDN URLs and encryption keys must never cross the channel boundary.
      throw new UserFacingError("video.unavailable", "微信视频下载、解密或完整性校验失败，请重新发送");
    } finally { this.active--; }
  }
}
