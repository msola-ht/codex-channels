import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";

import { UserFacingError } from "../conversation-core/index.js";

export interface ManagedMediaSource {
  stream: Readable;
  contentLength?: number;
}

export type ManagedMediaInput = ManagedMediaSource | ((signal: AbortSignal) => Promise<ManagedMediaSource>);

export interface ManagedMediaType<MimeType extends string> {
  extension: string;
  mimeType: MimeType;
}

export interface ManagedMediaStoreOptions<MimeType extends string> {
  directory: string;
  maximumBytes: number;
  retentionMs: number;
  cleanupIntervalMs: number;
  operationTimeoutMs?: number;
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
  private readonly cancellation = new AbortController();

  constructor(private readonly options: ManagedMediaStoreOptions<MimeType>) {}

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error(this.options.closedMessage);
    }
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.options.directory);
    const currentUid = process.getuid?.();
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (currentUid !== undefined && metadata.uid !== currentUid)) {
      throw new Error("媒体暂存目录类型或所有者无效");
    }
    securePrivateDirectorySync(this.options.directory);
    await this.secureExistingFiles();
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
    this.cancellation.abort();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  async store(input: ManagedMediaInput, inputSignal?: AbortSignal): Promise<StoredManagedMedia<MimeType>> {
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      this.cancellation.signal, deadline.signal,
      ...(inputSignal === undefined ? [] : [inputSignal]),
    ]);
    const timer = setTimeout(() => deadline.abort(), this.options.operationTimeoutMs ?? 60_000);
    timer.unref();
    let source: ManagedMediaSource | undefined;
    let finalPath: string | undefined;
    const temporaryPath = join(this.options.directory, `${randomUUID()}.part`);
    try {
      signal.throwIfAborted();
      source = typeof input === "function" ? await input(signal) : input;
      // A late download may already be failed or cancelled before pipeline owns it.
      source.stream.on("error", () => {});
      signal.throwIfAborted();
      if (
        source.contentLength !== undefined
        && this.options.invalidContentLength(source.contentLength)
      ) {
        source.stream.destroy();
        throw this.options.tooLargeError();
      }

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

      await pipeline(
        source.stream,
        limiter,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      signal.throwIfAborted();
      securePrivateFileSync(temporaryPath);
      const mediaType = await this.options.detectType(temporaryPath);
      signal.throwIfAborted();
      if (!mediaType) {
        throw this.options.unsupportedError();
      }
      finalPath = temporaryPath.replace(/\.part$/u, `.${mediaType.extension}`);
      await rename(temporaryPath, finalPath);
      signal.throwIfAborted();
      return { path: finalPath, mimeType: mediaType.mimeType, bytes };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (finalPath !== undefined) await unlink(finalPath).catch(() => undefined);
      if (error instanceof UserFacingError) {
        throw error;
      }
      // 文件系统和下载流异常可能包含本机路径或上游响应，边界处统一脱敏。
      // eslint-disable-next-line preserve-caught-error
      throw new Error(this.options.storeFailureMessage);
    } finally {
      clearTimeout(timer);
      source?.stream.destroy();
      if (typeof input !== "function" && source === undefined) {
        input.stream.on("error", () => {});
        input.stream.destroy();
      }
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

  private async secureExistingFiles(): Promise<void> {
    const entries = await readdir(this.options.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && this.options.managedFileName.test(entry.name)) {
        securePrivateFileSync(join(this.options.directory, entry.name));
      }
    }
  }
}
