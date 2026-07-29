import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const maximumGeneratedImageBytes = 10 * 1024 * 1024;

export type GeneratedImageFormat = "jpeg" | "png";

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
    const format = imageFormat(bytes);
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

function imageFormat(value: Buffer): GeneratedImageFormat | undefined {
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
