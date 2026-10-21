import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { ProviderProxyUpstream } from "./proxy.js";
import { maximumProviderImageUploadBytes } from "./model-request-limits.js";

const maximumResponseBytes = 64 * 1024;
const uploadTimeoutMs = 60_000;

export type DeepseekImageMediaType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export function deepseekImageMediaType(value: Buffer): DeepseekImageMediaType | undefined {
  if (value.length >= 8 && value.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return "image/png";
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) {
    return "image/jpeg";
  }
  if (value.length >= 12 && value.subarray(0, 4).equals(Buffer.from("RIFF"))
    && value.subarray(8, 12).equals(Buffer.from("WEBP"))) return "image/webp";
  if (value.length >= 6 && (value.subarray(0, 6).equals(Buffer.from("GIF87a"))
    || value.subarray(0, 6).equals(Buffer.from("GIF89a")))) return "image/gif";
  return undefined;
}

/**
 * One bounded DeepSeek Files API upload. The caller owns provider material and
 * revision checks; this function never redirects, retries or exposes upstream errors.
 */
export async function uploadDeepseekImage(
  target: ProviderProxyUpstream & { authorization: string },
  bytes: Buffer,
  mediaType: DeepseekImageMediaType,
  signal: AbortSignal,
): Promise<string> {
  if (bytes.length === 0 || bytes.length > maximumProviderImageUploadBytes) {
    throw new Error("DeepSeek image upload size is invalid");
  }
  if (deepseekImageMediaType(bytes) !== mediaType) {
    throw new Error("DeepSeek image upload media type does not match the bytes");
  }
  const boundary = `----codexc-${randomBytes(16).toString("hex")}`;
  const extension = mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.${extension}"\r\n`
      + `Content-Type: ${mediaType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error("DeepSeek image upload timed out")), uploadTimeoutMs);
  try {
    requestSignal.throwIfAborted();
    const upstream = (target.protocol === "http" ? httpRequest : httpsRequest)({
      hostname: target.host,
      ...(target.port === undefined ? {} : { port: target.port }),
      agent: target.agent,
      path: `${target.basePath?.replace(/\/$/u, "") ?? ""}/files`,
      method: "POST",
      headers: {
        authorization: target.authorization,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
        accept: "application/json",
        "accept-encoding": "identity",
      },
      signal: requestSignal,
    });
    const ready = once(upstream, "response", { signal: requestSignal });
    void ready.catch(() => undefined);
    upstream.end(body);
    const [response] = await ready as [import("node:http").IncomingMessage];
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of response) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      size += chunk.length;
      if (size > maximumResponseBytes) {
        response.destroy();
        throw new Error("DeepSeek image upload response is too large");
      }
      chunks.push(chunk);
    }
    requestSignal.throwIfAborted();
    const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
    const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (response.statusCode !== 200 || (encoding !== undefined && encoding !== "identity")
      || contentType !== "application/json") {
      throw new Error("DeepSeek image upload was rejected");
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || typeof (parsed as { id?: unknown }).id !== "string"
      || !/^file-api-[A-Za-z0-9_-]{1,128}$/u.test((parsed as { id: string }).id)) {
      throw new Error("DeepSeek image upload returned an invalid file ID");
    }
    return (parsed as { id: string }).id;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
