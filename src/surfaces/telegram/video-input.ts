import { Readable } from "node:stream";
import type { Logger } from "pino";

import { UserFacingError } from "../../conversation-core/index.js";
import {
  VideoAttachmentStore,
  type PreparedVideoAttachment,
} from "../video-attachment-store.js";
import { telegramErrorMetadata } from "./error-metadata.js";
import {
  createTelegramFileDownloader,
  resolveTelegramFileUrl,
  type TelegramFileApi,
  type TelegramFileDownloader,
} from "./file-download.js";

export const maximumTelegramVideoBytes = 20 * 1024 * 1024;
const videoDownloadTimeoutMs = 30_000;

export class TelegramVideoInput {
  private readonly storage: VideoAttachmentStore;
  private readonly downloader: TelegramFileDownloader;
  private readonly stopped = new AbortController();

  constructor(
    directory: string,
    private readonly token: string,
    proxyUrl: string | undefined,
    logger: Logger,
    downloader?: TelegramFileDownloader,
  ) {
    this.downloader = downloader ?? createTelegramFileDownloader(proxyUrl);
    this.storage = new VideoAttachmentStore(directory, "telegram", error => {
      logger.warn(telegramErrorMetadata(error), "清理 Telegram 视频附件失败");
    });
  }

  async start(): Promise<void> {
    this.stopped.signal.throwIfAborted();
    await this.storage.start();
    this.stopped.signal.throwIfAborted();
  }

  async close(): Promise<void> {
    this.stopped.abort();
    await this.storage.close();
  }

  discard(file: PreparedVideoAttachment): Promise<void> {
    return this.storage.discard(file);
  }

  async download(
    api: TelegramFileApi,
    fileId: string,
    fileSize: number | undefined,
    inputSignal?: AbortSignal,
  ): Promise<PreparedVideoAttachment> {
    validateSize(fileSize);
    const signal = AbortSignal.any([
      this.stopped.signal,
      AbortSignal.timeout(videoDownloadTimeoutMs),
      ...(inputSignal ? [inputSignal] : []),
    ]);
    signal.throwIfAborted();
    let source: Readable | undefined;
    let bounded: Readable | undefined;
    let sizeError: UserFacingError | undefined;
    try {
      const url = await resolveTelegramFileUrl({
        getFile: async (id, apiSignal) => {
          const file = await api.getFile(id, apiSignal);
          try {
            validateSize(file.file_size);
          } catch (error) {
            if (error instanceof UserFacingError) sizeError = error;
            throw error;
          }
          return file;
        },
      }, fileId, this.token, signal);
      signal.throwIfAborted();
      const response = await this.downloader(url, signal);
      source = response.stream;
      // 共享暂存可能排队；原始网络流提前失败时也必须有异常监听。
      // 异步迭代仍会读取该流保存的失败状态，关闭后的迟到错误不会失去监听。
      source.on("error", () => {});
      signal.throwIfAborted();
      if (response.invalidContentLength) {
        throw new Error("无效 Telegram 视频长度");
      }
      validateSize(response.contentLength);
      let bytes = 0;
      bounded = Readable.from((async function* () {
        for await (const chunk of response.stream) {
          signal.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) {
            throw new Error("无效 Telegram 视频数据");
          }
          bytes += chunk.byteLength;
          if (bytes > maximumTelegramVideoBytes) {
            sizeError = tooLarge();
            throw sizeError;
          }
          yield chunk;
        }
      })());
      const file = await this.storage.store({
        stream: bounded,
        ...(response.contentLength === undefined ? {} : { contentLength: response.contentLength }),
      }, signal);
      if (signal.aborted) {
        await this.storage.discard(file);
        signal.throwIfAborted();
      }
      return file;
    } catch (error) {
      if (sizeError !== undefined) throw sizeError;
      if (error instanceof UserFacingError) throw error;
      // 下载错误可能包含 Bot Token 或远端响应，只放行固定文案。
      throw new UserFacingError("video.unavailable", "Telegram 视频下载失败，请重新发送。");
    } finally {
      bounded?.destroy();
      source?.destroy();
    }
  }
}

function validateSize(bytes: number | undefined): void {
  if (bytes === undefined) return;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new UserFacingError("video.unavailable", "Telegram 视频大小无效，请重新发送。");
  }
  if (bytes > maximumTelegramVideoBytes) throw tooLarge();
}

function tooLarge(): UserFacingError {
  return new UserFacingError("video.too-large", "Telegram 视频超过 20 MiB 限制。");
}
