import { createDecipheriv, createHash } from "node:crypto";

import {
  formatTextFileDownloadFailed,
  formatTextFileTooLarge,
  formatUnsupportedTextFile,
} from "../text-file-copy.js";
import {
  downloadWeixinCdnBytes,
  resolveWeixinCdnUrl,
} from "./cdn-download.js";
import type { WeixinFileReference } from "./protocol-client.js";

export const maximumWeixinTextFileBytes = 1_000_000;

const maximumEncryptedFileBytes = maximumWeixinTextFileBytes + 16;

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
      const encrypted = await downloadWeixinCdnBytes({
        fetchImpl: this.fetchImpl,
        url: resolveWeixinCdnUrl(reference),
        maximumBytes: key === undefined
          ? maximumWeixinTextFileBytes
          : maximumEncryptedFileBytes,
        tooLarge,
      });
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
        formatTextFileDownloadFailed("微信"),
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

function tooLarge(): WeixinFileInputError {
  return new WeixinFileInputError(
    "too-large",
    formatTextFileTooLarge("微信"),
  );
}

function unsupportedFile(): WeixinFileInputError {
  return new WeixinFileInputError(
    "unsupported",
    formatUnsupportedTextFile("微信"),
  );
}

function integrityFailure(): WeixinFileInputError {
  return new WeixinFileInputError(
    "integrity",
    "微信文件完整性校验失败，请重新发送",
  );
}
