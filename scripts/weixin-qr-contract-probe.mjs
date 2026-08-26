import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

export const FIXED_WEIXIN_QR_BASE_URL = "https://ilinkai.weixin.qq.com";
export const WEIXIN_QR_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;

const qrStatuses = new Set([
  "wait",
  "scaned",
  "confirmed",
  "expired",
  "scaned_but_redirect",
  "need_verifycode",
  "verify_code_blocked",
  "binded_redirect",
]);
const maximumResponseBytes = 1_048_576;

export class WeixinQrContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WeixinQrContractError";
    this.code = code;
  }
}

export function createWeixinQrContractClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 35_000;
  requiredPositiveNumber(
    requestTimeoutMs,
    "微信二维码请求超时时间无效",
  );

  return {
    async start(params) {
      const baseUrl = normalizeBaseUrl(params.baseUrl);
      const localTokenList = normalizeLocalTokenList(params.localTokenList);
      const response = await requestJson({
        fetchImpl,
        requestTimeoutMs,
        url: `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...qrContractHeaders(),
        },
        body: JSON.stringify({ local_token_list: localTokenList }),
        signal: params.signal,
      });
      return parseQrStartResponse(response);
    },

    async poll(params) {
      const baseUrl = normalizeBaseUrl(params.baseUrl);
      const qrcode = requiredInputString(
        params.qrcode,
        "qrcode",
        16_384,
      );
      const search = new URLSearchParams({ qrcode });
      if (params.verifyCode !== undefined) {
        search.set(
          "verify_code",
          requiredVerifyCode(params.verifyCode),
        );
      }
      try {
        const response = await requestJson({
          fetchImpl,
          requestTimeoutMs,
          url: `${baseUrl}/ilink/bot/get_qrcode_status?${search.toString()}`,
          method: "GET",
          headers: qrContractHeaders(),
          signal: params.signal,
        });
        return parseQrStatusResponse(response);
      } catch (error) {
        if (
          error instanceof WeixinQrContractError
          && error.code === "timeout"
        ) {
          return {
            status: "wait",
            timedOut: true,
          };
        }
        throw error;
      }
    },
  };
}

export async function runWeixinQrLoginContract(options) {
  const overallTimeoutMs = options.overallTimeoutMs ?? 480_000;
  if (!Number.isFinite(overallTimeoutMs) || overallTimeoutMs <= 0) {
    throw new WeixinQrContractError(
      "invalid-input",
      "微信二维码整体超时时间无效",
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener(
      "abort",
      onExternalAbort,
      { once: true },
    );
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, overallTimeoutMs);
  timeout.unref?.();
  try {
    return await runWeixinQrLoginContractLoop({
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new WeixinQrContractError(
        "login-timeout",
        "微信二维码登录合同验证超时",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function runWeixinQrLoginContractLoop(options) {
  const client = options.client;
  const initialBaseUrl = normalizeBaseUrl(options.baseUrl);
  const displayQr = options.displayQr;
  const readVerifyCode = options.readVerifyCode;
  const onStatus = options.onStatus ?? (() => {});
  const maxRefreshes = options.maxRefreshes ?? 3;
  const pollDelayMs = options.pollDelayMs ?? 1_000;
  if (!Number.isInteger(maxRefreshes) || maxRefreshes < 0) {
    throw new WeixinQrContractError(
      "invalid-input",
      "微信二维码刷新次数上限无效",
    );
  }
  requiredNonNegativeNumber(
    pollDelayMs,
    "微信二维码轮询间隔无效",
  );
  const signal = options.signal;
  let refreshes = 0;
  let currentBaseUrl = initialBaseUrl;
  let verifyCode;

  let session = await client.start({
    baseUrl: initialBaseUrl,
    localTokenList: options.localTokenList ?? [],
    signal,
  });
  await displayQr(session.qrcodeImageContent);

  while (true) {
    throwIfAborted(signal);
    const status = await client.poll({
      baseUrl: currentBaseUrl,
      qrcode: session.qrcode,
      ...(verifyCode === undefined ? {} : { verifyCode }),
      signal,
    });
    onStatus(status.status);

    switch (status.status) {
      case "wait":
      case "scaned":
        await abortableDelay(pollDelayMs, signal);
        break;
      case "need_verifycode":
        verifyCode = requiredVerifyCode(await abortableResult(
          readVerifyCode(signal),
          signal,
        ));
        break;
      case "scaned_but_redirect":
        currentBaseUrl = `https://${status.redirectHost}`;
        break;
      case "expired":
      case "verify_code_blocked":
        if (refreshes >= maxRefreshes) {
          throw new WeixinQrContractError(
            "refresh-limit",
            "微信二维码刷新次数已达到上限",
          );
        }
        refreshes += 1;
        verifyCode = undefined;
        currentBaseUrl = initialBaseUrl;
        session = await client.start({
          baseUrl: initialBaseUrl,
          localTokenList: options.localTokenList ?? [],
          signal,
        });
        await displayQr(session.qrcodeImageContent);
        break;
      case "binded_redirect":
        return {
          kind: "already-connected",
        };
      case "confirmed":
        return {
          kind: "confirmed",
          botToken: status.botToken,
          accountId: status.accountId,
          ...(status.userId === undefined ? {} : { userId: status.userId }),
          ...(status.baseUrl === undefined ? {} : { baseUrl: status.baseUrl }),
        };
      default:
        throw new WeixinQrContractError(
          "invalid-response",
          "微信二维码状态不受支持",
        );
    }
  }
}

function qrContractHeaders() {
  return {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(WEIXIN_QR_APP_CLIENT_VERSION),
  };
}

function normalizeLocalTokenList(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 10) {
    throw new WeixinQrContractError(
      "invalid-input",
      "微信本地 Token 列表格式无效",
    );
  }
  return value.map((token) =>
    requiredInputString(token, "local_token_list", 16_384));
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinQrContractError(
      "invalid-input",
      "微信二维码 Base URL 无效",
    );
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new WeixinQrContractError(
      "invalid-input",
      "微信二维码 Base URL 必须是无路径的 HTTPS Origin",
    );
  }
  return url.origin;
}

