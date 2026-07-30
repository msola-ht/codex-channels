import {
  GeneratedImageError,
  maximumGeneratedImageBytes,
  readGeneratedImage,
  type GeneratedImageErrorCode,
} from "../generated-image.js";

export const maximumWeixinOutboundImageBytes = maximumGeneratedImageBytes;

export type WeixinOutboundImageErrorCode = GeneratedImageErrorCode;

export class WeixinOutboundImageError extends Error {
  constructor(readonly code: WeixinOutboundImageErrorCode) {
    super("微信生成图片无法读取");
    this.name = "WeixinOutboundImageError";
  }
}

export async function readWeixinOutboundImage(path: string): Promise<Buffer> {
  try {
    return (await readGeneratedImage(path)).bytes;
  } catch (error) {
    if (error instanceof GeneratedImageError) {
      throw new WeixinOutboundImageError(error.code);
    }
    throw new WeixinOutboundImageError("invalid-file");
  }
}
