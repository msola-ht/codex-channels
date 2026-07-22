import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";

import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

export const maximumTelegramImageBytes = 10 * 1024 * 1024;

const downloadTimeoutMs = 30_000;
const cleanupIntervalMs = 60 * 60 * 1000;
const defaultRetentionMs = 24 * 60 * 60 * 1000;

export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export interface ImageDownloadResponse {
  stream: Readable;
  contentLength?: number;
}

export type ImageDownloader = (url: URL) => Promise<ImageDownloadResponse>;

export interface StoredTelegramImage {
  path: string;
  mimeType: "image/jpeg" | "image/png";
  bytes: number;
}

export class TelegramImageStore {
  private cleanupTimer: NodeJS.Timeout | undefined;
  private readonly downloader: ImageDownloader;

  constructor(
    private readonly directory: string,
    private readonly token: string,
    proxyUrl: string | undefined,
    private readonly logger: Logger,
    private readonly retentionMs = defaultRetentionMs,
    downloader?: ImageDownloader,
  ) {
    this.downloader = downloader ?? createDownloader(proxyUrl);
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.cleanupExpired().catch((error) => this.logCleanupFailure(error));
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch((error) => this.logCleanupFailure(error));
    }, cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
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
    if (response.contentLength !== undefined && response.contentLength > maximumTelegramImageBytes) {
      response.stream.destroy();
      throw new Error("图片超过 10 MiB 限制");
    }
    return this.store(response.stream);
  }

  private async store(source: Readable): Promise<StoredTelegramImage> {
    const id = randomUUID();
    const temporaryPath = join(this.directory, `${id}.part`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maximumTelegramImageBytes) {
          callback(new Error("图片超过 10 MiB 限制"));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        source,
        limiter,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
      const imageType = await detectImageType(temporaryPath);
      if (!imageType) {
        throw new Error("仅支持 PNG 和 JPEG 图片");
      }
      const finalPath = join(this.directory, `${id}.${imageType.extension}`);
      await rename(temporaryPath, finalPath);
      return { path: finalPath, mimeType: imageType.mimeType, bytes };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof Error && /10 MiB|PNG 和 JPEG/.test(error.message)) {
        throw error;
      }
      throw new Error("保存 Telegram 图片失败");
    }
  }

  private async cleanupExpired(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const expiresBefore = Date.now() - this.retentionMs;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !/^[0-9a-f-]+\.(?:jpg|png|part)$/.test(entry.name)) {
        return;
      }
      const path = join(this.directory, entry.name);
      const metadata = await stat(path);
      if (metadata.mtimeMs < expiresBefore) {
        await unlink(path);
      }
    }));
  }

  private logCleanupFailure(error: unknown): void {
    this.logger.warn(
      { message: error instanceof Error ? error.message : String(error) },
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

async function detectImageType(path: string): Promise<{
  extension: "jpg" | "png";
  mimeType: "image/jpeg" | "image/png";
} | undefined> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return { extension: "jpg", mimeType: "image/jpeg" };
    }
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytesRead === png.length && header.equals(png)) {
      return { extension: "png", mimeType: "image/png" };
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
