import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { UserFacingError } from "../conversation-core/index.js";

export const maximumManagedImageBytes = 10 * 1024 * 1024;

const cleanupIntervalMs = 60 * 60 * 1000;
const defaultRetentionMs = 24 * 60 * 60 * 1000;

export interface ManagedImageSource {
  stream: Readable;
  contentLength?: number;
}

export interface StoredManagedImage {
  path: string;
  mimeType: "image/jpeg" | "image/png";
  bytes: number;
}

export class ManagedImageStore {
  private cleanupTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly onCleanupFailure: (error: unknown) => void,
    private readonly retentionMs = defaultRetentionMs,
  ) {}

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error("图片暂存器已经关闭");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.cleanupExpired().catch(this.onCleanupFailure);
    if (this.closed) {
      return;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch(this.onCleanupFailure);
    }, cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  async store(source: ManagedImageSource): Promise<StoredManagedImage> {
    if (
      source.contentLength !== undefined
      && source.contentLength > maximumManagedImageBytes
    ) {
      source.stream.destroy();
      throw new UserFacingError("image.too-large", "图片超过 10 MiB 限制");
    }

    const id = randomUUID();
    const temporaryPath = join(this.directory, `${id}.part`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maximumManagedImageBytes) {
          callback(new UserFacingError("image.too-large", "图片超过 10 MiB 限制"));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        source.stream,
        limiter,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
      const imageType = await detectImageType(temporaryPath);
      if (!imageType) {
        throw new UserFacingError("image.unsupported", "仅支持 PNG 和 JPEG 图片");
      }
      const finalPath = join(this.directory, `${id}.${imageType.extension}`);
      await rename(temporaryPath, finalPath);
      return { path: finalPath, mimeType: imageType.mimeType, bytes };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof UserFacingError) {
        throw error;
      }
      // 文件系统和下载流异常可能包含本机路径或上游响应，边界处统一脱敏。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("保存图片失败");
    }
  }

  private async cleanupExpired(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const expiresBefore = Date.now() - this.retentionMs;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !/^[0-9a-f-]+\.(?:jpg|png|part)$/u.test(entry.name)) {
        return;
      }
      const path = join(this.directory, entry.name);
      const metadata = await stat(path);
      if (metadata.mtimeMs < expiresBefore) {
        await unlink(path);
      }
    }));
  }
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
