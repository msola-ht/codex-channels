import { randomUUID } from "node:crypto";

import { registerApp } from "@larksuiteoapi/node-sdk";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { validateFeishuApplication } from "./feishu-application.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

const appIdPattern = /^cli_[0-9a-fA-F]{16}$/u;
const openIdPattern = /^ou_.+$/u;
const terminalStates = new Set(["saved", "cancelled", "expired", "failed"]);
const registrationAddons = {
  preset: false,
  scopes: {
    tenant: [
      "application:application:self_manage",
      "application:application:patch",
      "im:message:send_as_bot",
      "im:message.p2p_msg:readonly",
      "im:resource",
      "im:message:readonly",
      "cardkit:card:write",
    ],
  },
  events: {
    items: {
      tenant: [
        "im.message.receive_v1",
        "application.bot.menu_v6",
      ],
    },
  },
  callbacks: {
    items: ["card.action.trigger"],
  },
};

export class FeishuSetupSessionError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "FeishuSetupSessionError";
    this.code = code;
    this.field = field;
  }
}

export function createFeishuSetupSession(input, options = {}) {
  return new FeishuSetupSession(input, options);
}

class FeishuSetupSession {
  #abortController = new AbortController();
  #application;
  #authorization;
  #configPath;
  #configureApplication;
  #credential;
  #document;
  #error;
  #existing;
  #existingFingerprint;
  #expiresAt;
  #listeners = new Set();
  #mode;
  #now;
  #ownerId;
  #preview;
  #registerApplication;
  #registrationStatus;
  #revision = 0;
  #sessionId;
  #state = "created";
  #timeout;
  #timeoutMs;
  #validateApplication;
  #workflowPromise;
  #writeConfig;

  constructor(input, options) {
    this.#ownerId = requiredOwnerId(input?.ownerId);
    this.#sessionId = options.createSessionId?.() ?? randomUUID();
    this.#timeoutMs = positiveTimeout(input?.timeoutMs ?? 600_000);
    const environment = options.environment ?? process.env;
    this.#configPath = requireUserConfig(environment).configPath;
    this.#document = readGatewayConfig(this.#configPath);
    this.#existing = table(this.#document.feishu);
    this.#existingFingerprint = fingerprint(this.#existing);
    this.#registerApplication = options.registerApplication ?? registerApp;
    this.#validateApplication = options.validateApplication
      ?? validateFeishuApplication;
    this.#configureApplication = options.configureApplication
      ?? configureFeishuApplication;
    this.#writeConfig = options.writeConfig ?? writeGatewayConfig;
    this.#now = options.now ?? Date.now;
  }

