import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createWeixinUpdatesContractClient,
  loadConfiguredWeixinContractConnection,
  selectWeixinReplyContext,
} from "./weixin-updates-contract-probe.mjs";

const appClientVersion = (2 << 16) | (4 << 8) | 6;
const cdnOrigin = "https://novac2c.cdn.weixin.qq.com";
const cdnUploadPath = "/c2c/upload";
const maximumResponseBytes = 65_536;
const maximumParameterLength = 65_536;
const apiTimeoutMs = 15_000;
const uploadTimeoutMs = 30_000;
const maximumUploadAttempts = 3;
const probePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAa0lEQVR42u3XMQ0AIAxFwapAEgM2MYgEDJSpC4RLGDtw08uPNkf6Vu/pu+0+AAAAAABKgFc+eroHAAAAAKgBlBgAAADAHlBiAAAAAHtAiQEAAADsASUGAAAAsAeUGAAAAMAeUGIAAACAbwAbHFH5Hhhmv2kAAAAASUVORK5CYII=",
  "base64",
);
const probeFile = Buffer.from(
  "Codex Connect 微信文件发送合同验证。\n",
  "utf8",
);
const probeFileName = "codex-connect-weixin-test.txt";

export class WeixinImageSendContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WeixinImageSendContractError";
    this.code = code;
  }
}

export function createWeixinImageSendContractClient({
  fetchImpl = fetch,
  apiRequestTimeoutMs = apiTimeoutMs,
  cdnRequestTimeoutMs = uploadTimeoutMs,
  randomBytesImpl = randomBytes,
  nowImpl = Date.now,
} = {}) {
  validateTimeout(apiRequestTimeoutMs, "微信图片 API 请求超时时间无效");
  validateTimeout(cdnRequestTimeoutMs, "微信图片上传超时时间无效");

  return {
    async sendPng({
      baseUrl,
      botToken,
      toUserId,
      contextToken,
      pngBytes,
      signal,
    }) {
      const origin = normalizeBaseUrl(baseUrl);
      const token = requiredString(
        botToken,
        "微信 Bot Token 无效",
        16_384,
      );
      const target = requiredString(
        toUserId,
        "微信图片回复目标无效",
        1_024,
      );
      const context = requiredString(
        contextToken,
        "微信图片回复上下文无效",
        maximumParameterLength,
      );
      const plaintext = validatePng(pngBytes);
      const aesKey = exactRandomBytes(
        randomBytesImpl,
        16,
        "微信图片 AES key 生成失败",
      );
      const fileKey = exactRandomBytes(
        randomBytesImpl,
        16,
        "微信图片文件标识生成失败",
      ).toString("hex");
      const ciphertext = encryptMedia(plaintext, aesKey);

      const uploadContract = await requestUploadContract({
        fetchImpl,
        timeoutMs: apiRequestTimeoutMs,
        randomBytesImpl,
        origin,
        token,
        target,
        plaintext,
        ciphertext,
        aesKey,
        fileKey,
        signal,
      });
      const uploadTarget = resolveUploadUrl(uploadContract, fileKey);
      const downloadParameter = await uploadCiphertext({
        fetchImpl,
        timeoutMs: cdnRequestTimeoutMs,
        url: uploadTarget.url,
        ciphertext,
        signal,
      });
      const outbound = await sendImageMessage({
        fetchImpl,
        timeoutMs: apiRequestTimeoutMs,
        randomBytesImpl,
        nowImpl,
        origin,
        token,
        target,
        context,
        ciphertext,
        aesKey,
        downloadParameter,
        signal,
      });

      return {
        uploadUrl: {
          kind: "success",
          urlSource: uploadTarget.source,
        },
        cdn: {
          kind: "success",
          hasDownloadParam: true,
          ciphertextBytes: ciphertext.length,
        },
        outbound,
      };
    },
    async sendFile({
      baseUrl,
      botToken,
      toUserId,
      contextToken,
      fileName,
      fileBytes,
      signal,
    }) {
      const origin = normalizeBaseUrl(baseUrl);
      const token = requiredString(
        botToken,
        "微信 Bot Token 无效",
        16_384,
      );
      const target = requiredString(
        toUserId,
        "微信文件回复目标无效",
        1_024,
      );
      const context = requiredString(
        contextToken,
        "微信文件回复上下文无效",
        maximumParameterLength,
      );
      const name = validateFileName(fileName);
      const plaintext = validateFile(fileBytes);
      const aesKey = exactRandomBytes(
        randomBytesImpl,
        16,
        "微信文件 AES key 生成失败",
      );
      const fileKey = exactRandomBytes(
        randomBytesImpl,
        16,
        "微信文件标识生成失败",
      ).toString("hex");
      const ciphertext = encryptMedia(plaintext, aesKey);
      const uploadContract = await requestUploadContract({
        fetchImpl,
        timeoutMs: apiRequestTimeoutMs,
        randomBytesImpl,
        origin,
        token,
        target,
        plaintext,
        ciphertext,
        aesKey,
        fileKey,
        mediaType: 3,
        signal,
      });
      const uploadTarget = resolveUploadUrl(uploadContract, fileKey);
      const downloadParameter = await uploadCiphertext({
        fetchImpl,
        timeoutMs: cdnRequestTimeoutMs,
        url: uploadTarget.url,
        ciphertext,
        signal,
      });
      const outbound = await sendFileMessage({
        fetchImpl,
        timeoutMs: apiRequestTimeoutMs,
        randomBytesImpl,
        nowImpl,
        origin,
        token,
        target,
        context,
        plaintext,
        aesKey,
        downloadParameter,
        fileName: name,
        signal,
      });
      return {
        uploadUrl: {
          kind: "success",
          urlSource: uploadTarget.source,
        },
        cdn: {
          kind: "success",
          hasDownloadParam: true,
          ciphertextBytes: ciphertext.length,
        },
        outbound,
      };
    },
  };
}

