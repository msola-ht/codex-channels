import type { Logger } from "pino";

import { UserFacingError } from "../../conversation-core/index.js";
import {
  ManagedAudioStore,
  maximumManagedAudioBytes,
  type ManagedAudioSource,
  type StoredManagedAudio,
} from "../managed-audio-store.js";
import { isSafeFeishuResourceIdentifier } from "./media.js";

export const maximumFeishuAudioBytes = maximumManagedAudioBytes;
export const maximumFeishuAudioDurationMs = 5 * 60 * 1000;

export interface FeishuAudioResourcePort {
  downloadAudio(messageId: string, fileKey: string): Promise<ManagedAudioSource>;
}

export interface FeishuAudioPort {
  start(): Promise<void>;
  close(): void;
  download(messageId: string, fileKey: string): Promise<StoredManagedAudio>;
}

export class FeishuAudioStore implements FeishuAudioPort {
  private readonly storage: ManagedAudioStore;

  constructor(
    directory: string,
    private readonly resources: FeishuAudioResourcePort,
    logger: Logger,
  ) {
    this.storage = new ManagedAudioStore(
      directory,
      () => logger.warn("清理过期飞书音频失败"),
    );
  }

  start(): Promise<void> {
    return this.storage.start();
  }

  close(): void {
    this.storage.close();
  }

  async download(messageId: string, fileKey: string): Promise<StoredManagedAudio> {
    if (
      !isSafeFeishuResourceIdentifier(messageId)
      || !isSafeFeishuResourceIdentifier(fileKey)
    ) {
      throw new Error("飞书音频资源标识无效");
    }
    try {
      return await this.storage.store(
        await this.resources.downloadAudio(messageId, fileKey),
      );
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw error;
      }
      // SDK 响应和底层流错误不得越过飞书边界。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("保存飞书音频失败");
    }
  }
}
