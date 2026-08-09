import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createWeixinUpdatesContractClient,
  loadConfiguredWeixinContractConnection,
  selectWeixinReplyContext,
} from "./weixin-updates-contract-probe.mjs";

const appClientVersion = (2 << 16) | (4 << 8) | 6;
const maximumResponseBytes = 65_536;
const typingKeepaliveDelayMs = 5_000;
const typingObservationDelayMs = 3_000;

export class WeixinTypingContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WeixinTypingContractError";
    this.code = code;
  }
}

export function createWeixinTypingContractClient({
  fetchImpl = fetch,
  timeoutMs = 10_000,
  randomBytesImpl = randomBytes,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WeixinTypingContractError(
      "invalid-input",
      "微信输入状态请求超时时间无效",
    );
  }

  const requestOptions = {
    fetchImpl,
    timeoutMs,
    randomBytesImpl,
  };
  return {
    async getTypingTicket({
      baseUrl,
      botToken,
      toUserId,
      contextToken,
      signal,
    }) {
      const raw = await requestTypingApi({
        ...requestOptions,
        baseUrl,
        botToken,
        endpoint: "getconfig",
        body: {
          ilink_user_id: requiredString(
            toUserId,
            "微信输入状态目标无效",
            1_024,
          ),
          context_token: requiredString(
            contextToken,
            "微信输入状态上下文无效",
            65_536,
          ),
          base_info: baseInfo(),
        },
        signal,
      });
      return parseTypingTicketResponse(raw);
    },

    async sendTyping({
      baseUrl,
      botToken,
      toUserId,
      typingTicket,
      status,
      signal,
    }) {
      if (status !== 1 && status !== 2) {
        throw new WeixinTypingContractError(
          "invalid-input",
          "微信输入状态值无效",
        );
      }
      const raw = await requestTypingApi({
        ...requestOptions,
        baseUrl,
        botToken,
        endpoint: "sendtyping",
        body: {
          ilink_user_id: requiredString(
            toUserId,
            "微信输入状态目标无效",
            1_024,
          ),
          typing_ticket: requiredString(
            typingTicket,
            "微信输入状态票据无效",
            65_536,
          ),
          status,
          base_info: baseInfo(),
        },
        signal,
      });
      return summarizeTypingResponse(raw);
    },
  };
}