function parseQrStartResponse(value) {
  const record = requiredRecord(value);
  return {
    qrcode: requiredString(record.qrcode, "qrcode", 16_384),
    qrcodeImageContent: requiredString(
      record.qrcode_img_content,
      "qrcode_img_content",
      65_536,
    ),
  };
}

function parseQrStatusResponse(value) {
  const record = requiredRecord(value);
  const status = requiredString(record.status, "status", 64);
  if (!qrStatuses.has(status)) {
    throw new WeixinQrContractError(
      "invalid-response",
      "微信二维码状态不受支持",
    );
  }
  if (status === "confirmed") {
    return {
      status,
      botToken: requiredString(record.bot_token, "bot_token", 16_384),
      accountId: requiredString(record.ilink_bot_id, "ilink_bot_id", 1_024),
      ...optionalStringField(record, "ilink_user_id", "userId", 1_024),
      ...optionalUrlField(record, "baseurl", "baseUrl"),
    };
  }
  if (status === "scaned_but_redirect") {
    return {
      status,
      redirectHost: requiredRedirectHost(record.redirect_host),
    };
  }
  return { status };
}

function requiredRecord(value) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new WeixinQrContractError(
      "invalid-response",
      "微信二维码响应格式无效",
    );
  }
  return value;
}

function requiredString(value, field, maximumLength) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinQrContractError(
      "invalid-response",
      `微信二维码响应字段 ${field} 无效`,
    );
  }
  return value;
}

function requiredInputString(value, field, maximumLength) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinQrContractError(
      "invalid-input",
      `微信二维码输入字段 ${field} 无效`,
    );
  }
  return value;
}

function optionalStringField(record, source, target, maximumLength) {
  if (record[source] === undefined) {
    return {};
  }
  return {
    [target]: requiredString(record[source], source, maximumLength),
  };
}

function optionalUrlField(record, source, target) {
  if (record[source] === undefined) {
    return {};
  }
  return {
    [target]: normalizeResponseUrl(record[source], source),
  };
}

function normalizeResponseUrl(value, field) {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new WeixinQrContractError(
      "invalid-response",
      `微信二维码响应字段 ${field} 无效`,
    );
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinQrContractError(
      "invalid-response",
      `微信二维码响应字段 ${field} 无效`,
    );
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new WeixinQrContractError(
      "invalid-response",
      `微信二维码响应字段 ${field} 无效`,
    );
  }
  return url.toString().replace(/\/$/u, "");
}

function requiredRedirectHost(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 253
    || !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(value)
  ) {
    throw new WeixinQrContractError(
      "invalid-response",
      "微信二维码重定向主机无效",
    );
  }
  const url = new URL(`https://${value}`);
  const hostname = url.hostname.toLowerCase();
  if (
    url.host !== value
    || url.pathname !== "/"
    || url.port
    || (
      hostname !== "weixin.qq.com"
      && !hostname.endsWith(".weixin.qq.com")
    )
  ) {
    throw new WeixinQrContractError(
      "invalid-response",
      "微信二维码重定向主机无效",
    );
  }
  return value;
}

function requiredVerifyCode(value) {
  if (typeof value !== "string" || !/^[0-9]{1,32}$/u.test(value)) {
    throw new WeixinQrContractError(
      "invalid-input",
      "微信配对码必须是 1 到 32 位数字",
    );
  }
  return value;
}

function requiredPositiveNumber(value, message) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new WeixinQrContractError("invalid-input", message);
  }
  return value;
}

