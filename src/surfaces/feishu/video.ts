import type { Logger } from "pino";

import { UserFacingError } from "../../conversation-core/index.js";
import {
  VideoAttachmentStore,
  type PreparedVideoAttachment,
} from "../video-attachment-store.js";
import type { FeishuFileResourcePort } from "./file-input.js";
import { isSafeFeishuResourceIdentifier } from "./media.js";

export interface FeishuVideoPort {
  start(): Promise<void>;
  close(): Promise<void>;
  download(messageId: string, fileKey: string, signal?: AbortSignal): Promise<PreparedVideoAttachment>;
  discard(file: PreparedVideoAttachment): Promise<void>;
}

export class FeishuVideoStore implements FeishuVideoPort {
  private readonly storage: VideoAttachmentStore;
  private readonly cancellation = new AbortController();
  private ready = false;

  constructor(directory: string, private readonly resources: FeishuFileResourcePort, logger: Logger) {
    this.storage = new VideoAttachmentStore(directory, "feishu", () => logger.warn("清理过期飞书视频失败"));
  }

  async start(): Promise<void> {
    this.cancellation.signal.throwIfAborted();
    await this.storage.start();
    this.cancellation.signal.throwIfAborted();
    this.ready = true;
  }

  close(): Promise<void> {
    this.ready = false;
    this.cancellation.abort();
    return this.storage.close();
  }

  discard(file: PreparedVideoAttachment): Promise<void> {
    return this.storage.discard(file);
  }

  async download(messageId: string, fileKey: string, signal?: AbortSignal): Promise<PreparedVideoAttachment> {
    const cancellation = signal === undefined ? this.cancellation.signal : AbortSignal.any([this.cancellation.signal, signal]);
    if (!this.ready || cancellation.aborted) throw new UserFacingError("video.unavailable", "飞书视频输入尚未就绪或已停止");
    if (!isSafeFeishuResourceIdentifier(messageId) || !isSafeFeishuResourceIdentifier(fileKey)) {
      throw new UserFacingError("video.unavailable", "飞书视频资源无法识别");
    }
    try {
      const source = await this.resources.downloadFile(messageId, fileKey, cancellation);
      source.stream.on("error", () => {});
      if (!this.ready || cancellation.aborted) {
        source.stream.destroy();
        throw new UserFacingError("video.unavailable", "飞书视频输入已停止");
      }
      return await this.storage.store(source, cancellation);
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      // 平台响应、资源标识与流异常不越过飞书边界。
      throw new UserFacingError("video.unavailable", "飞书视频下载或暂存失败");
    }
  }
}
