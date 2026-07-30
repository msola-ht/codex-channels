import { createDecipheriv } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createWeixinUpdatesContractClient,
  loadConfiguredWeixinContractConnection,
  selectWeixinImageContext,
} from "./weixin-updates-contract-probe.mjs";

const cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";
const maximumImageBytes = 10 * 1024 * 1024;
const maximumEncryptedImageBytes = maximumImageBytes + 16;
const downloadTimeoutMs = 30_000;

export class WeixinImageContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WeixinImageContractError";
    this.code = code;
  }
}

export function createWeixinImageContractClient({
  fetchImpl = fetch,
  timeoutMs = downloadTimeoutMs,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WeixinImageContractError(
      "invalid-input",
      "微信图片下载超时时间无效",
    );
  }
  return {
    async download(image, signal) {
      const { url, source } = resolveCdnUrl(image);
      const encryption = resolveEncryption(image);
      const maximumDownloadBytes = encryption.key === undefined
        ? maximumImageBytes
        : maximumEncryptedImageBytes;
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      if (signal?.aborted) {
        throw new WeixinImageContractError("aborted", "微信图片下载已取消");
      }
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timeout.unref?.();
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new WeixinImageContractError(
            "http-error",
            `微信图片下载失败（HTTP ${response.status}）`,
          );
        }
        const downloaded = await readLimitedBytes(
          response,
          maximumDownloadBytes,
        );
        const plaintext = encryption.key === undefined
          ? downloaded
          : decryptImage(downloaded, encryption.key);
        if (plaintext.length > maximumImageBytes) {
          throw new WeixinImageContractError(
            "too-large",
            "微信图片超过 10 MiB 限制",
          );
        }
        const mimeType = detectImageType(plaintext);
        if (mimeType === undefined) {
          throw new WeixinImageContractError(
            "unsupported-image",
            "微信图片不是受支持的 PNG 或 JPEG",
          );
        }
        return {
          kind: "success",
          urlSource: source,
          encryption: encryption.source,
          downloadedBytes: downloaded.length,
          imageBytes: plaintext.length,
          mimeType,
        };
      } catch (error) {
        if (error instanceof WeixinImageContractError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new WeixinImageContractError(
            signal?.aborted
              ? "aborted"
              : timedOut
                ? "timeout"
                : "network-error",
            signal?.aborted
              ? "微信图片下载已取消"
              : timedOut
                ? "微信图片下载超时"
                : "微信图片下载网络请求失败",
          );
        }
        throw new WeixinImageContractError(
          "network-error",
          "微信图片下载网络请求失败",
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

export async function runWeixinImageDownloadContract({
  updatesClient,
  imageClient,
  credential,
  allowedUserIds,
  signal,
}) {
  const inbound = await updatesClient.pollOnce({
    baseUrl: credential.baseUrl,
    botToken: credential.botToken,
    signal,
  });
  if (inbound.kind !== "success") {
    return { inbound };
  }
  const image = selectWeixinImageContext(inbound, allowedUserIds);
  const download = await imageClient.download(image, signal);
  return { inbound, download };
}

function resolveCdnUrl(image) {
  if (typeof image.fullUrl === "string") {
    return {
      url: validateCdnUrl(image.fullUrl),
      source: "full-url",
    };
  }
  if (typeof image.encryptedQueryParam !== "string") {
    throw new WeixinImageContractError(
      "invalid-response",
      "微信图片没有可用下载地址",
    );
  }
  const url = new URL(`${cdnBaseUrl}/download`);
  url.searchParams.set(
    "encrypted_query_param",
    image.encryptedQueryParam,
  );
  return {
    url: validateCdnUrl(url.href),
    source: "query-param",
  };
}

function validateCdnUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinImageContractError(
      "invalid-response",
      "微信图片下载地址无效",
    );
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hostname.toLowerCase() !== "novac2c.cdn.weixin.qq.com"
    || !url.pathname.startsWith("/c2c/")
    || url.hash
  ) {
    throw new WeixinImageContractError(
      "invalid-response",
      "微信图片下载地址不属于固定官方 CDN",
    );
  }
  return url;
}

function resolveEncryption(image) {
  if (typeof image.imageAesKey === "string") {
    if (!/^[0-9a-fA-F]{32}$/u.test(image.imageAesKey)) {
      throw new WeixinImageContractError(
        "invalid-response",
        "微信图片 AES key 格式无效",
      );
    }
    return {
      key: Buffer.from(image.imageAesKey, "hex"),
      source: "image-hex",
    };
  }
  if (typeof image.mediaAesKey === "string") {
    return {
      key: parseBase64AesKey(image.mediaAesKey),
      source: "media-base64",
    };
  }
  return { key: undefined, source: "none" };
}

function parseBase64AesKey(value) {
  if (
    value.length > 1_024
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
    || value.length % 4 !== 0
  ) {
    throw new WeixinImageContractError(
      "invalid-response",
      "微信图片 AES key 格式无效",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (
    decoded.length === 32
    && /^[0-9a-fA-F]{32}$/u.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new WeixinImageContractError(
    "invalid-response",
    "微信图片 AES key 长度无效",
  );
}

function decryptImage(value, key) {
  if (value.length === 0 || value.length % 16 !== 0) {
    throw new WeixinImageContractError(
      "invalid-response",
      "微信加密图片正文长度无效",
    );
  }
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(value), decipher.final()]);
  } catch {
    throw new WeixinImageContractError(
      "decrypt-failed",
      "微信图片解密失败",
    );
  }
}

function detectImageType(value) {
  if (
    value.length >= 3
    && value[0] === 0xff
    && value[1] === 0xd8
    && value[2] === 0xff
  ) {
    return "image/jpeg";
  }
  const png = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  return value.length >= png.length && value.subarray(0, png.length).equals(png)
    ? "image/png"
    : undefined;
}

async function readLimitedBytes(response, maximumBytes) {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    const contentLength = Number(rawLength);
    if (
      !Number.isSafeInteger(contentLength)
      || contentLength < 0
      || contentLength > maximumBytes
    ) {
      throw new WeixinImageContractError(
        contentLength > maximumBytes ? "too-large" : "invalid-response",
        contentLength > maximumBytes
          ? "微信图片超过 10 MiB 限制"
          : "微信图片响应长度无效",
      );
    }
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks, bytes);
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new WeixinImageContractError(
          "too-large",
          "微信图片超过 10 MiB 限制",
        );
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
}

