import { createDecipheriv, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createWeixinUpdatesContractClient,
  loadConfiguredWeixinContractConnection,
  selectWeixinFileContext,
} from "./weixin-updates-contract-probe.mjs";

const cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";
const maximumFileBytes = 20 * 1024 * 1024;
const maximumEncryptedFileBytes = maximumFileBytes + 16;
const downloadTimeoutMs = 30_000;

export class WeixinFileContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WeixinFileContractError";
    this.code = code;
  }
}

export function createWeixinFileContractClient({
  fetchImpl = fetch,
  timeoutMs = downloadTimeoutMs,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WeixinFileContractError(
      "invalid-input",
      "微信文件下载超时时间无效",
    );
  }
  return {
    async download(file, signal) {
      const { url, source } = resolveCdnUrl(file);
      const key = parseBase64AesKey(file.mediaAesKey);
      const declaredBytes = parseDeclaredBytes(file.declaredLength);
      if (declaredBytes !== null && declaredBytes > maximumFileBytes) {
        throw new WeixinFileContractError(
          "too-large",
          "微信文件超过探针 20 MiB 安全限制",
        );
      }
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      if (signal?.aborted) {
        throw new WeixinFileContractError("aborted", "微信文件下载已取消");
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
          throw new WeixinFileContractError(
            "http-error",
            `微信文件下载失败（HTTP ${response.status}）`,
          );
        }
        const downloaded = await readLimitedBytes(
          response,
          maximumEncryptedFileBytes,
        );
        const plaintext = decryptFile(downloaded, key);
        if (plaintext.length > maximumFileBytes) {
          throw new WeixinFileContractError(
            "too-large",
            "微信文件超过探针 20 MiB 安全限制",
          );
        }
        const declaredMd5 = parseDeclaredMd5(file.declaredMd5);
        const actualMd5 = createHash("md5").update(plaintext).digest("hex");
        const fileName = summarizeFileName(file.fileName);
        const mime = inferMimeType(file.fileName);
        return {
          kind: "success",
          urlSource: source,
          encryption: "media-base64",
          downloadedBytes: downloaded.length,
          fileBytes: plaintext.length,
          declaredBytes,
          declaredLengthMatches:
            declaredBytes === null ? null : declaredBytes === plaintext.length,
          hasFileName: fileName.hasFileName,
          fileNameShape: fileName.shape,
          mimeType: mime.type,
          mimeSource: mime.source,
          hasDeclaredMd5: declaredMd5 !== null,
          md5Matches: declaredMd5 === null ? null : declaredMd5 === actualMd5,
        };
      } catch (error) {
        if (error instanceof WeixinFileContractError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new WeixinFileContractError(
            signal?.aborted
              ? "aborted"
              : timedOut
                ? "timeout"
                : "network-error",
            signal?.aborted
              ? "微信文件下载已取消"
              : timedOut
                ? "微信文件下载超时"
                : "微信文件下载网络请求失败",
          );
        }
        throw new WeixinFileContractError(
          "network-error",
          "微信文件下载网络请求失败",
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

export async function runWeixinFileDownloadContract({
  updatesClient,
  fileClient,
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
  const file = selectWeixinFileContext(inbound, allowedUserIds);
  const download = await fileClient.download(file, signal);
  return { inbound, download };
}

function resolveCdnUrl(file) {
  if (typeof file.fullUrl === "string") {
    return {
      url: validateCdnUrl(file.fullUrl),
      source: "full-url",
    };
  }
  if (typeof file.encryptedQueryParam !== "string") {
    throw new WeixinFileContractError(
      "invalid-response",
      "微信文件没有可用下载地址",
    );
  }
  const url = new URL(`${cdnBaseUrl}/download`);
  url.searchParams.set(
    "encrypted_query_param",
    file.encryptedQueryParam,
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
    throw new WeixinFileContractError(
      "invalid-response",
      "微信文件下载地址无效",
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
    throw new WeixinFileContractError(
      "invalid-response",
      "微信文件下载地址不属于固定官方 CDN",
    );
  }
  return url;
}

function parseBase64AesKey(value) {
  if (
    typeof value !== "string"
    || value.length > 1_024
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
    || value.length % 4 !== 0
  ) {
    throw new WeixinFileContractError(
      "invalid-response",
      "微信文件 AES key 格式无效",
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
  throw new WeixinFileContractError(
    "invalid-response",
    "微信文件 AES key 长度无效",
  );
}

function parseDeclaredBytes(value) {
  if (value === undefined) {
    return null;
  }
  if (!/^(0|[1-9]\d{0,19})$/u.test(value)) {
    throw new WeixinFileContractError(
      "invalid-response",
      "微信文件声明长度无效",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new WeixinFileContractError(
      "invalid-response",
      "微信文件声明长度无效",
    );
  }
  return parsed;
}

function parseDeclaredMd5(value) {
  if (value === undefined) {
    return null;
  }
  if (!/^[0-9a-fA-F]{32}$/u.test(value)) {
    throw new WeixinFileContractError(
      "invalid-response",
      "微信文件声明 MD5 无效",
    );
  }
  return value.toLowerCase();
}

function decryptFile(value, key) {
  if (value.length === 0 || value.length % 16 !== 0) {
    throw new WeixinFileContractError(
      "invalid-response",
      "微信加密文件正文长度无效",
    );
  }
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(value), decipher.final()]);
  } catch {
    throw new WeixinFileContractError(
      "decrypt-failed",
      "微信文件解密失败",
    );
  }
}

function summarizeFileName(value) {
  if (typeof value !== "string") {
    return { hasFileName: false, shape: "missing" };
  }
  if (value.includes("/") || value.includes("\\")) {
    return { hasFileName: true, shape: "path-like" };
  }
  return {
    hasFileName: true,
    shape: /\.[A-Za-z0-9]{1,16}$/u.test(value)
      ? "basename-with-extension"
      : "basename",
  };
}

function inferMimeType(value) {
  if (typeof value !== "string") {
    return {
      type: "application/octet-stream",
      source: "default",
    };
  }
  const extension = value.toLowerCase().match(/\.([a-z0-9]{1,16})$/u)?.[1];
  const type = extension === undefined ? undefined : ({
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    json: "application/json",
    md: "text/markdown",
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip",
  })[extension];
  return type === undefined
    ? { type: "application/octet-stream", source: "default" }
    : { type, source: "filename-extension" };
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
      throw new WeixinFileContractError(
        contentLength > maximumBytes ? "too-large" : "invalid-response",
        contentLength > maximumBytes
          ? "微信文件超过探针 20 MiB 安全限制"
          : "微信文件响应长度无效",
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
        throw new WeixinFileContractError(
          "too-large",
          "微信文件超过探针 20 MiB 安全限制",
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
      "微信一般文件下载与解密合同探针（隔离验证，不保存文件、正文或密钥）",
      "",
      "用法：",
      "  node scripts/weixin-file-contract-probe.mjs download --live",
      "",
      "运行前请停止 Gateway，避免两个 getupdates 消费者竞争消息。",
      "显式执行后会等待一条已授权完成态一般文件，在内存下载并按 AES-128-ECB 解密，",
      "核对声明长度、MD5，并按文件扩展名推断 MIME。",
      "探针采用 20 MiB 内存安全上限，不把它声明为微信平台限制。",
      "不会输出或保存文件名、文件正文、地址、查询参数、密钥、Token、游标或完整用户标识。",
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
      "等待一条已授权微信一般文件；请现在向机器人发送一个文件。\n",
    );
    const result = await runWeixinFileDownloadContract({
      updatesClient: createWeixinUpdatesContractClient(),
      fileClient: createWeixinFileContractClient(),
      ...connection,
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(
      "本次仅在内存验证文件；未保存消息、游标、文件名、下载地址、密钥或文件正文。\n",
    );
    return result.download?.kind === "success" ? 0 : 1;
  } catch (error) {
    const message = error instanceof WeixinFileContractError
      || error?.name === "WeixinUpdatesContractError"
      ? error.message
      : "微信一般文件合同探针失败";
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