export async function runWeixinImageSendContract({
  updatesClient,
  imageSendClient,
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
  const replyContext = selectWeixinReplyContext(inbound, allowedUserIds);
  const result = await imageSendClient.sendPng({
    baseUrl: credential.baseUrl,
    botToken: credential.botToken,
    toUserId: replyContext.toUserId,
    contextToken: replyContext.contextToken,
    pngBytes: probePng,
    signal,
  });
  return { inbound, ...result };
}

export async function runWeixinFileSendContract({
  updatesClient,
  fileSendClient,
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
  const replyContext = selectWeixinReplyContext(inbound, allowedUserIds);
  const result = await fileSendClient.sendFile({
    baseUrl: credential.baseUrl,
    botToken: credential.botToken,
    toUserId: replyContext.toUserId,
    contextToken: replyContext.contextToken,
    fileName: probeFileName,
    fileBytes: probeFile,
    signal,
  });
  return { inbound, ...result };
}

async function requestUploadContract({
  fetchImpl,
  timeoutMs,
  randomBytesImpl,
  origin,
  token,
  target,
  plaintext,
  ciphertext,
  aesKey,
  fileKey,
  mediaType = 1,
  signal,
}) {
  const response = await fetchWithTimeout({
    fetchImpl,
    timeoutMs,
    url: `${origin}/ilink/bot/getuploadurl`,
    init: {
      method: "POST",
      headers: createApiHeaders(token, randomBytesImpl),
      body: JSON.stringify({
        filekey: fileKey,
        media_type: mediaType,
        to_user_id: target,
        rawsize: plaintext.length,
        rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
        filesize: ciphertext.length,
        no_need_thumb: true,
        aeskey: aesKey.toString("hex"),
        base_info: createBaseInfo(),
      }),
    },
    signal,
    timeoutMessage: "微信图片上传地址请求超时",
    networkMessage: "微信图片上传地址网络请求失败",
  });
  if (!response.ok) {
    throw new WeixinImageSendContractError(
      "http-error",
      `微信图片上传地址请求失败（HTTP ${response.status}）`,
    );
  }
  return parseUploadContract(
    await readLimitedResponseText(response, maximumResponseBytes),
  );
}

function parseUploadContract(raw) {
  const value = parseJsonObject(raw, "微信图片上传地址响应格式无效");
  const ret = optionalReturnCode(value.ret, "微信图片上传地址响应返回码无效");
  if (ret !== undefined && ret !== 0) {
    throw new WeixinImageSendContractError(
      "api-error",
      `微信图片上传地址请求失败（返回码 ${ret}）`,
    );
  }
  const uploadFullUrl = optionalString(
    value.upload_full_url,
    "微信图片完整上传地址无效",
    131_072,
  );
  const uploadParameter = optionalString(
    value.upload_param,
    "微信图片上传参数无效",
    maximumParameterLength,
  );
  if (uploadFullUrl === undefined && uploadParameter === undefined) {
    throw new WeixinImageSendContractError(
      "invalid-response",
      "微信图片上传地址响应缺少上传参数",
    );
  }
  return { uploadFullUrl, uploadParameter };
}

function resolveUploadUrl(contract, fileKey) {
  if (contract.uploadFullUrl !== undefined) {
    return {
      url: validateCdnUploadUrl(contract.uploadFullUrl),
      source: "full-url",
    };
  }
  const url = new URL(cdnUploadPath, cdnOrigin);
  url.searchParams.set(
    "encrypted_query_param",
    contract.uploadParameter,
  );
  url.searchParams.set("filekey", fileKey);
  return {
    url: validateCdnUploadUrl(url.href),
    source: "upload-param",
  };
}

function validateCdnUploadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinImageSendContractError(
      "invalid-response",
      "微信图片上传地址无效",
    );
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.origin !== cdnOrigin
    || url.pathname !== cdnUploadPath
    || url.hash
  ) {
    throw new WeixinImageSendContractError(
      "invalid-response",
      "微信图片上传地址不属于固定官方 CDN",
    );
  }
  return url;
}

