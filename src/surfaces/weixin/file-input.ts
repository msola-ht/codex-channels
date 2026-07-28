import { createDecipheriv, createHash } from "node:crypto";

import type { WeixinFileReference } from "./protocol-client.js";

export const maximumWeixinTextFileBytes = 1_000_000;

const cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";
const maximumEncryptedFileBytes = maximumWeixinTextFileBytes + 16;
const downloadTimeoutMs = 30_000;

export type WeixinFileInputErrorCode =
  | "download-failed"
  | "integrity"
  | "too-large"
  | "unsupported";

export class WeixinFileInputError extends Error {
  constructor(readonly code: WeixinFileInputErrorCode, message: string) {
    super(message);
    this.name = "WeixinFileInputError";
  }
}

export interface WeixinTextFile {
  fileName: string;
  text: string;
  bytes: number;
}

export interface WeixinFilePort {
  download(reference: WeixinFileReference): Promise<WeixinTextFile>;
}

export class WeixinFileInput implements WeixinFilePort {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async download(reference: WeixinFileReference): Promise<WeixinTextFile> {
    try {
      const fileName = validateFileName(reference.fileName);
      const declaredLength = parseDeclaredLength(reference.declaredLength);
      if (
        declaredLength !== undefined
        && declaredLength > maximumWeixinTextFileBytes
      ) {
        throw tooLarge();
      }
      const key = reference.mediaAesKey === undefined
        ? undefined
        : parseBase64AesKey(reference.mediaAesKey);
      const encrypted = await downloadCdnBytes(
        this.fetchImpl,
        resolveCdnUrl(reference),
        key === undefined
          ? maximumWeixinTextFileBytes
          : maximumEncryptedFileBytes,
      );
      const plaintext = key === undefined
        ? encrypted
        : decryptFile(encrypted, key);
      if (plaintext.length > maximumWeixinTextFileBytes) {
        throw tooLarge();
      }
      if (
        declaredLength !== undefined
        && declaredLength !== plaintext.length
      ) {
        throw integrityFailure();
      }
      const declaredMd5 = parseDeclaredMd5(reference.declaredMd5);
      if (
        declaredMd5 !== undefined
        && createHash("md5").update(plaintext).digest("hex") !== declaredMd5
      ) {
        throw integrityFailure();
      }
      return {
        fileName,
        text: decodeUtf8Text(plaintext),
        bytes: plaintext.length,
      };
    } catch (error) {
      if (error instanceof WeixinFileInputError) {
        throw error;
      }
      // CDN 地址、参数、AES key、文件名、正文和底层异常不得越过微信边界。
      throw new WeixinFileInputError(
        "download-failed",
        "下载微信文件失败，请重新发送",
      );
    }
  }
}

function validateFileName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 255
    || normalized === "."
    || normalized === ".."
    || hasInvalidFileNameCharacter(normalized)
  ) {
    throw new Error("invalid Weixin file name");
  }
  return normalized;
}

function resolveCdnUrl(reference: WeixinFileReference): URL {
  if (reference.fullUrl !== undefined) {
    return validateCdnUrl(reference.fullUrl);
  }
  if (reference.encryptedQueryParam === undefined) {
    throw new Error("missing Weixin file URL");
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
    throw new Error("unexpected Weixin file CDN URL");
  }
  return url;
}

function parseBase64AesKey(value: string): Buffer {
  if (
    value.length > 1_024
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
    || value.length % 4 !== 0
  ) {
    throw new Error("invalid Weixin file AES key");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/u.test(ascii)) {
    return Buffer.from(ascii, "hex");
  }
  throw new Error("invalid Weixin file AES key");
}

function parseDeclaredLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^(0|[1-9]\d{0,15})$/u.test(value)) {
    throw new Error("invalid Weixin file length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("invalid Weixin file length");
  }
  return parsed;
}

function parseDeclaredMd5(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[0-9a-fA-F]{32}$/u.test(value)) {
    throw new Error("invalid Weixin file MD5");
  }
  return value.toLowerCase();
}

function decryptFile(value: Buffer, key: Buffer): Buffer {
  if (value.length === 0 || value.length % 16 !== 0) {
    throw new Error("invalid Weixin encrypted file length");
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(value), decipher.final()]);
}

function decodeUtf8Text(value: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw unsupportedFile();
  }
  const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (
    normalized.length === 0
    || hasUnsupportedTextControl(normalized)
  ) {
    throw unsupportedFile();
  }
  return normalized;
}

function hasInvalidFileNameCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      character === "/"
      || character === "\\"
      || code <= 0x1f
      || code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function hasUnsupportedTextControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
    ) {
      return true;
    }
  }
  return false;
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
      throw new Error("Weixin file CDN request failed");
    }
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      const contentLength = Number(rawLength);
      if (
        !Number.isSafeInteger(contentLength)
        || contentLength < 0
      ) {
        throw new Error("invalid Weixin file content length");
      }
      if (contentLength > maximumBytes) {
        throw tooLarge();
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
          throw tooLarge();
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

function tooLarge(): WeixinFileInputError {
  return new WeixinFileInputError(
    "too-large",
    "微信文本文件超过 1,000,000 字节限制",
  );
}

function unsupportedFile(): WeixinFileInputError {
  return new WeixinFileInputError(
    "unsupported",
    "微信当前仅支持 UTF-8 文本文件",
  );
}

function integrityFailure(): WeixinFileInputError {
  return new WeixinFileInputError(
    "integrity",
    "微信文件完整性校验失败，请重新发送",
  );
}
