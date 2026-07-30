import { createDecipheriv } from "node:crypto";

export function parseWeixinMediaAesKey(value: string): Buffer {
  if (
    value.length > 1_024
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
    || value.length % 4 !== 0
  ) {
    throw new Error("invalid Weixin media AES key");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/u.test(ascii)) {
    return Buffer.from(ascii, "hex");
  }
  throw new Error("invalid Weixin media AES key");
}

export function decryptWeixinMedia(value: Buffer, key: Buffer): Buffer {
  if (value.length === 0 || value.length % 16 !== 0) {
    throw new Error("invalid Weixin encrypted media length");
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(value), decipher.final()]);
}