async function uploadCiphertext({
  fetchImpl,
  timeoutMs,
  url,
  ciphertext,
  signal,
}) {
  let lastError;
  for (let attempt = 0; attempt < maximumUploadAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout({
        fetchImpl,
        timeoutMs,
        url,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
          },
          body: ciphertext,
          redirect: "error",
        },
        signal,
        timeoutMessage: "微信图片 CDN 上传超时",
        networkMessage: "微信图片 CDN 上传网络请求失败",
      });
      if (response.status >= 400 && response.status < 500) {
        throw new WeixinImageSendContractError(
          "http-error",
          `微信图片 CDN 上传失败（HTTP ${response.status}）`,
        );
      }
      if (!response.ok) {
        lastError = new WeixinImageSendContractError(
          "http-error",
          `微信图片 CDN 上传失败（HTTP ${response.status}）`,
        );
        continue;
      }
      const downloadParameter = response.headers.get("x-encrypted-param");
      if (
        typeof downloadParameter !== "string"
        || downloadParameter.length === 0
        || downloadParameter.length > maximumParameterLength
      ) {
        lastError = new WeixinImageSendContractError(
          "invalid-response",
          "微信图片 CDN 上传响应缺少下载参数",
        );
        continue;
      }
      return downloadParameter;
    } catch (error) {
      if (
        error instanceof WeixinImageSendContractError
        && (
          error.code === "aborted"
          || (
            error.code === "http-error"
            && /^微信图片 CDN 上传失败（HTTP 4/u.test(error.message)
          )
        )
      ) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError instanceof WeixinImageSendContractError
    ? lastError
    : new WeixinImageSendContractError(
      "network-error",
      "微信图片 CDN 上传网络请求失败",
    );
}

async function sendImageMessage({
  fetchImpl,
  timeoutMs,
  randomBytesImpl,
  nowImpl,
  origin,
  token,
  target,
  context,
  ciphertext,
  aesKey,
  downloadParameter,
  signal,
}) {
  const response = await fetchWithTimeout({
    fetchImpl,
    timeoutMs,
    url: `${origin}/ilink/bot/sendmessage`,
    init: {
      method: "POST",
      headers: createApiHeaders(token, randomBytesImpl),
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: target,
          client_id: createClientId(randomBytesImpl, nowImpl),
          message_type: 2,
          message_state: 2,
          item_list: [{
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: downloadParameter,
                aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
                encrypt_type: 1,
              },
              mid_size: ciphertext.length,
            },
          }],
          context_token: context,
        },
        base_info: createBaseInfo(),
      }),
    },
    signal,
    timeoutMessage: "微信图片消息发送超时",
    networkMessage: "微信图片消息发送网络请求失败",
  });
  if (!response.ok) {
    throw new WeixinImageSendContractError(
      "http-error",
      `微信图片消息发送失败（HTTP ${response.status}）`,
    );
  }
  return summarizeSendResponse(
    await readLimitedResponseText(response, maximumResponseBytes),
  );
}

