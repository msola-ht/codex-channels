import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const maximumWeixinOutboundImageBytes = 10 * 1024 * 1024;

export type WeixinOutboundImageErrorCode =
  | "invalid-path"
  | "invalid-file"
  | "too-large"
  | "unsupported-image";

export class WeixinOutboundImageError extends Error {
  constructor(readonly code: WeixinOutboundImageErrorCode) {
    super("微信生成图片无法读取");
    this.name = "WeixinOutboundImageError";
  }
}

export async function readWeixinOutboundImage(path: string): Promise<Buffer> {
  if (
    !isAbsolute(path)
    || path.length === 0
    || path.length > 4_096
  ) {
    throw new WeixinOutboundImageError("invalid-path");
  }
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0) {
      throw new WeixinOutboundImageError("invalid-file");
    }
    if (stat.size > maximumWeixinOutboundImageBytes) {
      throw new WeixinOutboundImageError("too-large");
    }
    const image = await file.readFile();
    if (image.length > maximumWeixinOutboundImageBytes) {
      throw new WeixinOutboundImageError("too-large");
    }
    if (!isPng(image) && !isJpeg(image)) {
      throw new WeixinOutboundImageError("unsupported-image");
    }
    return image;
  } catch (error) {
    if (error instanceof WeixinOutboundImageError) {
      throw error;
    }
    throw new WeixinOutboundImageError("invalid-file");
  } finally {
    await file?.close();
  }
}

function isPng(value: Buffer): boolean {
  const signature = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  return value.length >= signature.length
    && value.subarray(0, signature.length).equals(signature);
}

function isJpeg(value: Buffer): boolean {
  return value.length >= 3
    && value[0] === 0xff
    && value[1] === 0xd8
    && value[2] === 0xff;
}
