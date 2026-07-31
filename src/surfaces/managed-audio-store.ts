import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { UserFacingError } from "../conversation-core/index.js";

export const maximumManagedAudioBytes = 20 * 1024 * 1024;

const cleanupIntervalMs = 10 * 60 * 1000;
const defaultRetentionMs = 60 * 60 * 1000;

export interface ManagedAudioSource {
  stream: Readable;
  contentLength?: number;
}

export interface StoredManagedAudio {
  path: string;
  mimeType:
    | "audio/wav"
    | "audio/mpeg"
    | "audio/mp4"
    | "audio/webm"
    | "audio/ogg";
  bytes: number;
}

export class ManagedAudioStore {
  private cleanupTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly onCleanupFailure: (error: unknown) => void,
    private readonly retentionMs = defaultRetentionMs,
  ) {}

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error("音频暂存器已经关闭");
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

  async store(source: ManagedAudioSource): Promise<StoredManagedAudio> {
    if (
      source.contentLength !== undefined
      && (
        !Number.isSafeInteger(source.contentLength)
        || source.contentLength < 0
        || source.contentLength > maximumManagedAudioBytes
      )
    ) {
      source.stream.destroy();
      throw tooLarge();
    }

    const id = randomUUID();
    const temporaryPath = join(this.directory, `${id}.part`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maximumManagedAudioBytes) {
          callback(tooLarge());
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
      const audioType = await detectAudioType(temporaryPath);
      if (!audioType) {
        throw new UserFacingError(
          "audio.unsupported",
          "仅支持 WAV、MP3、M4A、WebM 和 OGG 音频",
        );
      }
      const finalPath = join(this.directory, `${id}.${audioType.extension}`);
      await rename(temporaryPath, finalPath);
      return { path: finalPath, mimeType: audioType.mimeType, bytes };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof UserFacingError) {
        throw error;
      }
      // 文件系统和下载流异常可能包含本机路径或上游响应。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("保存音频失败");
    }
  }

  private async cleanupExpired(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const expiresBefore = Date.now() - this.retentionMs;
    await Promise.all(entries.map(async (entry) => {
      if (
        !entry.isFile()
        || !/^[0-9a-f-]+\.(?:wav|mp3|m4a|webm|ogg|part)$/u.test(entry.name)
      ) {
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

function tooLarge(): UserFacingError {
  return new UserFacingError("audio.too-large", "音频超过 20 MiB 限制");
}

async function detectAudioType(path: string): Promise<{
  extension: "wav" | "mp3" | "m4a" | "webm" | "ogg";
  mimeType: StoredManagedAudio["mimeType"];
} | undefined> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead >= 12
      && header.subarray(0, 4).equals(Buffer.from("RIFF"))
      && header.subarray(8, 12).equals(Buffer.from("WAVE"))
    ) {
      return { extension: "wav", mimeType: "audio/wav" };
    }
    if (
      bytesRead >= 3
      && (
        header.subarray(0, 3).equals(Buffer.from("ID3"))
        || (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0)
      )
    ) {
      return { extension: "mp3", mimeType: "audio/mpeg" };
    }
    if (
      bytesRead >= 12
      && header.subarray(4, 8).equals(Buffer.from("ftyp"))
    ) {
      return { extension: "m4a", mimeType: "audio/mp4" };
    }
    if (
      bytesRead >= 4
      && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    ) {
      return { extension: "webm", mimeType: "audio/webm" };
    }
    if (
      bytesRead >= 4
      && header.subarray(0, 4).equals(Buffer.from("OggS"))
    ) {
      return { extension: "ogg", mimeType: "audio/ogg" };
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
