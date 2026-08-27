import { randomBytes, randomUUID } from "node:crypto";

import { Bot } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import {
  resolveHttpProxyUrl,
  resolveProxyEnvironment,
} from "../runtime/network-proxy.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

const tokenPattern = /^\d+:[A-Za-z0-9_-]{30,}$/;
const terminalStates = new Set(["saved", "cancelled", "expired", "failed"]);

export class TelegramSetupSessionError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "TelegramSetupSessionError";
    this.code = code;
    this.field = field;
  }
}

export function createTelegramSetupSession(input, options = {}) {
  return new TelegramSetupSession(input, options);
}

class TelegramSetupSession {
  #abortController = new AbortController();
  #bot;
  #client;
  #configPath;
  #createClient;
  #createPairingCode;
  #document;
  #error;
  #environment;
  #existing;
  #existingFingerprint;
  #expiresAt;
  #listeners = new Set();
  #now;
  #ownerId;
  #pairing;
  #pairingPromise;
  #preview;
  #revision = 0;
  #sessionId;
  #source;
  #state = "created";
  #timeout;
  #timeoutMs;
  #token;
  #validationPromise;
  #writeConfig;

  constructor(input, options) {
    this.#ownerId = requiredOwnerId(input?.ownerId);
    this.#sessionId = options.createSessionId?.() ?? randomUUID();
    this.#timeoutMs = positiveTimeout(input?.timeoutMs ?? 300_000);
    const environment = options.environment ?? process.env;
    this.#environment = environment;
    this.#configPath = requireUserConfig(environment).configPath;
    this.#document = readGatewayConfig(this.#configPath);
    this.#existing = table(this.#document.telegram);
    this.#existingFingerprint = fingerprint(this.#existing);
    this.#createClient = options.createClient ?? createTelegramClient;
    this.#createPairingCode = options.createPairingCode ?? generatePairingCode;
    this.#writeConfig = options.writeConfig ?? writeGatewayConfig;
    this.#now = options.now ?? Date.now;
  }

