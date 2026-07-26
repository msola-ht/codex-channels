import type { Logger } from "pino";

import { UserFacingError } from "../../conversation-core/index.js";
import {
  ManagedImageStore,
  maximumManagedImageBytes,
  type ManagedImageSource,
  type StoredManagedImage,
} from "../managed-image-store.js";

export const maximumFeishuImageBytes = maximumManagedImageBytes;

export function isSafeFeishuResourceIdentifier(value: string): boolean {
  if (
    value.length === 0
    || value.length > 1_024
    || value.includes("/")
    || value.includes("\\")
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) {
      return false;
    }
  }
  return true;
}

export interface FeishuImageResourcePort {
  downloadImage(
    messageId: string,
    imageKey: string,
  ): Promise<ManagedImageSource>;
}

export interface FeishuImagePort {
  start(): Promise<void>;
  close(): void;
  download(messageId: string, imageKey: string): Promise<StoredManagedImage>;
}

export class FeishuImageStore implements FeishuImagePort {
  private readonly storage: ManagedImageStore;
  private startPromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    directory: string,
    private readonly resources: FeishuImageResourcePort,
    logger: Logger,
  ) {
    this.storage = new ManagedImageStore(
      directory,
      () => {
        logger.warn("清理过期飞书图片失败");
      },
    );
  }

  start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("飞书图片暂存器已经关闭"));
    }
    this.startPromise ??= this.storage.start();
    return this.startPromise;
  }

  close(): void {
    this.closed = true;
    this.storage.close();
  }

  async download(
    messageId: string,
    imageKey: string,
  ): Promise<StoredManagedImage> {
    if (this.closed) {
      throw new Error("飞书图片暂存器已经关闭");
    }
    await this.start();
    let source: ManagedImageSource;
    try {
      source = await this.resources.downloadImage(messageId, imageKey);
    } catch {
      throw new Error("下载飞书图片失败");
    }
    try {
      return await this.storage.store(source);
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw error;
      }
      // SDK 下载流或文件异常可能包含凭据、响应正文和本机路径。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("保存飞书图片失败");
    }
  }
}
