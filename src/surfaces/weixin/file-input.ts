import { createHash } from "node:crypto";

import {
  formatTextFileDownloadFailed,
  formatTextFileTooLarge,
  formatUnsupportedTextFile,
} from "../text-file-copy.js";
import {
  decodeUtf8TextFile,
  maximumTextFileBytes,
  normalizeTextFileName,
  TextFileValidationError,
} from "../text-file-input.js";
import {
  downloadWeixinCdnBytes,
  resolveWeixinCdnUrl,
} from "./cdn-download.js";
import {
  decryptWeixinMedia,
  parseWeixinMediaAesKey,
} from "./media-crypto.js";
import type { WeixinFileReference } from "./protocol-client.js";

export const maximumWeixinTextFileBytes = maximumTextFileBytes;

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
        : parseWeixinMediaAesKey(reference.mediaAesKey);
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
        : decryptWeixinMedia(encrypted, key);
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
        text: decodeUtf8TextFile(plaintext),
        bytes: plaintext.length,
      };
    } catch (error) {
      if (error instanceof WeixinFileInputError) {
        throw error;
      }
      if (error instanceof TextFileValidationError) {
        throw error.code === "too-large" ? tooLarge() : unsupportedFile();
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
  try {
    return normalizeTextFileName(value, { maximumCodeUnits: 255 });
  } catch (error) {
    throw new Error("invalid Weixin file name", { cause: error });
  }
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