async function sendFileMessage({
  fetchImpl,
  timeoutMs,
  randomBytesImpl,
  nowImpl,
  origin,
  token,
  target,
  context,
  plaintext,
  aesKey,
  downloadParameter,
  fileName,
  signal,
}) {
  const response = await fetchWithTimeout({
    fetchImpl,
    timeoutMs,
    url: `${origin}/ilink/bot/sendmessage`,
    init: {
      method: "POST",
      headers: createApiHeaders(token, randomBytesImpl),
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: target,
          client_id: createClientId(randomBytesImpl, nowImpl),
          message_type: 2,
          message_state: 2,
          item_list: [{
            type: 4,
            file_item: {
              media: {
                encrypt_query_param: downloadParameter,
                aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
                encrypt_type: 1,
              },
              file_name: fileName,
              len: String(plaintext.length),
            },
          }],
          context_token: context,
        },
        base_info: createBaseInfo(),
      }),
    },
    signal,
    timeoutMessage: "微信文件消息发送超时",
    networkMessage: "微信文件消息发送网络请求失败",
  });
  if (!response.ok) {
    throw new WeixinImageSendContractError(
      "http-error",
      `微信文件消息发送失败（HTTP ${response.status}）`,
    );
  }
  return summarizeSendResponse(
    await readLimitedResponseText(response, maximumResponseBytes),
  );
}

export function summarizeSendResponse(raw) {
  const value = parseJsonObject(raw, "微信图片发送响应格式无效");
  const ret = optionalReturnCode(value.ret, "微信图片发送响应返回码无效");
  return ret !== undefined && ret !== 0
    ? { kind: "api-error", ret }
    : { kind: "success", hasReturnCode: ret === 0 };
}

function encryptMedia(value, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}

function validatePng(value) {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new WeixinImageSendContractError(
      "invalid-input",
      "微信测试图片无效",
    );
  }
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
  if (!value.subarray(0, signature.length).equals(signature)) {
    throw new WeixinImageSendContractError(
      "invalid-input",
      "微信测试图片不是 PNG",
    );
  }
  return value;
}

function validateFile(value) {
  if (
    !Buffer.isBuffer(value)
    || value.length === 0
    || value.length > 1_000_000
  ) {
    throw new WeixinImageSendContractError(
      "invalid-input",
      "微信测试文件无效",
    );
  }
  return value;
}

function validateFileName(value) {
  const name = requiredString(value, "微信测试文件名无效", 255);
  if (
    name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined
        && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new WeixinImageSendContractError(
      "invalid-input",
      "微信测试文件名无效",
    );
  }
  return name;
}

function createApiHeaders(token, randomBytesImpl) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(randomBytesImpl),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(appClientVersion),
  };
}

function createBaseInfo() {
  return {
    channel_version: "2.4.6",
    bot_agent: "CodexConnect/0.146.0",
  };
}

function createClientId(randomBytesImpl, nowImpl) {
  const suffix = exactRandomBytes(
    randomBytesImpl,
    4,
    "微信图片消息客户端标识生成失败",
  );
  const now = nowImpl();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new WeixinImageSendContractError(
      "invalid-input",
      "微信图片消息客户端时间无效",
    );
  }
  return `codex-connect:${now}-${suffix.toString("hex")}`;
}

function randomWechatUin(randomBytesImpl) {
  const bytes = exactRandomBytes(
    randomBytesImpl,
    4,
    "微信随机请求标识生成失败",
  );
  return Buffer.from(String(bytes.readUInt32BE(0)), "utf8").toString("base64");
}