function requiredNonNegativeNumber(value, message) {
  if (!Number.isFinite(value) || value < 0) {
    throw new WeixinQrContractError("invalid-input", message);
  }
  return value;
}

async function requestJson(params) {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (params.signal?.aborted) {
    throw new WeixinQrContractError("aborted", "微信二维码探针已取消");
  }
  params.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, params.requestTimeoutMs);
  timeout.unref?.();
  try {
    const response = await params.fetchImpl(params.url, {
      method: params.method,
      headers: params.headers,
      ...(params.body === undefined ? {} : { body: params.body }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new WeixinQrContractError(
        "http-error",
        `微信二维码请求失败（HTTP ${response.status}）`,
      );
    }
    const raw = await readLimitedResponseText(
      response,
      maximumResponseBytes,
    );
    try {
      return JSON.parse(raw);
    } catch {
      throw new WeixinQrContractError(
        "invalid-response",
        "微信二维码响应不是有效 JSON",
      );
    }
  } catch (error) {
    if (error instanceof WeixinQrContractError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      if (params.signal?.aborted) {
        throw new WeixinQrContractError(
          "aborted",
          "微信二维码探针已取消",
        );
      }
      if (timedOut) {
        throw new WeixinQrContractError(
          "timeout",
          "微信二维码请求超时",
        );
      }
    }
    throw new WeixinQrContractError(
      "network-error",
      "微信二维码网络请求失败",
    );
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function readLimitedResponseText(response, maximumBytes) {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && Number.isFinite(Number(contentLength))
    && Number(contentLength) > maximumBytes
  ) {
    throw new WeixinQrContractError(
      "invalid-response",
      "微信二维码响应正文过大",
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
        throw new WeixinQrContractError(
          "invalid-response",
          "微信二维码响应正文过大",
        );
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new WeixinQrContractError("aborted", "微信二维码探针已取消");
  }
}

function abortableDelay(delayMs, signal) {
  if (delayMs <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      reject(new WeixinQrContractError(
        "aborted",
        "微信二维码探针已取消",
      ));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortableResult(result, signal) {
  if (!signal) return Promise.resolve(result);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(new WeixinQrContractError(
        "aborted",
        "微信二维码探针已取消",
      ));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(result).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function main(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write([
      "微信二维码合同探针（阶段 0，不写入凭据）",
      "",
      "用法：",
      "  node scripts/weixin-qr-contract-probe.mjs qr --live",
      "",
      "只有显式传入 qr --live 才会访问固定的腾讯微信端点。",
      "重新连接可能删除该微信账号已有的机器人连接，运行时仍需再次确认。",
      "成功返回的 Bot Token 仅保存在当前进程内存，退出即丢弃。",
      "",
    ].join("\n"));
    return 0;
  }
  if (argv.length !== 2 || argv[0] !== "qr" || argv[1] !== "--live") {
    process.stderr.write("参数无效；请使用 --help 查看阶段 0 探针用法。\n");
    return 2;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const confirmation = await prompt.question([
      "警告：微信可能用本次新连接替换并删除该账号已有的机器人连接。",
      "如需继续，请输入“继续”：",
    ].join("\n"));
    if (confirmation.trim() !== "继续") {
      process.stdout.write("已取消，未请求微信二维码。\n");
      return 0;
    }
    const client = createWeixinQrContractClient();
    const result = await runWeixinQrLoginContract({
      client,
      baseUrl: FIXED_WEIXIN_QR_BASE_URL,
      signal: controller.signal,
      displayQr: async (value) => {
        const { default: qrcode } = await import("qrcode");
        process.stdout.write(
          `${await qrcode.toString(value, { type: "terminal", small: true })}\n`,
        );
      },
      readVerifyCode: async () =>
        prompt.question("请输入手机微信显示的数字："),
      onStatus: (status) => {
        if (status === "scaned") {
          process.stdout.write("二维码已扫描，等待确认。\n");
        } else if (status === "expired") {
          process.stdout.write("二维码已过期，正在刷新。\n");
        } else if (status === "scaned_but_redirect") {
          process.stdout.write("微信要求切换状态轮询节点。\n");
        } else if (status === "need_verifycode") {
          process.stdout.write("微信要求输入配对码。\n");
        }
      },
    });
    if (result.kind === "already-connected") {
      process.stdout.write("微信返回已连接状态；本次未签发新凭据。\n");
      return 0;
    }
    process.stdout.write([
      "微信二维码合同确认成功（未保存凭据）。",
      `账号 ID：${result.accountId}`,
      `扫码者 ID：${result.userId ?? "未返回"}`,
      `业务 Base URL：${result.baseUrl ?? "未返回"}`,
      "Bot Token：已收到，仅存在当前进程内存",
      "",
    ].join("\n"));
    return 0;
  } catch (error) {
    const message = error instanceof WeixinQrContractError
      ? error.message
      : "微信二维码合同探针失败";
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    prompt.close();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
