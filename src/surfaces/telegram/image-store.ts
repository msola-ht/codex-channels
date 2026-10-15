import type { Logger } from "pino";

import {
  ManagedImageStore,
  maximumManagedImageBytes,
  type StoredManagedImage,
} from "../managed-image-store.js";
import { telegramErrorMetadata } from "./error-metadata.js";
import {
  createTelegramFileDownloader,
  resolveTelegramFileUrl,
  TelegramFileLocationError,
  type TelegramFileApi,
  type TelegramFileDownloader,
  type TelegramFileDownloadResponse,
} from "./file-download.js";
export const maximumTelegramImageBytes = maximumManagedImageBytes;

const defaultRetentionMs = 24 * 60 * 60 * 1000;

export type { TelegramFileApi } from "./file-download.js";
export type ImageDownloadResponse = TelegramFileDownloadResponse;
export type ImageDownloader = TelegramFileDownloader;

export type StoredTelegramImage = StoredManagedImage;

export class TelegramImageStore {
  private readonly downloader: ImageDownloader;
  private readonly storage: ManagedImageStore;

  constructor(
    directory: string,
    private readonly token: string,
    proxyUrl: string | undefined,
    private readonly logger: Logger,
    retentionMs = defaultRetentionMs,
    downloader?: ImageDownloader,
  ) {
    this.downloader = downloader ?? createTelegramFileDownloader(proxyUrl);
    this.storage = new ManagedImageStore(
      directory,
      (error) => this.logCleanupFailure(error),
      retentionMs,
    );
  }

  async start(): Promise<void> {
    await this.storage.start();
  }

  close(): void {
    this.storage.close();
  }

  async download(api: TelegramFileApi, fileId: string, signal?: AbortSignal): Promise<StoredTelegramImage> {
    return this.storage.store(async (downloadSignal) => {
      let url: URL;
      try {
        url = await resolveTelegramFileUrl(api, fileId, this.token, downloadSignal);
      } catch (error) {
        if (
          error instanceof TelegramFileLocationError
          && error.code === "invalid-path"
        ) {
          throw new Error("Telegram 返回了无效的图片路径", { cause: error });
        }
        throw new Error("无法从 Telegram 获取图片下载信息", { cause: error });
      }
      return await this.downloader(url, downloadSignal);
    }, signal);
  }

  private logCleanupFailure(error: unknown): void {
    this.logger.warn(
      telegramErrorMetadata(error),
      "清理过期 Telegram 图片失败",
    );
  }
}
