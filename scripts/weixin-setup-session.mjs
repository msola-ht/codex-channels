import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { withPrivateFileLock } from "../runtime/private-file-lock.mjs";
import {
  FIXED_WEIXIN_QR_BASE_URL,
  createWeixinQrContractClient,
  runWeixinQrLoginContract,
} from "./weixin-qr-contract-probe.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

const activeStates = new Set([
  "starting",
  "waiting-for-scan",
  "scanned",
  "verification-required",
]);

export class WeixinSetupSessionError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "WeixinSetupSessionError";
    this.code = code;
    this.field = field;
  }
}

export function createWeixinSetupSession(input, options = {}) {
  return new WeixinSetupSession(input, options);
}

class WeixinSetupSession {
  #abortController = new AbortController();
  #client;
  #configPath;
  #createCredentialStore;
  #credential;
  #dataDir;
  #error;
  #expiresAt;
  #existingFingerprint;
  #existingAllowedUserIds = [];
  #listeners = new Set();
  #loginPromise;
  #now;
  #ownerId;
  #preview;
  #qrCode;
  #revision = 0;
  #runLogin;
  #scannerId;
  #sessionId;
  #state = "created";
  #timeout;
  #timeoutMs;
  #upstreamStatus;
  #validateCredential;
  #verification;
  #verificationRequestId = 0;
  #writeConfig;

  constructor(input, options) {
    this.#ownerId = requiredOwnerId(input?.ownerId);
    this.#sessionId = options.createSessionId?.() ?? randomUUID();
    this.#timeoutMs = positiveTimeout(input?.timeoutMs ?? 480_000);
    const environment = options.environment ?? process.env;
    const paths = requireUserConfig(environment);
    this.#configPath = paths.configPath;
    this.#dataDir = paths.dataDir;
    this.#client = options.client ?? createWeixinQrContractClient();
    this.#runLogin = options.runLogin ?? runWeixinQrLoginContract;
    this.#createCredentialStore = options.createCredentialStore
      ?? loadCredentialStore;
    this.#validateCredential = options.validateCredential
      ?? validatedCredential;
    this.#writeConfig = options.writeConfig ?? writeGatewayConfig;
    this.#now = options.now ?? Date.now;
  }