async function main(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write([
      "微信图片下载与解密合同探针（隔离验证，不保存图片或密钥）",
      "",
      "用法：",
      "  node scripts/weixin-image-contract-probe.mjs download --live",
      "",
      "运行前请停止 Gateway，避免两个 getupdates 消费者竞争消息。",
      "显式执行后会等待一条已授权完成态图片，在内存下载、按需 AES-128-ECB 解密，",
      "并验证 10 MiB 上限及 PNG/JPEG 签名。",
      "不会输出或保存图片、地址、查询参数、密钥、Token、游标或完整用户标识。",
      "",
    ].join("\n"));
    return 0;
  }
  if (
    argv.length !== 2
    || argv[0] !== "download"
    || argv[1] !== "--live"
  ) {
    process.stderr.write("参数无效；请使用 --help 查看用法。\n");
    return 2;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const connection = await loadConfiguredWeixinContractConnection(
      process.env,
    );
    process.stdout.write(
      "等待一条已授权微信图片；请现在向机器人发送一张 PNG 或 JPEG 图片。\n",
    );
    const result = await runWeixinImageDownloadContract({
      updatesClient: createWeixinUpdatesContractClient(),
      imageClient: createWeixinImageContractClient(),
      ...connection,
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(
      "本次仅在内存验证图片；未保存消息、游标、下载地址、密钥或图片正文。\n",
    );
    return result.download?.kind === "success" ? 0 : 1;
  } catch (error) {
    const message = error instanceof WeixinImageContractError
      || error?.name === "WeixinUpdatesContractError"
      ? error.message
      : "微信图片合同探针失败";
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