  start(ownerId, input) {
    this.#assertOwner(ownerId);
    if (this.#state !== "created") throw invalidState("start", this.#state);
    this.#source = setupSource(input?.source);
    const configuredToken = stringValue(this.#existing.bot_token);
    const candidateToken = this.#source === "configured"
      ? configuredToken
      : stringValue(input?.token);
    if (!tokenPattern.test(candidateToken)) {
      throw invalid("invalid-token", "token", "Telegram Bot Token 格式无效");
    }
    this.#token = candidateToken;
    this.#expiresAt = this.#now() + this.#timeoutMs;
    this.#setState("validating");
    this.#timeout = setTimeout(() => this.#expire(), this.#timeoutMs);
    this.#timeout.unref?.();
    this.#validationPromise = this.#runValidation();
    void this.#validationPromise.catch(() => {});
    return this.status(ownerId);
  }

  status(ownerId) {
    this.#assertOwner(ownerId);
    return {
      sessionId: this.#sessionId,
      state: this.#state,
      revision: this.#revision,
      ...(this.#expiresAt === undefined ? {} : { expiresAt: this.#expiresAt }),
      ...(this.#bot === undefined ? {} : { bot: clone(this.#bot) }),
      ...(this.#pairing === undefined ? {} : { pairing: clone(this.#pairing) }),
      ...(this.#preview === undefined ? {} : { preview: clone(this.#preview) }),
      ...(this.#error === undefined ? {} : { error: { ...this.#error } }),
    };
  }

  subscribe(ownerId, listener) {
    this.#assertOwner(ownerId);
    if (typeof listener !== "function") {
      throw invalid("invalid-input", "listener", "Telegram Setup 状态监听器无效");
    }
    this.#listeners.add(listener);
    listener(this.status(ownerId));
    return () => this.#listeners.delete(listener);
  }

  async waitForValidation(ownerId) {
    this.#assertOwner(ownerId);
    if (!this.#validationPromise) {
      throw invalidState("waitForValidation", this.#state);
    }
    await this.#validationPromise;
    return this.status(ownerId);
  }

  startPairing(ownerId, input = {}) {
    this.#assertOwner(ownerId);
    if (this.#state !== "validated" || !this.#client || !this.#bot) {
      throw invalidState("startPairing", this.#state);
    }
    const waitSeconds = positiveWaitSeconds(input.waitSeconds ?? 120);
    this.#pairing = undefined;
    this.#error = undefined;
    this.#setState("preparing-pairing");
    this.#pairingPromise = this.#runPairing(waitSeconds);
    void this.#pairingPromise.catch(() => {});
    return this.status(ownerId);
  }

  async waitForPairing(ownerId) {
    this.#assertOwner(ownerId);
    if (!this.#pairingPromise) {
      throw invalidState("waitForPairing", this.#state);
    }
    await this.#pairingPromise;
    return this.status(ownerId);
  }

  useAllowedUserIds(ownerId, values) {
    this.#assertOwner(ownerId);
    if (!new Set(["validated", "sender-detected", "ready"]).has(this.#state)) {
      throw invalidState("useAllowedUserIds", this.#state);
    }
    this.#setPreview(values);
    return this.status(ownerId);
  }

  acceptPairing(ownerId, input = {}) {
    this.#assertOwner(ownerId);
    const sender = this.#pairing?.sender;
    if (this.#state !== "sender-detected" || !sender) {
      throw invalidState("acceptPairing", this.#state);
    }
    this.#setPreview([sender.id, ...(input.additionalUserIds ?? [])]);
    return this.status(ownerId);
  }

  async confirm(ownerId) {
    this.#assertOwner(ownerId);
    if (this.#state !== "ready" || !this.#preview || !this.#token || !this.#bot) {
      throw invalidState("confirm", this.#state);
    }
    if (this.#now() >= this.#expiresAt) {
      this.#expire();
      throw invalidState("confirm", this.#state);
    }
    const currentDocument = readGatewayConfig(this.#configPath);
    if (fingerprint(table(currentDocument.telegram)) !== this.#existingFingerprint) {
      throw invalid("stale-session", "session", "Telegram 配置已变化，请重新开始 Setup");
    }
    this.#clearTimeout();
    this.#setState("saving");
    const allowedUserIds = [...this.#preview.allowedUserIds];
    try {
      currentDocument.telegram = {
        ...this.#existing,
        bot_token: this.#token,
        allowed_user_ids: allowedUserIds.map(Number),
      };
      this.#writeConfig(this.#configPath, currentDocument);
    } catch (error) {
      this.#fail("save-failed");
      throw error;
    }
    const botUsername = this.#bot.username;
    this.#token = undefined;
    this.#client = undefined;
    this.#pairing = undefined;
    this.#releaseConfigSecrets();
    this.#setState("saved");
    return {
      action: "configured",
      botUsername,
      allowedUserIds,
      configPath: this.#configPath,
      activation: "restart-gateway",
    };
  }

  cancel(ownerId) {
    this.#assertOwner(ownerId);
    if (this.#state === "saving" || this.#state === "saved") {
      throw invalidState("cancel", this.#state);
    }
    if (terminalStates.has(this.#state)) return this.status(ownerId);
    this.#clearTimeout();
    this.#abortController.abort();
    this.#clearSensitiveState();
    this.#setState("cancelled");
    return this.status(ownerId);
  }

  async #runValidation() {
    const token = this.#token;
    try {
      const proxyUrl = resolveTelegramProxy(this.#document, this.#environment);
      const client = this.#createClient(token, proxyUrl);
      const result = await client.getMe(this.#abortController.signal);
      if (this.#state !== "validating") return;
      const username = validateUsername(result?.username);
      const configuredToken = stringValue(this.#existing.bot_token);
      const reusesConfiguredBot = token === configuredToken;
      const configuredAllowedUserIds = reusesConfiguredBot
        ? validConfiguredUserIds(this.#existing.allowed_user_ids)
        : undefined;
      this.#client = client;
      this.#bot = {
        username,
        source: this.#source,
        reusesConfiguredBot,
        ...(configuredAllowedUserIds ? { configuredAllowedUserIds } : {}),
      };
      this.#setState("validated");
    } catch (error) {
      if (this.#abortController.signal.aborted) return;
      const safeMessage = safeErrorMessage(error, token);
      this.#fail("validation-failed");
      throw invalid(
        "validation-failed",
        "token",
        `Telegram Bot 验证请求失败：${safeMessage}`,
      );
    }
  }

  async #runPairing(waitSeconds) {
    try {
      const offset = await discardPendingMessageUpdates(
        this.#client,
        100,
        this.#abortController.signal,
      );
      if (this.#state !== "preparing-pairing") return;
      const pairingCode = validatePairingCode(this.#createPairingCode());
      const link = `https://t.me/${this.#bot.username}?start=${encodeURIComponent(pairingCode)}`;
      this.#pairing = { link };
      this.#setState("waiting-for-message");
      const sender = await waitForPrivateSender(
        this.#client,
        waitSeconds,
        offset,
        pairingCode,
        this.#abortController.signal,
      );
      if (this.#state !== "waiting-for-message") return;
      this.#pairing = { link, sender };
      this.#setState("sender-detected");
    } catch (error) {
      if (this.#abortController.signal.aborted) return;
      const safeMessage = safeErrorMessage(error, this.#token);
      this.#pairing = undefined;
      this.#error = { code: "pairing-failed" };
      this.#setState("validated");
      throw invalid("pairing-failed", "pairing", safeMessage);
    }
  }

  #setPreview(values) {
    const allowedUserIds = normalizeUserIds(values).split(",");
    this.#preview = {
      botUsername: this.#bot.username,
      allowedUserIds,
    };
    this.#pairing = undefined;
    this.#error = undefined;
    this.#setState("ready");
  }

  #expire() {
    if (this.#state === "saving" || this.#state === "saved") return;
    this.#clearTimeout();
    this.#abortController.abort();
    this.#clearSensitiveState();
    this.#setState("expired");
  }

  #fail(code) {
    this.#clearTimeout();
    this.#abortController.abort();
    this.#clearSensitiveState();
    this.#error = { code };
    this.#setState("failed");
  }

  #clearSensitiveState() {
    this.#token = undefined;
    this.#client = undefined;
    this.#pairing = undefined;
    this.#preview = undefined;
    this.#releaseConfigSecrets();
  }

  #releaseConfigSecrets() {
    this.#document = undefined;
    this.#existing = {};
    this.#existingFingerprint = undefined;
  }

  #setState(state) {
    this.#state = state;
    this.#touch();
  }

  #touch() {
    this.#revision += 1;
    const snapshot = this.status(this.#ownerId);
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // 状态观察者不得中断 Telegram 凭据流程。
      }
    }
  }

  #clearTimeout() {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = undefined;
  }

  #assertOwner(ownerId) {
    if (ownerId !== this.#ownerId) {
      throw invalid("owner-mismatch", "ownerId", "Telegram Setup 会话所有者不匹配");
    }
  }
}

function createTelegramClient(token, proxyUrl) {
  const bot = new Bot(token, {
    client: {
      timeoutSeconds: 25,
      ...(proxyUrl
        ? { baseFetchConfig: { agent: new HttpsProxyAgent(proxyUrl) } }
        : {}),
    },
  });
  return {
    getMe: (signal) => bot.api.getMe(signal),
    getUpdates: (parameters, signal) => bot.api.getUpdates(parameters, signal),
  };
}

function generatePairingCode() {
  return randomBytes(16).toString("base64url");
}

export async function discardPendingMessageUpdates(
  client,
  maximumPages = 100,
  signal,
) {
  let offset = 0;
  for (let page = 0; page < maximumPages; page += 1) {
    signal?.throwIfAborted();
    const updates = await client.getUpdates({
      offset,
      timeout: 0,
      limit: 100,
      allowed_updates: ["message"],
    }, signal);
    offset = nextOffset(updates, offset);
    if (updates.length < 100) return offset;
  }
  signal?.throwIfAborted();
  const remaining = await client.getUpdates({
    offset,
    timeout: 0,
    limit: 1,
    allowed_updates: ["message"],
  }, signal);
  if (remaining.length === 0) return offset;
  throw new Error(
    `历史消息更新超过 ${maximumPages * 100} 条，无法安全定位新的 /start`,
  );
}

export async function waitForPrivateSender(
  client,
  waitSeconds = 120,
  initialOffset = 0,
  pairingCode,
  signal,
) {
  if (!pairingCode) throw new Error("缺少 Telegram 一次性配对码");
  let offset = initialOffset;
  const deadline = Date.now() + waitSeconds * 1_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
    const updates = await client.getUpdates({
      offset,
      timeout: Math.min(20, remaining),
      limit: 100,
      allowed_updates: ["message"],
    }, signal);
    offset = nextOffset(updates, offset);
    for (const update of updates) {
      const message = update?.message;
      if (
        message?.chat?.type !== "private"
        || !message.from?.id
        || message.text?.trim() !== `/start ${pairingCode}`
      ) {
        continue;
      }
      return {
        id: String(message.from.id),
        username: message.from.username
          ? String(message.from.username)
          : undefined,
        displayName: [message.from.first_name, message.from.last_name]
          .filter(Boolean)
          .join(" "),
      };
    }
  }
  throw new Error(`等待 ${waitSeconds} 秒仍未收到私聊消息`);
}

export function normalizeUserIds(values) {
  const ids = [];
  for (const raw of values) {
    const value = String(raw).trim();
    if (!value) continue;
    const numericId = Number(value);
    if (
      !/^\d+$/u.test(value)
      || !Number.isSafeInteger(numericId)
      || numericId <= 0
    ) {
      throw new Error(`无效的 Telegram 用户 ID：${value}`);
    }
    if (!ids.includes(value)) ids.push(value);
  }
  if (ids.length === 0) throw new Error("至少需要一个 Telegram 用户 ID");
  return ids.join(",");
}

export function resolveTelegramProxy(
  document,
  environment = process.env,
  options = {},
) {
  const telegram = table(document.telegram);
  const network = table(document.network);
  return resolveHttpProxyUrl(
    stringValue(telegram.proxy_url),
    resolveProxyEnvironment(network, environment, options),
  );
}

function requiredOwnerId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw invalid("invalid-owner", "ownerId", "Telegram Setup 会话所有者无效");
  }
  return value;
}

function positiveTimeout(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 3_600_000) {
    throw invalid("invalid-timeout", "timeoutMs", "Telegram Setup 会话超时时间无效");
  }
  return value;
}

function positiveWaitSeconds(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 600) {
    throw invalid("invalid-wait", "waitSeconds", "Telegram 配对等待时间无效");
  }
  return value;
}

function setupSource(value) {
  if (!new Set(["new", "existing", "configured"]).has(value)) {
    throw invalid("invalid-source", "source", "Telegram Bot 来源无效");
  }
  return value;
}

function validateUsername(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{5,32}$/u.test(value)) {
    throw invalid("invalid-bot", "bot", "Telegram Bot 用户名无效");
  }
  return value;
}

function validatePairingCode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw invalid("invalid-pairing-code", "pairing", "Telegram 一次性配对码无效");
  }
  return value;
}

function validConfiguredUserIds(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  try {
    return normalizeUserIds(value).split(",");
  } catch {
    return undefined;
  }
}

function nextOffset(updates, fallback) {
  return updates.reduce(
    (maximum, update) =>
      Math.max(maximum, Number(update.update_id) + 1),
    fallback,
  );
}

function invalidState(operation, state) {
  return invalid(
    "invalid-state",
    "session",
    `Telegram Setup 会话状态 ${state} 不允许执行 ${operation}`,
  );
}

function invalid(code, field, message) {
  return new TelegramSetupSessionError(code, field, message);
}

function safeErrorMessage(error, token) {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.replaceAll(token, "[REDACTED]") : message;
}

function fingerprint(value) {
  return JSON.stringify(value);
}

function clone(value) {
  return structuredClone(value);
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
