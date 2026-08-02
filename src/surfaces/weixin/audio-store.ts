import { Readable } from "node:stream";

import type { Logger } from "pino";

import { UserFacingError } from "../../conversation-core/index.js";
import {
  ManagedAudioStore,
  maximumManagedAudioBytes,
  type StoredManagedAudio,
} from "../managed-audio-store.js";
import {
  downloadWeixinCdnBytes,
  resolveWeixinCdnUrl,
} from "./cdn-download.js";
import {
  decryptWeixinMedia,
  parseWeixinMediaAesKey,
} from "./media-crypto.js";
import type { WeixinAudioReference } from "./protocol-client.js";

export const maximumWeixinAudioBytes = maximumManagedAudioBytes;
export const maximumWeixinAudioDurationMs = 5 * 60 * 1_000;

const maximumEncryptedAudioBytes = maximumWeixinAudioBytes + 16;
const directlySupportedEncodeTypes = new Set([7, 8]);

export interface WeixinAudioPort {
  start(): Promise<void>;
  close(): void;
  download(reference: WeixinAudioReference): Promise<StoredManagedAudio>;
}

export class WeixinAudioDownloadError extends Error {
  constructor() {
    super("下载微信语音失败，请重新发送");
    this.name = "WeixinAudioDownloadError";
  }
}

export class WeixinAudioStore implements WeixinAudioPort {
  private readonly storage: ManagedAudioStore;
  private startPromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    directory: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.storage = new ManagedAudioStore(
      directory,
      () => {
        this.logger.warn("清理过期微信语音失败");
      },
    );
  }

  start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("微信语音暂存器已经关闭"));
    }
    this.startPromise ??= this.storage.start().catch((error: unknown) => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  close(): void {
    this.closed = true;
    this.storage.close();
  }

  async download(
    reference: WeixinAudioReference,
  ): Promise<StoredManagedAudio> {
    if (this.closed) {
      throw new Error("微信语音暂存器已经关闭");
    }
    if (reference.durationMs === undefined) {
      throw new UserFacingError(
        "audio.duration-missing",
        "无法确认微信语音时长，请重新发送",
      );
    }
    if (reference.durationMs > maximumWeixinAudioDurationMs) {
      throw new UserFacingError(
        "audio.too-large",
        "语音超过 5 分钟限制",
      );
    }
    if (
      reference.encodeType !== undefined
      && !directlySupportedEncodeTypes.has(reference.encodeType)
    ) {
      throw new UserFacingError(
        "audio.unsupported",
        reference.encodeType === 6
          ? "微信 SILK 语音暂不受 Codex CLI 支持"
          : "微信语音编码暂不受 Codex CLI 支持",
      );
    }
    await this.start();
    try {
      const key = reference.mediaAesKey === undefined
        ? undefined
        : parseWeixinMediaAesKey(reference.mediaAesKey);
      const response = await downloadWeixinCdnBytes({
        fetchImpl: this.fetchImpl,
        url: resolveWeixinCdnUrl(reference),
        maximumBytes: key === undefined
          ? maximumWeixinAudioBytes
          : maximumEncryptedAudioBytes,
        tooLarge: audioTooLarge,
      });
      const plaintext = key === undefined
        ? response
        : decryptWeixinMedia(response, key);
      return await this.storage.store({
        stream: Readable.from([plaintext]),
        contentLength: plaintext.length,
      });
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw error;
      }
      throw new WeixinAudioDownloadError();
    }
  }
}

function audioTooLarge(): UserFacingError {
  return new UserFacingError(
    "audio.too-large",
    "语音超过 20 MiB 限制",
  );
}
