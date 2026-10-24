import { UserFacingError } from "../../conversation-core/index.js";
import { VideoAttachmentStore, maximumVideoAttachmentBytes, type PreparedVideoAttachment,
  type VideoAttachmentScope } from "../video-attachment-store.js";
import { downloadQqMedia, isSupportedQqAttachmentUrl } from "./media-download.js";

export interface QqVideoReference { url: string; size?: number }

export class QqVideoStore {
  private readonly storage: VideoAttachmentStore;
  private readonly cancellation = new AbortController();
  constructor(directory: string, private readonly fetchImpl: typeof fetch,
    cleanupFailure: () => void) {
    this.storage = new VideoAttachmentStore(directory, "qq", cleanupFailure);
  }
  start(): Promise<void> { return this.storage.start(); }
  close(): Promise<void> { this.cancellation.abort(); return this.storage.close(); }
  retain(file: PreparedVideoAttachment): void { this.storage.retain(file); }
  discard(file: PreparedVideoAttachment): Promise<void> { return this.storage.discard(file); }

  async download(reference: QqVideoReference, scope: VideoAttachmentScope, inputSignal: AbortSignal,
    current: () => void): Promise<PreparedVideoAttachment> {
    const signal = AbortSignal.any([inputSignal, this.cancellation.signal, AbortSignal.timeout(30_000)]);
    let file: PreparedVideoAttachment | undefined;
    let source: Awaited<ReturnType<typeof downloadQqMedia>> | undefined;
    try {
      if (!isSupportedQqAttachmentUrl(reference.url)) throw new UserFacingError("video.unsupported", "QQ 视频下载地址不受支持，当前消息未提交。");
      if (reference.size !== undefined && (!Number.isSafeInteger(reference.size) || reference.size < 1
        || reference.size > maximumVideoAttachmentBytes)) throw new UserFacingError("video.too-large", "QQ 视频必须为 1 字节至 64 MiB，当前消息未提交。");
      source = await downloadQqMedia(this.fetchImpl, reference.url, signal, current);
      source.stream.on("error", () => {});
      file = await this.storage.store(source, scope, signal);
      signal.throwIfAborted();
      current();
      if (!file.attachment.endsWith(".mp4") || reference.size !== undefined && file.bytes !== reference.size
        || source.contentLength !== undefined && file.bytes !== source.contentLength) {
        throw new UserFacingError("video.unsupported", "QQ 视频仅支持 MP4，内容类型或长度与附件信息不符，当前消息未提交。");
      }
      return file;
    } catch (error) {
      if (file) await this.discard(file);
      if (error instanceof UserFacingError && error.code === "video.unsupported") {
        throw new UserFacingError("video.unsupported", "QQ 视频仅支持 MP4 容器且类型和长度需与附件信息相符，当前消息未提交。");
      }
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError("video.unavailable", signal.aborted
        ? "QQ 视频输入已取消或超时，当前消息未提交。" : "QQ 视频下载或暂存失败，当前消息未提交。");
    } finally { source?.stream.destroy(); }
  }
}
