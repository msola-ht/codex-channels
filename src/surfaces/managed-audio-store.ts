import { open } from "node:fs/promises";
import type { Readable } from "node:stream";

import { UserFacingError } from "../conversation-core/index.js";
import { ManagedMediaStore } from "./managed-media-store.js";

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
  private readonly storage: ManagedMediaStore<StoredManagedAudio["mimeType"]>;

  constructor(
    directory: string,
    onCleanupFailure: (error: unknown) => void,
    retentionMs = defaultRetentionMs,
  ) {
    this.storage = new ManagedMediaStore({
      directory,
      maximumBytes: maximumManagedAudioBytes,
      retentionMs,
      cleanupIntervalMs,
      managedFileName: /^[0-9a-f-]+\.(?:wav|mp3|m4a|webm|ogg|part)$/u,
      closedMessage: "音频暂存器已经关闭",
      storeFailureMessage: "保存音频失败",
      invalidContentLength: (contentLength) =>
        !Number.isSafeInteger(contentLength)
        || contentLength < 0
        || contentLength > maximumManagedAudioBytes,
      tooLargeError: tooLarge,
      detectType: detectAudioType,
      unsupportedError: () => new UserFacingError(
        "audio.unsupported",
        "仅支持 WAV、MP3、M4A、WebM 和 OGG 音频",
      ),
      onCleanupFailure,
    });
  }

  async start(): Promise<void> {
    await this.storage.start();
  }

  close(): void {
    this.storage.close();
  }

  async store(source: ManagedAudioSource): Promise<StoredManagedAudio> {
    return await this.storage.store(source);
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
