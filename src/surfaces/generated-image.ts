import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const maximumGeneratedImageBytes = 10 * 1024 * 1024;

export type GeneratedImageFormat = "jpeg" | "png";
export type InputImageFormat = GeneratedImageFormat | "gif" | "webp";
export type InputImageMimeType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type GeneratedImageErrorCode =
  | "invalid-path"
  | "invalid-file"
  | "too-large"
  | "unsupported-image";

export class GeneratedImageError extends Error {
  constructor(readonly code: GeneratedImageErrorCode) {
    super("生成图片无法读取");
    this.name = "GeneratedImageError";
  }
}

export interface GeneratedImage {
  bytes: Buffer;
  format: GeneratedImageFormat;
}

export async function readGeneratedImage(path: string): Promise<GeneratedImage> {
  return await readImage(path, generatedImageFormat);
}

export interface InputImage {
  bytes: Buffer;
  format: InputImageFormat;
}

export async function readInputImage(path: string): Promise<InputImage> {
  return await readImage(path, inputImageFormat);
}

async function readImage<Format extends string>(
  path: string,
  detectFormat: (value: Buffer) => Format | undefined,
): Promise<{ bytes: Buffer; format: Format }> {
  if (
    !isAbsolute(path)
    || path.length === 0
    || path.length > 4_096
  ) {
    throw new GeneratedImageError("invalid-path");
  }
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0) {
      throw new GeneratedImageError("invalid-file");
    }
    if (stat.size > maximumGeneratedImageBytes) {
      throw new GeneratedImageError("too-large");
    }
    const bytes = await file.readFile();
    if (bytes.length > maximumGeneratedImageBytes) {
      throw new GeneratedImageError("too-large");
    }
    const format = detectFormat(bytes);
    if (format === undefined) {
      throw new GeneratedImageError("unsupported-image");
    }
    return { bytes, format };
  } catch (error) {
    if (error instanceof GeneratedImageError) {
      throw error;
    }
    throw new GeneratedImageError("invalid-file");
  } finally {
    await file?.close();
  }
}

function generatedImageFormat(value: Buffer): GeneratedImageFormat | undefined {
  const pngSignature = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  if (
    value.length >= pngSignature.length
    && value.subarray(0, pngSignature.length).equals(pngSignature)
  ) {
    return "png";
  }
  if (
    value.length >= 3
    && value[0] === 0xff
    && value[1] === 0xd8
    && value[2] === 0xff
  ) {
    return "jpeg";
  }
  return undefined;
}

function inputImageFormat(value: Buffer): InputImageFormat | undefined {
  const generatedFormat = generatedImageFormat(value);
  if (generatedFormat !== undefined) return generatedFormat;
  if (
    value.length >= 12
    && value.subarray(0, 4).equals(Buffer.from("RIFF"))
    && value.subarray(8, 12).equals(Buffer.from("WEBP"))
  ) {
    return "webp";
  }
  if (
    value.length >= 6
    && (value.subarray(0, 6).equals(Buffer.from("GIF87a"))
      || value.subarray(0, 6).equals(Buffer.from("GIF89a")))
    && gifFrameCount(value) === 1
  ) {
    return "gif";
  }
  return undefined;
}

function gifFrameCount(value: Buffer): number | undefined {
  if (value.length < 13) return undefined;
  let offset = 13;
  const globalColorTable = value[10]!;
  if ((globalColorTable & 0x80) !== 0) {
    offset += 3 * (2 ** ((globalColorTable & 0x07) + 1));
  }
  let frames = 0;
  while (offset < value.length) {
    const marker = value[offset++];
    if (marker === 0x3b) return frames;
    if (marker === 0x21) {
      offset += 1;
      const next = skipGifSubBlocks(value, offset);
      if (next === undefined) return undefined;
      offset = next;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > value.length) return undefined;
    frames += 1;
    if (frames > 1) return frames;
    const localColorTable = value[offset + 8]!;
    offset += 9;
    if ((localColorTable & 0x80) !== 0) {
      offset += 3 * (2 ** ((localColorTable & 0x07) + 1));
    }
    if (offset >= value.length) return undefined;
    offset += 1;
    const next = skipGifSubBlocks(value, offset);
    if (next === undefined) return undefined;
    offset = next;
  }
  return undefined;
}

function skipGifSubBlocks(value: Buffer, start: number): number | undefined {
  let offset = start;
  while (offset < value.length) {
    const size = value[offset++]!;
    if (size === 0) return offset;
    offset += size;
    if (offset > value.length) return undefined;
  }
  return undefined;
}
