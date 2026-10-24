import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { ManagedMediaSource } from "../managed-media-store.js";

/** Only the HTTPS download endpoint present in the locked official attachment examples. */
export function isSupportedQqAttachmentUrl(value: string): boolean {
  if (value.length > 8192 || /[\s\\]/u.test(value)
    || [...value].some(character => { const code = character.codePointAt(0)!; return code < 32 || code >= 127 && code <= 159; })) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "multimedia.nt.qq.com.cn"
      && url.port === "" && url.username === "" && url.password === ""
      && url.pathname === "/download" && url.hash === "";
  } catch { return false; }
}

/** No API credentials, cookies or redirect following on attachment transfers. */
export async function downloadQqMedia(fetchImpl: typeof fetch, url: string, signal: AbortSignal,
  beforeDownload: () => void): Promise<ManagedMediaSource> {
  if (!isSupportedQqAttachmentUrl(url)) throw new Error("QQ 附件下载地址不受支持");
  signal.throwIfAborted();
  beforeDownload();
  const response = await fetchImpl(url, { signal, redirect: "manual", credentials: "omit" });
  try {
    signal.throwIfAborted();
    beforeDownload();
    if (response.status !== 200 || response.redirected || !response.body) throw new Error("QQ 附件下载未成功");
    const rawLength = response.headers.get("content-length");
    const contentLength = rawLength === null ? undefined : Number(rawLength);
    if (rawLength !== null && (!/^\d+$/u.test(rawLength) || !Number.isSafeInteger(contentLength))) {
      throw new Error("QQ 附件长度无效");
    }
    return { stream: Readable.fromWeb(response.body as unknown as ReadableStream<Uint8Array>),
      ...(contentLength === undefined ? {} : { contentLength }) };
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}
