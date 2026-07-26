import { get as httpsGet } from "node:https";
import { Readable } from "node:stream";

import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

import { UserFacingError } from "../../conversation-core/index.js";
import {
  ManagedImageStore,
  maximumManagedImageBytes,
  type StoredManagedImage,
} from "../managed-image-store.js";
import { telegramErrorMetadata } from "./error-metadata.js";
export const maximumTelegramImageBytes = maximumManagedImageBytes;

const downloadTimeoutMs = 30_000;
const defaultRetentionMs = 24 * 60 * 60 * 1000;

export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export interface ImageDownloadResponse {
  stream: Readable;
  contentLength?: number;
}

export type ImageDownloader = (url: URL) => Promise<ImageDownloadResponse>;

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
    this.downloader = downloader ?? createDownloader(proxyUrl);
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

  async download(api: TelegramFileApi, fileId: string): Promise<StoredTelegramImage> {
    let filePath: string | undefined;
    try {
      filePath = (await api.getFile(fileId)).file_path;
    } catch {
      throw new Error("无法从 Telegram 获取图片下载信息");
    }
    if (!filePath || !isSafeTelegramFilePath(filePath)) {
      throw new Error("Telegram 返回了无效的图片路径");
    }

    const url = new URL(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
    let response: ImageDownloadResponse;
    try {
      response = await this.downloader(url);
    } catch {
      throw new Error("连接 Telegram 图片服务器失败");
    }
    try {
      return await this.storage.store(response);
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw error;
      }
      // 原始下载异常可能包含 Bot Token、远端响应或本机路径，边界处必须脱敏。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("保存 Telegram 图片失败");
    }
  }

  private logCleanupFailure(error: unknown): void {
    this.logger.warn(
      telegramErrorMetadata(error),
      "清理过期 Telegram 图片失败",
    );
  }
}

function createDownloader(proxyUrl: string | undefined): ImageDownloader {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  return (url) => new Promise<ImageDownloadResponse>((resolve, reject) => {
    const request = httpsGet(url, { agent }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Telegram 图片服务器返回 HTTP ${response.statusCode ?? "unknown"}`));
        return;
      }
      const rawLength = response.headers["content-length"];
      const parsedLength = typeof rawLength === "string" ? Number(rawLength) : undefined;
      if (parsedLength !== undefined && Number.isSafeInteger(parsedLength) && parsedLength >= 0) {
        resolve({ stream: response, contentLength: parsedLength });
      } else {
        resolve({ stream: response });
      }
    });
    request.setTimeout(downloadTimeoutMs, () => request.destroy(new Error("Telegram 图片下载超时")));
    request.once("error", reject);
  });
}

function isSafeTelegramFilePath(value: string): boolean {
  return !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    /^[A-Za-z0-9._/-]+$/.test(value);
}