  start(ownerId) {
    this.#assertOwner(ownerId);
    if (this.#state !== "created") {
      throw invalidState("start", this.#state);
    }
    this.#expiresAt = this.#now() + this.#timeoutMs;
    this.#setState("starting");
    this.#timeout = setTimeout(() => this.#expire(), this.#timeoutMs);
    this.#timeout.unref?.();
    this.#loginPromise = this.#run().catch(() => {});
    return this.status(ownerId);
  }

  status(ownerId) {
    this.#assertOwner(ownerId);
    return {
      sessionId: this.#sessionId,
      state: this.#state,
      revision: this.#revision,
      ...(this.#expiresAt === undefined ? {} : { expiresAt: this.#expiresAt }),
      ...(this.#qrCode === undefined ? {} : { qrCode: this.#qrCode }),
      ...(this.#upstreamStatus === undefined
        ? {}
        : { upstreamStatus: this.#upstreamStatus }),
      ...(this.#state === "verification-required"
        ? { verificationRequestId: this.#verificationRequestId }
        : {}),
      ...(this.#preview === undefined ? {} : { preview: { ...this.#preview } }),
      ...(this.#error === undefined ? {} : { error: { ...this.#error } }),
    };
  }

  subscribe(ownerId, listener) {
    this.#assertOwner(ownerId);
    if (typeof listener !== "function") {
      throw invalid("invalid-input", "listener", "微信 Setup 状态监听器无效");
    }
    this.#listeners.add(listener);
    listener(this.status(ownerId));
    return () => this.#listeners.delete(listener);
  }

  async waitForLogin(ownerId) {
    this.#assertOwner(ownerId);
    if (!this.#loginPromise) throw invalidState("waitForLogin", this.#state);
    await this.#loginPromise;
    return this.status(ownerId);
  }

  provideVerificationCode(ownerId, code) {
    this.#assertOwner(ownerId);
    if (this.#state !== "verification-required" || !this.#verification) {
      throw invalidState("provideVerificationCode", this.#state);
    }
    const normalized = typeof code === "string" ? code.trim() : "";
    if (!/^[0-9]{1,32}$/u.test(normalized)) {
      throw invalid(
        "invalid-verification-code",
        "verificationCode",
        "微信配对码必须是 1 到 32 位数字",
      );
    }
    const verification = this.#verification;
    this.#verification = undefined;
    verification.resolve(normalized);
    this.#setState("scanned");
    return this.status(ownerId);
  }

  async confirm(ownerId, input = {}) {
    return withPrivateFileLock(
      `${this.#configPath}.weixin-setup-transaction`,
      () => this.#confirmUnlocked(ownerId, input),
      { label: "微信 Setup 配置" },
    );
  }

  async #confirmUnlocked(ownerId, input) {
    this.#assertOwner(ownerId);
    if (this.#state !== "ready" || !this.#credential || !this.#scannerId) {
      throw invalidState("confirm", this.#state);
    }
    if (this.#now() >= this.#expiresAt) {
      this.#expire();
      throw invalidState("confirm", this.#state);
    }
    const preserveExistingAllowedUsers = input.preserveExistingAllowedUsers
      === true;
    const currentDocument = readGatewayConfig(this.#configPath);
    const currentExisting = table(currentDocument.weixin);
    if (fingerprint(currentExisting) !== this.#existingFingerprint) {
      throw invalid(
        "stale-session",
        "session",
        "微信配置已变化，请重新开始 Setup",
      );
    }
    this.#clearTimeout();
    this.#setState("saving");
    const allowedUserIds = preserveExistingAllowedUsers
      ? unique([this.#scannerId, ...this.#existingAllowedUserIds])
      : [this.#scannerId];
    const credential = this.#credential;
    let store;
    let previous;
    let credentialWriteAttempted = false;
    try {
      store = await this.#createCredentialStore(
        join(this.#dataDir, "credentials", "weixin"),
      );
      previous = await store.get(credential.accountId);
      credentialWriteAttempted = true;
      await store.set(credential);
      currentDocument.weixin = {
        enabled: false,
        account_id: credential.accountId,
        allowed_user_ids: allowedUserIds,
      };
      this.#writeConfig(this.#configPath, currentDocument);
    } catch (error) {
      const confirmation = confirmWeixinConfig(
        this.#configPath,
        credential.accountId,
        allowedUserIds,
      );
      if (confirmation.applied) {
        // The atomic config write committed; only its caller response failed.
      } else if (confirmation.error !== undefined) {
        this.#fail("save-failed");
        throw new AggregateError(
          [error, confirmation.error],
          "微信配置保存结果无法确认；新凭据已保留，请检查配置后重试",
          { cause: error },
        );
      } else {
        try {
          if (store && credentialWriteAttempted) {
            if (previous) {
              await store.set(previous);
            } else {
              await store.remove(credential.accountId);
            }
          }
        } finally {
          this.#fail("save-failed");
        }
        throw error;
      }
    }
    const warnings = [];
    const oldAccountId = stringValue(currentExisting.account_id);
    if (oldAccountId && oldAccountId !== credential.accountId) {
      try {
        await store.remove(oldAccountId);
      } catch {
        warnings.push({ code: "old-credential-cleanup-failed" });
      }
    }
    this.#credential = undefined;
    this.#qrCode = undefined;
    this.#setState("saved");
    return {
      action: "configured",
      accountId: credential.accountId,
      allowedUserIds,
      configPath: this.#configPath,
      activation: "restart-gateway",
      warnings,
    };
  }

  cancel(ownerId) {
    this.#assertOwner(ownerId);
    if (this.#state === "saved" || this.#state === "saving") {
      throw invalidState("cancel", this.#state);
    }
    if (["cancelled", "expired", "failed", "already-connected"]
      .includes(this.#state)) {
      return this.status(ownerId);
    }
    this.#clearTimeout();
    this.#abortController.abort();
    this.#verification = undefined;
    this.#credential = undefined;
    this.#qrCode = undefined;
    this.#preview = undefined;
    this.#scannerId = undefined;
    this.#existingAllowedUserIds = [];
    this.#setState("cancelled");
    return this.status(ownerId);
  }

  async #run() {
    try {
      const result = await this.#runLogin({
        client: this.#client,
        baseUrl: FIXED_WEIXIN_QR_BASE_URL,
        signal: this.#abortController.signal,
        overallTimeoutMs: this.#timeoutMs,
        displayQr: async (value) => {
          if (!activeStates.has(this.#state)) return;
          this.#qrCode = value;
          this.#setState("waiting-for-scan");
        },
        readVerifyCode: () => this.#readVerificationCode(),
        onStatus: (status) => this.#recordUpstreamStatus(status),
      });
      if (!activeStates.has(this.#state)) return;
      if (result.kind !== "confirmed") {
        this.#qrCode = undefined;
        this.#clearTimeout();
        this.#setState("already-connected");
        return;
      }
      const credential = await this.#validateCredential(result, this.#now());
      if (!activeStates.has(this.#state)) return;
      const scannerId = validateActorId(result.userId);
      const document = readGatewayConfig(this.#configPath);
      const existing = table(document.weixin);
      this.#credential = credential;
      this.#scannerId = scannerId;
      this.#existingFingerprint = fingerprint(existing);
      this.#existingAllowedUserIds = existing.account_id === credential.accountId
        ? validActorIds(existing.allowed_user_ids)
        : [];
      this.#preview = {
        accountId: credential.accountId,
        scannerId,
        credentialConfigured: true,
        existingAllowedUserCount: this.#existingAllowedUserIds.length,
        enabled: false,
      };
      this.#qrCode = undefined;
      this.#setState("ready");
    } catch (error) {
      if (this.#state === "cancelled" || this.#state === "expired") return;
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "login-failed";
      if (code === "login-timeout") {
        this.#expire();
      } else if (code === "aborted" && this.#abortController.signal.aborted) {
        this.#setState("cancelled");
      } else {
        this.#fail(code);
      }
    }
  }

  #readVerificationCode() {
    if (!activeStates.has(this.#state)) {
      return Promise.reject(invalidState("readVerificationCode", this.#state));
    }
    const result = new Promise((resolve) => {
      this.#verification = { resolve };
    });
    this.#verificationRequestId += 1;
    this.#setState("verification-required");
    return result;
  }

  #recordUpstreamStatus(status) {
    if (!activeStates.has(this.#state)) return;
    this.#upstreamStatus = status;
    if (status === "scaned" || status === "scaned_but_redirect") {
      this.#setState("scanned");
    } else {
      this.#touch();
    }
  }

  #expire() {
    if (this.#state === "saved" || this.#state === "saving") return;
    this.#clearTimeout();
    this.#abortController.abort();
    this.#verification = undefined;
    this.#credential = undefined;
    this.#qrCode = undefined;
    this.#preview = undefined;
    this.#scannerId = undefined;
    this.#existingAllowedUserIds = [];
    this.#setState("expired");
  }

  #fail(code) {
    this.#clearTimeout();
    this.#credential = undefined;
    this.#qrCode = undefined;
    this.#preview = undefined;
    this.#scannerId = undefined;
    this.#existingAllowedUserIds = [];
    this.#error = { code };
    this.#setState("failed");
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
        // 状态观察者不得中断凭据流程。
      }
    }
  }

  #clearTimeout() {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = undefined;
  }

  #assertOwner(ownerId) {
    if (ownerId !== this.#ownerId) {
      throw invalid("owner-mismatch", "ownerId", "微信 Setup 会话所有者不匹配");
    }
  }
}

function confirmWeixinConfig(configPath, accountId, allowedUserIds) {
  try {
    const configured = table(readGatewayConfig(configPath).weixin);
    const configuredAllowedUserIds = Array.isArray(configured.allowed_user_ids)
      ? configured.allowed_user_ids
      : [];
    return {
      applied: configured.enabled === false
        && configured.account_id === accountId
        && configuredAllowedUserIds.length === allowedUserIds.length
        && configuredAllowedUserIds.every(
          (value, index) => value === allowedUserIds[index],
        ),
    };
  } catch (error) {
    return { applied: false, error };
  }
}

async function validatedCredential(result, grantedAt) {
  const module = await import("../dist/surfaces/weixin/index.js");
  return {
    version: 1,
    accountId: module.validateWeixinAccountId(result.accountId),
    botToken: requiredString(result.botToken, "微信 Bot Token 无效"),
    baseUrl: module.validateWeixinBaseUrl(result.baseUrl),
    grantedAt,
  };
}

async function loadCredentialStore(directory) {
  const module = await import("../dist/surfaces/weixin/index.js");
  return module.createWeixinCredentialStore(directory);
}

function requiredOwnerId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw invalid("invalid-owner", "ownerId", "微信 Setup 会话所有者无效");
  }
  return value;
}

function positiveTimeout(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 3_600_000) {
    throw invalid("invalid-timeout", "timeoutMs", "微信 Setup 会话超时时间无效");
  }
  return value;
}

function invalidState(operation, state) {
  return invalid(
    "invalid-state",
    "session",
    `微信 Setup 会话状态 ${state} 不允许执行 ${operation}`,
  );
}

function invalid(code, field, message) {
  return new WeixinSetupSessionError(code, field, message);
}

function validateActorId(value) {
  if (
    typeof value !== "string"
    || !/^[^\s@]{1,1000}@im\.wechat$/u.test(value)
  ) {
    throw invalid("invalid-login-result", "scannerId", "微信扫码用户 ID 无效");
  }
  return value;
}

function requiredString(value, message) {
  if (typeof value !== "string" || !value || value.length > 16_384) {
    throw invalid("invalid-login-result", "credential", message);
  }
  return value;
}

function validActorIds(value) {
  return Array.isArray(value)
    ? value.filter((item) =>
        typeof item === "string"
        && /^[^\s@]{1,1000}@im\.wechat$/u.test(item))
    : [];
}

function fingerprint(value) {
  return JSON.stringify(value);
}

function unique(values) {
  return [...new Set(values)];
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
