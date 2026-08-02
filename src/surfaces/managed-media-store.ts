import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { UserFacingError } from "../conversation-core/index.js";

export interface ManagedMediaSource {
  stream: Readable;
  contentLength?: number;
}

export interface ManagedMediaType<MimeType extends string> {
  extension: string;
  mimeType: MimeType;
}

export interface ManagedMediaStoreOptions<MimeType extends string> {
  directory: string;
  maximumBytes: number;
  retentionMs: number;
  cleanupIntervalMs: number;
  managedFileName: RegExp;
  closedMessage: string;
  storeFailureMessage: string;
  invalidContentLength(contentLength: number): boolean;
  tooLargeError(): UserFacingError;
  detectType(path: string): Promise<ManagedMediaType<MimeType> | undefined>;
  unsupportedError(): UserFacingError;
  onCleanupFailure(error: unknown): void;
}

export interface StoredManagedMedia<MimeType extends string> {
  path: string;
  mimeType: MimeType;
  bytes: number;
}

export class ManagedMediaStore<MimeType extends string> {
  private cleanupTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: ManagedMediaStoreOptions<MimeType>) {}

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error(this.options.closedMessage);
    }
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await chmod(this.options.directory, 0o700);
    await this.cleanupExpired().catch((error: unknown) => {
      this.options.onCleanupFailure(error);
    });
    if (this.closed) {
      return;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch((error: unknown) => {
        this.options.onCleanupFailure(error);
      });
    }, this.options.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  async store(source: ManagedMediaSource): Promise<StoredManagedMedia<MimeType>> {
    if (
      source.contentLength !== undefined
      && this.options.invalidContentLength(source.contentLength)
    ) {
      source.stream.destroy();
      throw this.options.tooLargeError();
    }

    const id = randomUUID();
    const temporaryPath = join(this.options.directory, `${id}.part`);
    let bytes = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length;
        if (bytes > this.options.maximumBytes) {
          callback(this.options.tooLargeError());
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
      const mediaType = await this.options.detectType(temporaryPath);
      if (!mediaType) {
        throw this.options.unsupportedError();
      }
      const finalPath = join(this.options.directory, `${id}.${mediaType.extension}`);
      await rename(temporaryPath, finalPath);
      return { path: finalPath, mimeType: mediaType.mimeType, bytes };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof UserFacingError) {
        throw error;
      }
      // 文件系统和下载流异常可能包含本机路径或上游响应，边界处统一脱敏。
      // eslint-disable-next-line preserve-caught-error
      throw new Error(this.options.storeFailureMessage);
    }
  }

  private async cleanupExpired(): Promise<void> {
    const entries = await readdir(this.options.directory, { withFileTypes: true });
    const expiresBefore = Date.now() - this.options.retentionMs;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !this.options.managedFileName.test(entry.name)) {
        return;
      }
      const path = join(this.options.directory, entry.name);
      const metadata = await stat(path);
      if (metadata.mtimeMs < expiresBefore) {
        await unlink(path);
      }
    }));
  }
}
