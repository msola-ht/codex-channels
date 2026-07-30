import { readBoundedFetchBody } from "./fetch-body.js";
import { withWeixinRequestAbort } from "./request-abort.js";

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
  return await withWeixinRequestAbort(
    { timeoutMs: downloadTimeoutMs },
    async (signal) => {
      const response = await options.fetchImpl(options.url, {
        method: "GET",
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        throw new Error("Weixin CDN request failed");
      }
      return await readBoundedFetchBody(
        response,
        options.maximumBytes,
        () => new Error("invalid Weixin CDN content length"),
        () => options.tooLarge(),
      );
    },
  );
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
