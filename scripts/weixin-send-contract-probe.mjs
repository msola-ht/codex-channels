import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  continueWeixinUpdatesContract,
  createWeixinUpdatesContractClient,
  loadConfiguredWeixinContractConnection,
  selectWeixinReplyContext,
} from "./weixin-updates-contract-probe.mjs";

const appClientVersion = (2 << 16) | (4 << 8) | 6;
const maximumResponseBytes = 65_536;
const probeReplyText = "微信发送合同验证：短文本回复成功。";
const probeSequenceTexts = [
  "微信发送合同验证 1/2：同一上下文连续回复。",
  "微信发送合同验证 2/2：Unicode 中文，emoji 🧪，Markdown **粗体** 与 `code`。",
];
const probeLengthText = createFixedLengthProbeText(4_000);
const probeEchoText = "微信发送合同验证：服务端消息 ID 映射。";

export class WeixinSendContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WeixinSendContractError";
    this.code = code;
  }
}

export function createWeixinSendContractClient({
  fetchImpl = fetch,
  timeoutMs = 15_000,
  randomBytesImpl = randomBytes,
  nowImpl = Date.now,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new WeixinSendContractError(
      "invalid-input",
      "微信发送请求超时时间无效",
    );
  }
  return {
    async sendText({
      baseUrl,
      botToken,
      toUserId,
      contextToken,
      text,
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
        "微信回复目标无效",
        1_024,
      );
      const context = requiredString(
        contextToken,
        "微信回复上下文无效",
        65_536,
      );
      const safeText = requiredString(
        text,
        "微信回复文本无效",
        4_096,
      );
      const clientId = createClientId(randomBytesImpl, nowImpl);
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      if (signal?.aborted) {
        throw new WeixinSendContractError("aborted", "微信发送请求已取消");
      }
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timeout.unref?.();
      try {
        const response = await fetchImpl(`${origin}/ilink/bot/sendmessage`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            AuthorizationType: "ilink_bot_token",
            "X-WECHAT-UIN": randomWechatUin(randomBytesImpl),
            "iLink-App-Id": "bot",
            "iLink-App-ClientVersion": String(appClientVersion),
          },
          body: JSON.stringify({
            msg: {
              from_user_id: "",
              to_user_id: target,
              client_id: clientId,
              message_type: 2,
              message_state: 2,
              item_list: [{
                type: 1,
                text_item: { text: safeText },
              }],
              context_token: context,
            },
            base_info: {
              channel_version: "2.4.6",
              bot_agent: "CodexConnect/0.146.1",
            },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new WeixinSendContractError(
            "http-error",
            `微信发送请求失败（HTTP ${response.status}）`,
          );
        }
        return summarizeSendResponse(
          await readLimitedResponseText(response, maximumResponseBytes),
        );
      } catch (error) {
        if (error instanceof WeixinSendContractError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new WeixinSendContractError(
            signal?.aborted ? "aborted" : timedOut ? "timeout" : "network-error",
            signal?.aborted
              ? "微信发送请求已取消"
              : timedOut
                ? "微信发送请求超时"
                : "微信发送网络请求失败",
          );
        }
        throw new WeixinSendContractError(
          "network-error",
          "微信发送网络请求失败",
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

export async function runWeixinReplyContract({
  updatesClient,
  sendClient,
  credential,
  allowedUserIds,
  signal,
}) {
  const result = await runWeixinReplyTextsContract({
    updatesClient,
    sendClient,
    credential,
    allowedUserIds,
    replyTexts: [probeReplyText],
    signal,
  });
  return result.outbound === undefined
    ? result
    : { inbound: result.inbound, outbound: result.outbound[0] };
}

export async function runWeixinReplySequenceContract({
  updatesClient,
  sendClient,
  credential,
  allowedUserIds,
  signal,
}) {
  return runWeixinReplyTextsContract({
    updatesClient,
    sendClient,
    credential,
    allowedUserIds,
    replyTexts: probeSequenceTexts,
    signal,
  });
}

export async function runWeixinReplyLengthContract({
  updatesClient,
  sendClient,
  credential,
  allowedUserIds,
  signal,
}) {
  return runWeixinReplyTextsContract({
    updatesClient,
    sendClient,
    credential,
    allowedUserIds,
    replyTexts: [probeLengthText],
    signal,
  });
}

export async function runWeixinReplyEchoContract({
  updatesClient,
  sendClient,
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
  const outbound = await sendClient.sendText({
    baseUrl: credential.baseUrl,
    botToken: credential.botToken,
    toUserId: replyContext.toUserId,
    contextToken: replyContext.contextToken,
    text: probeEchoText,
    signal,
  });
  if (outbound.kind !== "success") {
    return { inbound, outbound };
  }
  const echo = await continueWeixinUpdatesContract({
    client: updatesClient,
    previous: inbound,
    baseUrl: credential.baseUrl,
    botToken: credential.botToken,
    signal,
  });
  return { inbound, outbound, echo };
}

async function runWeixinReplyTextsContract({
  updatesClient,
  sendClient,
  credential,
  allowedUserIds,
  replyTexts,
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
  const outbound = [];
  for (const text of replyTexts) {
    const result = await sendClient.sendText({
      baseUrl: credential.baseUrl,
      botToken: credential.botToken,
      toUserId: replyContext.toUserId,
      contextToken: replyContext.contextToken,
      text,
      signal,
    });
    outbound.push(result);
    if (result.kind !== "success") {
      break;
    }
  }
  return { inbound, outbound };
}

function createFixedLengthProbeText(length) {
  const prefix = "微信长度合同验证：4000 字符｜开始｜";
  const suffix = "｜结束";
  const fillerLength = length - prefix.length - suffix.length;
  if (fillerLength < 0) {
    throw new WeixinSendContractError(
      "invalid-input",
      "微信长度探针文本长度无效",
    );
  }
  return `${prefix}${"测".repeat(fillerLength)}${suffix}`;
}

export function summarizeSendResponse(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WeixinSendContractError(
      "invalid-response",
      "微信发送响应不是有效 JSON",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WeixinSendContractError(
      "invalid-response",
      "微信发送响应格式无效",
    );
  }
  const ret = value.ret;
  if (ret !== undefined && !Number.isSafeInteger(ret)) {
    throw new WeixinSendContractError(
      "invalid-response",
      "微信发送响应返回码无效",
    );
  }
  return ret !== undefined && ret !== 0
    ? { kind: "api-error", ret }
    : { kind: "success", hasReturnCode: ret === 0 };
}

function createClientId(randomBytesImpl, nowImpl) {
  const suffix = randomBytesImpl(4);
  if (!Buffer.isBuffer(suffix) || suffix.length !== 4) {
    throw new WeixinSendContractError(
      "invalid-input",
      "微信发送客户端标识生成失败",
    );
  }
  const now = nowImpl();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new WeixinSendContractError(
      "invalid-input",
      "微信发送客户端时间无效",
    );
  }
  return `codex-connect:${now}-${suffix.toString("hex")}`;
}

function randomWechatUin(randomBytesImpl) {
  const bytes = randomBytesImpl(4);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 4) {
    throw new WeixinSendContractError(
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
    throw new WeixinSendContractError("invalid-input", "微信业务 Base URL 无效");
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
    throw new WeixinSendContractError("invalid-input", "微信业务 Base URL 无效");
  }
  return url.origin;
}

function requiredString(value, message, maximumLength) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinSendContractError("invalid-input", message);
  }
  return value;
}

async function readLimitedResponseText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    throw new WeixinSendContractError(
      "invalid-response",
      "微信发送响应正文过大",
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
        throw new WeixinSendContractError(
          "invalid-response",
          "微信发送响应正文过大",
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
      "微信 sendmessage 合同探针（阶段 0，不保存消息或回复上下文）",
      "",
      "用法：",
      "  node scripts/weixin-send-contract-probe.mjs reply --live",
      "  node scripts/weixin-send-contract-probe.mjs sequence --live",
      "  node scripts/weixin-send-contract-probe.mjs limit --live",
      "  node scripts/weixin-send-contract-probe.mjs echo --live",
      "",
      "显式执行后会读取微信安全凭据，从一条已授权完成态文本中取得内存回复上下文，",
      "reply 发送一条固定短文本；sequence 使用同一上下文连续发送两条固定短文本。",
      "limit 发送一条固定 4000 字符中文消息，只验证官方分片值，不探测最大上限。",
      "echo 发送一条固定回复后继续轮询一次，只检查服务端消息 ID 与 client_id 形状。",
      "不会输出或保存正文、Token、context_token、游标、client_id 或完整用户标识。",
      "",
    ].join("\n"));
    return 0;
  }
  if (
    argv.length !== 2
    || !["reply", "sequence", "limit", "echo"].includes(argv[0])
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
      "等待一条已授权微信文本；若没有立即收到重放消息，请现在向机器人发送“测试回复”。\n",
    );
    const contractOptions = {
      updatesClient: createWeixinUpdatesContractClient(),
      sendClient: createWeixinSendContractClient(),
      ...connection,
      signal: controller.signal,
    };
    const result = argv[0] === "sequence"
      ? await runWeixinReplySequenceContract(contractOptions)
      : argv[0] === "limit"
        ? await runWeixinReplyLengthContract(contractOptions)
        : argv[0] === "echo"
          ? await runWeixinReplyEchoContract(contractOptions)
          : await runWeixinReplyContract(contractOptions);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const replyDescription = argv[0] === "sequence"
      ? "两条固定测试回复"
      : argv[0] === "limit"
        ? "一条 4000 字符测试回复"
        : argv[0] === "echo"
          ? "一条固定测试回复，并检查其后续回送"
        : "一条固定测试回复";
    process.stdout.write(
      `本次未保存消息、游标或回复上下文；请在微信中确认是否收到${replyDescription}。\n`,
    );
    const outbound = Array.isArray(result.outbound)
      ? result.outbound
      : result.outbound === undefined
        ? []
        : [result.outbound];
    const expectedCount = argv[0] === "sequence" ? 2 : 1;
    return outbound.length === expectedCount
      && outbound.every((item) => item.kind === "success")
      ? 0
      : 1;
  } catch (error) {
    const message = error instanceof WeixinSendContractError
      || error?.name === "WeixinUpdatesContractError"
      ? error.message
      : "微信发送合同探针失败";
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