export async function runWeixinTypingLifecycleContract({
  updatesClient,
  typingClient,
  credential,
  allowedUserIds,
  signal,
  waitImpl = waitFor,
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
  const ticketResult = await typingClient.getTypingTicket({
    baseUrl: credential.baseUrl,
    botToken: credential.botToken,
    toUserId: replyContext.toUserId,
    contextToken: replyContext.contextToken,
    signal,
  });
  const config = ticketResult.kind === "success"
    ? {
        kind: "success",
        hasReturnCode: ticketResult.hasReturnCode,
        hasTypingTicket: true,
      }
    : ticketResult;
  if (ticketResult.kind !== "success") {
    return { inbound, config };
  }

  const statuses = [];
  const sendStatus = async (status, label, requestSignal = signal) => {
    const result = await typingClient.sendTyping({
      baseUrl: credential.baseUrl,
      botToken: credential.botToken,
      toUserId: replyContext.toUserId,
      typingTicket: ticketResult.typingTicket,
      status,
      signal: requestSignal,
    });
    statuses.push({ status: label, result });
    return result;
  };

  let typingStarted = false;
  try {
    const started = await sendStatus(1, "typing");
    typingStarted = started.kind === "success";
    if (!typingStarted) {
      return { inbound, config, statuses };
    }
    await waitImpl(typingKeepaliveDelayMs, signal);
    const renewed = await sendStatus(1, "typing");
    if (renewed.kind !== "success") {
      return { inbound, config, statuses };
    }
    await waitImpl(typingObservationDelayMs, signal);
    return { inbound, config, statuses };
  } finally {
    if (typingStarted && !signal?.aborted) {
      await sendStatus(2, "cancel", undefined);
    }
  }
}

export function parseTypingTicketResponse(raw) {
  const value = parseResponseRecord(raw, "微信输入状态配置响应格式无效");
  const status = summarizeResponseRecord(value);
  if (status.kind !== "success") {
    return status;
  }
  if (
    typeof value.typing_ticket !== "string"
    || value.typing_ticket.length === 0
    || value.typing_ticket.length > 65_536
  ) {
    throw new WeixinTypingContractError(
      "invalid-response",
      "微信输入状态配置未返回有效票据",
    );
  }
  return {
    ...status,
    typingTicket: value.typing_ticket,
  };
}

export function summarizeTypingResponse(raw) {
  return summarizeResponseRecord(
    parseResponseRecord(raw, "微信输入状态响应格式无效"),
  );
}

async function requestTypingApi({
  fetchImpl,
  timeoutMs,
  randomBytesImpl,
  baseUrl,
  botToken,
  endpoint,
  body,
  signal,
}) {
  const origin = normalizeBaseUrl(baseUrl);
  const token = requiredString(botToken, "微信 Bot Token 无效", 16_384);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) {
    throw new WeixinTypingContractError(
      "aborted",
      "微信输入状态请求已取消",
    );
  }
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(`${origin}/ilink/bot/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": randomWechatUin(randomBytesImpl),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String(appClientVersion),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new WeixinTypingContractError(
        "http-error",
        `微信输入状态请求失败（HTTP ${response.status}）`,
      );
    }
    return await readLimitedResponseText(response, maximumResponseBytes);
  } catch (error) {
    if (error instanceof WeixinTypingContractError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new WeixinTypingContractError(
        signal?.aborted ? "aborted" : timedOut ? "timeout" : "network-error",
        signal?.aborted
          ? "微信输入状态请求已取消"
          : timedOut
            ? "微信输入状态请求超时"
            : "微信输入状态网络请求失败",
      );
    }
    throw new WeixinTypingContractError(
      "network-error",
      "微信输入状态网络请求失败",
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function parseResponseRecord(raw, message) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WeixinTypingContractError("invalid-response", message);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WeixinTypingContractError("invalid-response", message);
  }
  return value;
}

function summarizeResponseRecord(value) {
  const ret = value.ret;
  if (ret !== undefined && !Number.isSafeInteger(ret)) {
    throw new WeixinTypingContractError(
      "invalid-response",
      "微信输入状态响应返回码无效",
    );
  }
  return ret !== undefined && ret !== 0
    ? { kind: "api-error", ret }
    : { kind: "success", hasReturnCode: ret === 0 };
}

function baseInfo() {
  return {
    channel_version: "2.4.6",
    bot_agent: "CodexConnect/0.147.0",
  };
}

function randomWechatUin(randomBytesImpl) {
  const bytes = randomBytesImpl(4);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 4) {
    throw new WeixinTypingContractError(
      "invalid-input",
      "微信随机请求标识生成失败",
    );
  }
  return Buffer.from(String(bytes.readUInt32BE(0)), "utf8").toString("base64");
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinTypingContractError(
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
    throw new WeixinTypingContractError(
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
    throw new WeixinTypingContractError("invalid-input", message);
  }
  return value;
}

async function readLimitedResponseText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new WeixinTypingContractError(
      "invalid-response",
      "微信输入状态响应正文过大",
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
        throw new WeixinTypingContractError(
          "invalid-response",
          "微信输入状态响应正文过大",
        );
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function waitFor(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WeixinTypingContractError(
        "aborted",
        "微信输入状态观察已取消",
      ));
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new WeixinTypingContractError(
        "aborted",
        "微信输入状态观察已取消",
      ));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function main(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write([
      "微信 getconfig/sendtyping 合同探针（隔离验证，不保存输入状态票据）",
      "",
      "用法：",
      "  node scripts/weixin-typing-contract-probe.mjs lifecycle --live",
      "",
      "显式执行后会读取微信安全凭据，从一条已授权完成态文本中取得内存回复上下文，",
      "依次获取输入状态票据、开始输入状态、5 秒后续期，并在观察后取消。",
      "不会输出或保存正文、Token、context_token、typing_ticket、游标或完整用户标识。",
      "",
    ].join("\n"));
    return 0;
  }
  if (
    argv.length !== 2
    || argv[0] !== "lifecycle"
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
      "等待一条已授权微信文本；请向机器人发送“测试输入状态”。收到后应显示输入状态约 8 秒并取消。\n",
    );
    const result = await runWeixinTypingLifecycleContract({
      updatesClient: createWeixinUpdatesContractClient(),
      typingClient: createWeixinTypingContractClient(),
      ...connection,
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(
      "本次未保存消息、游标、回复上下文或输入状态票据；请在微信中确认开始、保持与取消表现。\n",
    );
    return result.config?.kind === "success"
      && result.statuses?.length === 3
      && result.statuses.every((item) => item.result.kind === "success")
      ? 0
      : 1;
  } catch (error) {
    const message = error instanceof WeixinTypingContractError
      || error?.name === "WeixinUpdatesContractError"
      ? error.message
      : "微信输入状态合同探针失败";
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
