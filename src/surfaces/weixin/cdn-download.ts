const weixinCdnOrigin = "https://novac2c.cdn.weixin.qq.com";
const weixinCdnDownloadPath = "/c2c/download";
const downloadTimeoutMs = 30_000;

export interface WeixinCdnReference {
  fullUrl?: string;
  encryptedQueryParam?: string;
}

export interface DownloadWeixinCdnBytesOptions {
  fetchImpl: typeof fetch;
  url: URL;
  maximumBytes: number;
  tooLarge(): Error;
}

export function resolveWeixinCdnUrl(reference: WeixinCdnReference): URL {
  if (reference.fullUrl !== undefined) {
    return validateWeixinCdnUrl(reference.fullUrl);
  }
  if (reference.encryptedQueryParam === undefined) {
    throw new Error("missing Weixin CDN URL");
  }
  const url = new URL(weixinCdnDownloadPath, weixinCdnOrigin);
  url.searchParams.set(
    "encrypted_query_param",
    reference.encryptedQueryParam,
  );
  return validateWeixinCdnUrl(url.href);
}

export async function downloadWeixinCdnBytes(
  options: DownloadWeixinCdnBytesOptions,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
  timeout.unref?.();
  try {
    const response = await options.fetchImpl(options.url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error("Weixin CDN request failed");
    }
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      const contentLength = Number(rawLength);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
        throw new Error("invalid Weixin CDN content length");
      }
      if (contentLength > options.maximumBytes) {
        throw options.tooLarge();
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
        if (bytes > options.maximumBytes) {
          await reader.cancel();
          throw options.tooLarge();
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

function validateWeixinCdnUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.origin !== weixinCdnOrigin
    || !url.pathname.startsWith("/c2c/")
    || url.hash
  ) {
    throw new Error("unexpected Weixin CDN URL");
  }
  return url;
}