function exactRandomBytes(randomBytesImpl, length, message) {
  const value = randomBytesImpl(length);
  if (!Buffer.isBuffer(value) || value.length !== length) {
    throw new WeixinImageSendContractError("invalid-input", message);
  }
  return value;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinImageSendContractError(
      "invalid-input",
      "微信业务 Base URL 无效",
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || (
      hostname !== "weixin.qq.com"
      && !hostname.endsWith(".weixin.qq.com")
    )
  ) {
    throw new WeixinImageSendContractError(
      "invalid-input",
      "微信业务 Base URL 无效",
    );
  }
  return url.origin;
}

function requiredString(value, message, maximumLength) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinImageSendContractError("invalid-input", message);
  }
  return value;
}

function optionalString(value, message, maximumLength) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new WeixinImageSendContractError("invalid-response", message);
  }
  return value;
}

function optionalReturnCode(value, message) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    throw new WeixinImageSendContractError("invalid-response", message);
  }
  return value;
}

function parseJsonObject(raw, message) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WeixinImageSendContractError("invalid-response", message);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WeixinImageSendContractError("invalid-response", message);
  }
  return value;
}

function validateTimeout(value, message) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new WeixinImageSendContractError("invalid-input", message);
  }
}

async function fetchWithTimeout({
  fetchImpl,
  timeoutMs,
  url,
  init,
  signal,
  timeoutMessage,
  networkMessage,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) {
    throw new WeixinImageSendContractError(
      "aborted",
      "微信图片发送请求已取消",
    );
  }
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof WeixinImageSendContractError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new WeixinImageSendContractError(
        signal?.aborted ? "aborted" : timedOut ? "timeout" : "network-error",
        signal?.aborted
          ? "微信图片发送请求已取消"
          : timedOut
            ? timeoutMessage
            : networkMessage,
      );
    }
    throw new WeixinImageSendContractError("network-error", networkMessage);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function readLimitedResponseText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new WeixinImageSendContractError(
      "invalid-response",
      "微信图片 API 响应正文过大",
    );
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let value = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return value + decoder.decode();
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new WeixinImageSendContractError(
          "invalid-response",
          "微信图片 API 响应正文过大",
        );
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function main(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write([
      "微信图片与文件反向发送合同探针（隔离验证，不保存正文或密钥）",
      "",
      "用法：",
      "  node scripts/weixin-image-send-contract-probe.mjs send --live",
      "  node scripts/weixin-image-send-contract-probe.mjs file --live",
      "",
      "运行前请停止 Gateway，避免两个 getupdates 消费者竞争消息。",
      "send 会生成固定 PNG；file 会生成固定 UTF-8 文本文件。",
      "两者都按固定 v2.4.6 合同加密上传并发送到同一微信会话。",
      "不会输出或保存正文、上传地址、参数、密钥、Token、游标或完整用户标识。",
      "",
    ].join("\n"));
    return 0;
  }
  if (
    argv.length !== 2
    || (argv[0] !== "send" && argv[0] !== "file")
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
    const fileMode = argv[0] === "file";
    process.stdout.write(fileMode
      ? "等待一条已授权微信文本；请现在向机器人发送“测试文件回复”。\n"
      : "等待一条已授权微信文本；请现在向机器人发送“测试图片回复”。\n");
    const updatesClient = createWeixinUpdatesContractClient();
    const mediaSendClient = createWeixinImageSendContractClient();
    const result = fileMode
      ? await runWeixinFileSendContract({
          updatesClient,
          fileSendClient: mediaSendClient,
          ...connection,
          signal: controller.signal,
        })
      : await runWeixinImageSendContract({
          updatesClient,
          imageSendClient: mediaSendClient,
          ...connection,
          signal: controller.signal,
        });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(
      fileMode
        ? "本次仅在内存验证反向文件；未保存消息、游标、上传参数、密钥或文件正文。\n"
        : "本次仅在内存验证反向图片；未保存消息、游标、上传参数、密钥或图片正文。\n",
    );
    return result.outbound?.kind === "success" ? 0 : 1;
  } catch (error) {
    const message = error instanceof WeixinImageSendContractError
      || error?.name === "WeixinUpdatesContractError"
      ? error.message
      : "微信媒体反向发送合同探针失败";
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
