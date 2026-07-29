import { createDecipheriv } from "node:crypto";
import { Readable } from "node:stream";

import type { Logger } from "pino";

import { UserFacingError } from "../../conversation-core/index.js";
import {
  ManagedImageStore,
  maximumManagedImageBytes,
  type StoredManagedImage,
} from "../managed-image-store.js";
import {
  downloadWeixinCdnBytes,
  resolveWeixinCdnUrl,
} from "./cdn-download.js";
import type { WeixinImageReference } from "./protocol-client.js";

export const maximumWeixinImageBytes = maximumManagedImageBytes;

const maximumEncryptedImageBytes = maximumWeixinImageBytes + 16;

export interface WeixinImagePort {
  start(): Promise<void>;
  close(): void;
  download(reference: WeixinImageReference): Promise<StoredManagedImage>;
}

export class WeixinImageDownloadError extends Error {
  constructor() {
    super("下载微信图片失败，请重新发送");
    this.name = "WeixinImageDownloadError";
  }
}

export class WeixinImageStore implements WeixinImagePort {
  private readonly storage: ManagedImageStore;
  private startPromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    directory: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.storage = new ManagedImageStore(
      directory,
      () => {
        this.logger.warn("清理过期微信图片失败");
      },
    );
  }

  start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("微信图片暂存器已经关闭"));
    }
    this.startPromise ??= this.storage.start();
    return this.startPromise;
  }

  close(): void {
    this.closed = true;
    this.storage.close();
  }

  async download(
    reference: WeixinImageReference,
  ): Promise<StoredManagedImage> {
    if (this.closed) {
      throw new Error("微信图片暂存器已经关闭");
    }
    await this.start();
    try {
      const encryption = resolveEncryption(reference);
      const response = await downloadWeixinCdnBytes({
        fetchImpl: this.fetchImpl,
        url: resolveWeixinCdnUrl(reference),
        maximumBytes: encryption.key === undefined
          ? maximumWeixinImageBytes
          : maximumEncryptedImageBytes,
        tooLarge: imageTooLarge,
      });
      const plaintext = encryption.key === undefined
        ? response
        : decryptImage(response, encryption.key);
      return await this.storage.store({
        stream: Readable.from([plaintext]),
        contentLength: plaintext.length,
      });
    } catch (error) {
      if (error instanceof UserFacingError) {
        throw error;
      }
      // CDN 地址、查询参数、AES key、响应正文和底层异常不得越过微信边界。
      throw new WeixinImageDownloadError();
    }
  }
}

function resolveEncryption(
  reference: WeixinImageReference,
): { key?: Buffer } {
  if (reference.imageAesKey !== undefined) {
    if (!/^[0-9a-fA-F]{32}$/u.test(reference.imageAesKey)) {
      throw new Error("invalid Weixin image AES key");
    }
    return { key: Buffer.from(reference.imageAesKey, "hex") };
  }
  if (reference.mediaAesKey !== undefined) {
    return { key: parseBase64AesKey(reference.mediaAesKey) };
  }
  return {};
}

function parseBase64AesKey(value: string): Buffer {
  if (
    value.length > 1_024
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
    || value.length % 4 !== 0
  ) {
    throw new Error("invalid Weixin image AES key");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/u.test(ascii)) {
    return Buffer.from(ascii, "hex");
  }
  throw new Error("invalid Weixin image AES key");
}

function decryptImage(value: Buffer, key: Buffer): Buffer {
  if (value.length === 0 || value.length % 16 !== 0) {
    throw new Error("invalid Weixin encrypted image length");
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(value), decipher.final()]);
}

function imageTooLarge(): UserFacingError {
  return new UserFacingError(
    "image.too-large",
    "图片超过 10 MiB 限制",
  );
}
