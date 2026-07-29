import { get as httpsGet } from "node:https";
import type { Readable } from "node:stream";

import { HttpsProxyAgent } from "https-proxy-agent";

const downloadTimeoutMs = 30_000;

export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export interface TelegramFileDownloadResponse {
  stream: Readable;
  contentLength?: number;
  invalidContentLength?: boolean;
}

export type TelegramFileDownloader = (
  url: URL,
) => Promise<TelegramFileDownloadResponse>;

export class TelegramFileLocationError extends Error {
  constructor(readonly code: "lookup-failed" | "invalid-path") {
    super("Telegram 文件定位失败");
    this.name = "TelegramFileLocationError";
  }
}

export async function resolveTelegramFileUrl(
  api: TelegramFileApi,
  fileId: string,
  token: string,
): Promise<URL> {
  let filePath: string | undefined;
  try {
    filePath = (await api.getFile(fileId)).file_path;
  } catch {
    throw new TelegramFileLocationError("lookup-failed");
  }
  if (!filePath || !isSafeTelegramFilePath(filePath)) {
    throw new TelegramFileLocationError("invalid-path");
  }
  return new URL(`https://api.telegram.org/file/bot${token}/${filePath}`);
}

export function createTelegramFileDownloader(
  proxyUrl: string | undefined,
): TelegramFileDownloader {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
  return (url) => new Promise<TelegramFileDownloadResponse>((resolve, reject) => {
    const request = httpsGet(url, { agent }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Telegram 文件服务器返回非成功状态"));
        return;
      }
      const rawLength = response.headers["content-length"];
      if (rawLength === undefined) {
        resolve({ stream: response });
        return;
      }
      const parsedLength = typeof rawLength === "string"
        ? Number(rawLength)
        : Number.NaN;
      if (
        Number.isSafeInteger(parsedLength)
        && parsedLength >= 0
      ) {
        resolve({ stream: response, contentLength: parsedLength });
        return;
      }
      resolve({ stream: response, invalidContentLength: true });
    });
    request.setTimeout(
      downloadTimeoutMs,
      () => request.destroy(new Error("Telegram 文件下载超时")),
    );
    request.once("error", reject);
  });
}

function isSafeTelegramFilePath(value: string): boolean {
  return !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").includes("..")
    && /^[A-Za-z0-9._/-]+$/u.test(value);
}