  start(ownerId, input) {
    this.#assertOwner(ownerId);
    if (this.#state !== "created") throw invalidState("start", this.#state);
    const mode = setupMode(input?.mode);
    let manualCredential;
    if (mode === "manual") {
      manualCredential = validateManualCredential(input);
    }
    this.#mode = mode;
    this.#credential = manualCredential;
    this.#expiresAt = this.#now() + this.#timeoutMs;
    this.#setState(mode === "scan" ? "registering" : "validating");
    this.#timeout = setTimeout(() => this.#expire(), this.#timeoutMs);
    this.#timeout.unref?.();
    this.#workflowPromise = this.#run();
    void this.#workflowPromise.catch(() => {});
    return this.status(ownerId);
  }

  status(ownerId) {
    this.#assertOwner(ownerId);
    return {
      sessionId: this.#sessionId,
      state: this.#state,
      revision: this.#revision,
      ...(this.#expiresAt === undefined ? {} : { expiresAt: this.#expiresAt }),
      ...(this.#registrationStatus === undefined
        ? {}
        : { registrationStatus: this.#registrationStatus }),
      ...(this.#authorization === undefined
        ? {}
        : { authorization: clone(this.#authorization) }),
      ...(this.#application === undefined
        ? {}
        : { application: clone(this.#application) }),
      ...(this.#preview === undefined ? {} : { preview: clone(this.#preview) }),
      ...(this.#error === undefined ? {} : { error: { ...this.#error } }),
    };
  }

  subscribe(ownerId, listener) {
    this.#assertOwner(ownerId);
    if (typeof listener !== "function") {
      throw invalid("invalid-input", "listener", "飞书 Setup 状态监听器无效");
    }
    this.#listeners.add(listener);
    listener(this.status(ownerId));
    return () => this.#listeners.delete(listener);
  }

  async waitForReady(ownerId) {
    this.#assertOwner(ownerId);
    if (!this.#workflowPromise) throw invalidState("waitForReady", this.#state);
    await this.#workflowPromise;
    return this.status(ownerId);
  }

  useAllowedOpenIds(ownerId, values) {
    this.#assertOwner(ownerId);
    if (
      this.#mode !== "manual"
      || !new Set(["validated", "ready"]).has(this.#state)
      || !this.#application
    ) {
      throw invalidState("useAllowedOpenIds", this.#state);
    }
    this.#preview = {
      enabled: true,
      appId: this.#application.appId,
      botName: this.#application.botName,
      allowedOpenIds: normalizeOpenIds(values),
    };
    this.#setState("ready");
    return this.status(ownerId);
  }

  async confirm(ownerId) {
    this.#assertOwner(ownerId);
    if (this.#state !== "ready" || !this.#preview || !this.#credential) {
      throw invalidState("confirm", this.#state);
    }
    if (this.#now() >= this.#expiresAt) {
      this.#expire();
      throw invalidState("confirm", this.#state);
    }
    const currentDocument = readGatewayConfig(this.#configPath);
    if (fingerprint(table(currentDocument.feishu)) !== this.#existingFingerprint) {
      throw invalid("stale-session", "session", "飞书配置已变化，请重新开始 Setup");
    }
    this.#clearTimeout();
    this.#setState("saving");
    const credential = this.#credential;
    const allowedOpenIds = [...this.#preview.allowedOpenIds];
    try {
      currentDocument.feishu = {
        ...this.#existing,
        enabled: true,
        app_id: credential.appId,
        app_secret: credential.appSecret,
        allowed_open_ids: allowedOpenIds,
      };
      this.#writeConfig(this.#configPath, currentDocument);
    } catch (error) {
      this.#fail("save-failed");
      throw error;
    }

    let applicationConfiguration = "not-requested";
    const warnings = [];
    if (this.#mode === "scan") {
      this.#setState("configuring-application");
      try {
        const configured = await this.#configureApplication(
          { appId: credential.appId, appSecret: credential.appSecret },
          { signal: this.#abortController.signal },
        );
        applicationConfiguration = configured?.changed === true
          ? "updated"
          : "unchanged";
      } catch {
        applicationConfiguration = "failed";
        warnings.push({ code: "application-configuration-failed" });
      }
    }
    const appId = credential.appId;
    this.#releaseSecrets();
    this.#setState("saved");
    return {
      action: "configured",
      appId,
      allowedOpenIds,
      configPath: this.#configPath,
      activation: "restart-gateway",
      applicationConfiguration,
      warnings,
    };
  }

  cancel(ownerId) {
    this.#assertOwner(ownerId);
    if (new Set(["saving", "configuring-application", "saved"])
      .has(this.#state)) {
      throw invalidState("cancel", this.#state);
    }
    if (terminalStates.has(this.#state)) return this.status(ownerId);
    this.#clearTimeout();
    this.#abortController.abort();
    this.#releaseSecrets();
    this.#setState("cancelled");
    return this.status(ownerId);
  }

  async #run() {
    try {
      if (this.#mode === "scan") {
        this.#credential = await this.#registerScanApplication();
        if (!activeState(this.#state)) return;
        this.#setState("validating");
      }
      const bot = await this.#validateBot();
      if (!activeState(this.#state)) return;
      const configuredAllowedOpenIds = this.#mode === "manual"
        ? validConfiguredOpenIds(this.#existing.allowed_open_ids)
        : [];
      this.#application = {
        mode: this.#mode,
        appId: this.#credential.appId,
        botName: bot.name,
        ...(configuredAllowedOpenIds.length === 0
          ? {}
          : { configuredAllowedOpenIds }),
      };
      this.#authorization = undefined;
      if (this.#mode === "scan") {
        this.#preview = {
          enabled: true,
          appId: this.#credential.appId,
          botName: bot.name,
          allowedOpenIds: [this.#credential.openId],
        };
        this.#setState("ready");
      } else {
        this.#setState("validated");
      }
    } catch (error) {
      if (this.#abortController.signal.aborted) return;
      const normalized = normalizeSessionError(error);
      if (normalized.code === "expired") {
        this.#expire();
      } else {
        this.#fail(normalized.code);
      }
      throw normalized;
    }
  }

  async #registerScanApplication() {
    let registration;
    try {
      registration = await this.#registerApplication({
        source: "codexc",
        signal: this.#abortController.signal,
        addons: clone(registrationAddons),
        onQRCodeReady: ({ url, expireIn }) => {
          if (!activeState(this.#state)) return;
          this.#authorization = {
            url: validateAuthorizationUrl(url),
            expiresInSeconds: positiveInteger(expireIn, 600),
          };
          this.#setState("waiting-for-authorization");
        },
        onStatusChange: ({ status }) => {
          if (!activeState(this.#state)) return;
          const normalizedStatus = registrationStatus(status);
          if (normalizedStatus === undefined) return;
          this.#registrationStatus = normalizedStatus;
          this.#touch();
        },
      });
    } catch (error) {
      throw registrationFailure(error);
    }
    return validateRegistration(registration);
  }

  async #validateBot() {
    try {
      const bot = await this.#validateApplication({
        appId: this.#credential.appId,
        appSecret: this.#credential.appSecret,
      }, { signal: this.#abortController.signal });
      const openId = stringValue(bot?.openId);
      if (!openIdPattern.test(openId)) throw new Error("invalid bot identity");
      return {
        openId,
        name: stringValue(bot?.name) || "已验证",
      };
    } catch {
      throw invalid(
        "validation-failed",
        "credential",
        "飞书应用凭据或机器人身份验证失败",
      );
    }
  }

  #expire() {
    if (new Set(["saving", "configuring-application", "saved"])
      .has(this.#state)) return;
    this.#clearTimeout();
    this.#abortController.abort();
    this.#releaseSecrets();
    this.#setState("expired");
  }

  #fail(code) {
    this.#clearTimeout();
    this.#abortController.abort();
    this.#releaseSecrets();
    this.#error = { code };
    this.#setState("failed");
  }

  #releaseSecrets() {
    this.#credential = undefined;
    this.#authorization = undefined;
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
        // 状态观察者不得中断飞书凭据流程。
      }
    }
  }

  #clearTimeout() {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = undefined;
  }

  #assertOwner(ownerId) {
    if (ownerId !== this.#ownerId) {
      throw invalid("owner-mismatch", "ownerId", "飞书 Setup 会话所有者不匹配");
    }
  }
}

export function normalizeOpenIds(values) {
  const openIds = [];
  for (const raw of values) {
    const value = String(raw).trim();
    if (!value) continue;
    if (!openIdPattern.test(value)) {
      throw new Error(`无效的飞书用户 Open ID：${value}`);
    }
    if (!openIds.includes(value)) openIds.push(value);
  }
  if (openIds.length === 0) throw new Error("至少需要一个飞书用户 Open ID");
  return openIds;
}

async function configureFeishuApplication(
  { appId, appSecret },
  { signal } = {},
) {
  const { FeishuApplicationHttpApi } = await import(
    "../dist/surfaces/feishu/index.js"
  );
  return new FeishuApplicationHttpApi({
    appId,
    appSecret,
  }).configureApplication(signal);
}

function validateManualCredential(input) {
  const appId = stringValue(input?.appId);
  const appSecret = stringValue(input?.appSecret);
  if (!appIdPattern.test(appId)) {
    throw invalid("invalid-app-id", "appId", "飞书 App ID 格式无效");
  }
  if (!appSecret) {
    throw invalid("invalid-app-secret", "appSecret", "飞书 App Secret 不能为空");
  }
  return { appId, appSecret };
}

function validateRegistration(value) {
  if (!value || typeof value !== "object") {
    throw invalid("invalid-registration", "registration", "飞书扫码注册返回无效");
  }
  const appId = stringValue(value.client_id);
  const appSecret = stringValue(value.client_secret);
  const openId = stringValue(value.user_info?.open_id);
  if (!appIdPattern.test(appId) || !appSecret || !openIdPattern.test(openId)) {
    throw invalid(
      "invalid-registration",
      "registration",
      "飞书扫码注册返回缺少有效的应用凭据或用户 Open ID",
    );
  }
  if (value.user_info?.tenant_brand === "lark") {
    throw invalid("unsupported-tenant", "registration", "当前项目暂不支持 Lark 租户");
  }
  return { appId, appSecret, openId };
}

function registrationFailure(error) {
  if (error instanceof FeishuSetupSessionError) return error;
  switch (errorCode(error)) {
    case "access_denied":
      return invalid("access-denied", "authorization", "飞书扫码授权已被拒绝");
    case "expired_token":
      return invalid("expired", "authorization", "飞书扫码授权已过期");
    case "abort":
      return invalid("cancelled", "authorization", "飞书扫码授权已取消或超时");
    default:
      return invalid("registration-failed", "authorization", "飞书扫码注册失败");
  }
}

function normalizeSessionError(error) {
  return error instanceof FeishuSetupSessionError
    ? error
    : invalid("setup-failed", "session", "飞书 Setup 失败");
}

function validateAuthorizationUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("invalid-authorization-url", "authorization", "飞书扫码授权地址无效");
  }
  if (
    parsed.protocol !== "https:"
    || !["feishu.cn", "larksuite.com"].some((domain) =>
      parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))
  ) {
    throw invalid(
      "invalid-authorization-url",
      "authorization",
      "飞书扫码授权地址来源无效",
    );
  }
  return parsed.toString();
}

function registrationStatus(value) {
  const statuses = {
    polling: "polling",
    slow_down: "slow-down",
    domain_switched: "domain-switched",
  };
  return statuses[value];
}

function setupMode(value) {
  if (value !== "manual" && value !== "scan") {
    throw invalid("invalid-mode", "mode", "飞书 Setup 模式无效");
  }
  return value;
}

function requiredOwnerId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw invalid("invalid-owner", "ownerId", "飞书 Setup 会话所有者无效");
  }
  return value;
}

function positiveTimeout(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 3_600_000) {
    throw invalid("invalid-timeout", "timeoutMs", "飞书 Setup 会话超时时间无效");
  }
  return value;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function validConfiguredOpenIds(value) {
  if (!Array.isArray(value)) return [];
  try {
    return normalizeOpenIds(value);
  } catch {
    return [];
  }
}

function activeState(state) {
  return new Set([
    "registering",
    "waiting-for-authorization",
    "validating",
  ]).has(state);
}

function invalidState(operation, state) {
  return invalid(
    "invalid-state",
    "session",
    `飞书 Setup 会话状态 ${state} 不允许执行 ${operation}`,
  );
}

function invalid(code, field, message) {
  return new FeishuSetupSessionError(code, field, message);
}

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : "";
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
