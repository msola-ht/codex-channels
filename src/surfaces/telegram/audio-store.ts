import type { Logger } from "pino";

import { UserFacingError } from "../../conversation-core/index.js";
import {
  ManagedAudioStore,
  maximumManagedAudioBytes,
  type StoredManagedAudio,
} from "../managed-audio-store.js";
import { telegramErrorMetadata } from "./error-metadata.js";
import {
  createTelegramFileDownloader,
  resolveTelegramFileUrl,
  TelegramFileLocationError,
  type TelegramFileApi,
  type TelegramFileDownloader,
} from "./file-download.js";

export const maximumTelegramAudioBytes = maximumManagedAudioBytes;
export const maximumTelegramAudioDurationSeconds = 5 * 60;

export class TelegramAudioStore {
  private readonly downloader: TelegramFileDownloader;
  private readonly storage: ManagedAudioStore;

  constructor(
    directory: string,
    private readonly token: string,
    proxyUrl: string | undefined,
    logger: Logger,
    downloader?: TelegramFileDownloader,
  ) {
    this.downloader = downloader ?? createTelegramFileDownloader(proxyUrl);
    this.storage = new ManagedAudioStore(
      directory,
      (error) => logger.warn(
        telegramErrorMetadata(error),
        "清理过期 Telegram 音频失败",
      ),
    );
  }

  start(): Promise<void> {
    return this.storage.start();
  }

  close(): void {
    this.storage.close();
  }

  async download(
    api: TelegramFileApi,
    fileId: string,
  ): Promise<StoredManagedAudio> {
    let url: URL;
    try {
      url = await resolveTelegramFileUrl(api, fileId, this.token);
    } catch (error) {
      if (
        error instanceof TelegramFileLocationError
        && error.code === "invalid-path"
      ) {
        throw new Error("Telegram 返回了无效的音频路径", { cause: error });
      }
      throw new Error("无法从 Telegram 获取音频下载信息", { cause: error });
    }
    try {
      return await this.storage.store(await this.downloader(url));
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw error;
      }
      // 下载错误可能包含 Bot Token、远端响应或本机路径。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("保存 Telegram 音频失败");
    }
  }
}
