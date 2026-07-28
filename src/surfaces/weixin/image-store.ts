import { createDecipheriv } from "node:crypto";
import { Readable } from "node:stream";

import type { Logger } from "pino";

import { UserFacingError } from "../../conversation-core/index.js";
import {
  ManagedImageStore,
  maximumManagedImageBytes,
  type StoredManagedImage,
} from "../managed-image-store.js";
import type { WeixinImageReference } from "./protocol-client.js";

export const maximumWeixinImageBytes = maximumManagedImageBytes;

const cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";
const maximumEncryptedImageBytes = maximumWeixinImageBytes + 16;
const downloadTimeoutMs = 30_000;

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
      const response = await downloadCdnBytes(
        this.fetchImpl,
        resolveCdnUrl(reference),
        encryption.key === undefined
          ? maximumWeixinImageBytes
          : maximumEncryptedImageBytes,
      );
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

function resolveCdnUrl(reference: WeixinImageReference): URL {
  if (reference.fullUrl !== undefined) {
    return validateCdnUrl(reference.fullUrl);
  }
  if (reference.encryptedQueryParam === undefined) {
    throw new Error("missing Weixin image URL");
  }
  const url = new URL(`${cdnBaseUrl}/download`);
  url.searchParams.set(
    "encrypted_query_param",
    reference.encryptedQueryParam,
  );
  return validateCdnUrl(url.href);
}

function validateCdnUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hostname.toLowerCase() !== "novac2c.cdn.weixin.qq.com"
    || !url.pathname.startsWith("/c2c/")
    || url.hash
  ) {
    throw new Error("unexpected Weixin image CDN URL");
  }
  return url;
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

async function downloadCdnBytes(
  fetchImpl: typeof fetch,
  url: URL,
  maximumBytes: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error("Weixin image CDN request failed");
    }
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      const contentLength = Number(rawLength);
      if (
        !Number.isSafeInteger(contentLength)
        || contentLength < 0
      ) {
        throw new Error("invalid Weixin image content length");
      }
      if (contentLength > maximumBytes) {
        throw new UserFacingError(
          "image.too-large",
          "图片超过 10 MiB 限制",
        );
      }
    }
    if (!response.body) {
      return Buffer.alloc(0);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          return Buffer.concat(chunks, bytes);
        }
        bytes += chunk.value.byteLength;
        if (bytes > maximumBytes) {
          await reader.cancel();
          throw new UserFacingError(
            "image.too-large",
            "图片超过 10 MiB 限制",
          );
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timeout);
  }
}
