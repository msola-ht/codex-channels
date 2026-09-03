import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";

import {
  readPrivateFileSync,
  writePrivateFileAtomicSync,
} from "../runtime/private-file.mjs";

const defaultAbsoluteTtlMs = 30 * 60_000;
const defaultIdleTtlMs = 10 * 60_000;
const defaultAttemptWindowMs = 60_000;
const defaultMaximumAttempts = 5;
const maximumSessions = 128;
const maximumAttemptSources = 256;
const maximumRateLimitEntries = maximumSessions * 3;
const requestRateLimits = { read: 120, write: 30, "high-risk": 5 };

export class ManagementSecurityError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = "ManagementSecurityError";
    this.code = code;
    this.status = status;
  }
}

export class ManagementAccessController {
  #credentialDigest;
  #origin;
  #now;
  #randomBytes;
  #absoluteTtlMs;
  #idleTtlMs;
  #attemptWindowMs;
  #maximumAttempts;
  #attempts = new Map();
  #sessions = new Map();

  constructor({
    credential,
    origin,
    now = Date.now,
    randomBytesImpl = randomBytes,
    absoluteTtlMs = defaultAbsoluteTtlMs,
    idleTtlMs = defaultIdleTtlMs,
    attemptWindowMs = defaultAttemptWindowMs,
    maximumAttempts = defaultMaximumAttempts,
  }) {
    this.#credentialDigest = digestCredential(requiredString(credential, "管理凭据"));
    this.#origin = exactOrigin(origin);
    this.#now = now;
    this.#randomBytes = randomBytesImpl;
    this.#absoluteTtlMs = positiveDuration(absoluteTtlMs, "绝对会话期限");
    this.#idleTtlMs = positiveDuration(idleTtlMs, "空闲会话期限");
    this.#attemptWindowMs = positiveDuration(attemptWindowMs, "登录限速窗口");
    this.#maximumAttempts = positiveInteger(maximumAttempts, "登录尝试上限");
  }

  login({ credential, origin, source }) {
    this.#assertOrigin(origin);
    const sourceKey = boundedIdentifier(source, "来源");
    const now = this.#now();
    this.#prune(now);
    const attempts = this.#attempts.get(sourceKey) ?? [];
    if (attempts.length >= this.#maximumAttempts) {
      throw new ManagementSecurityError("management.rate-limited", "认证失败", 429);
    }
    if (!safeCredentialEqual(this.#credentialDigest, credential)) {
      if (!this.#attempts.has(sourceKey) && this.#attempts.size >= maximumAttemptSources) {
        throw new ManagementSecurityError("management.rate-limited", "认证失败", 429);
      }
      this.#attempts.set(sourceKey, [...attempts, now]);
      throw new ManagementSecurityError("management.authentication-failed", "认证失败", 401);
    }
    this.#attempts.delete(sourceKey);
    if (this.#sessions.size >= maximumSessions) {
      throw new ManagementSecurityError("management.session-capacity", "管理会话数量已达上限", 503);
    }
    const token = exactRandomToken(this.#randomBytes, 32);
    const csrfToken = exactRandomToken(this.#randomBytes, 24);
    const session = {
      id: createHash("sha256").update(token).digest("hex"),
      tokenDigest: digestCredential(token),
      csrfDigest: digestCredential(csrfToken),
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.#absoluteTtlMs,
    };
    this.#sessions.set(session.id, session);
    return {
      sessionId: session.id,
      sessionToken: token,
      csrfToken,
      expiresAt: Math.min(session.absoluteExpiresAt, now + this.#idleTtlMs),
    };
  }

  authorize({ sessionToken, csrfToken, origin, method = "POST" }) {
    this.#assertOrigin(origin);
    const now = this.#now();
    this.#prune(now);
    const token = requiredString(sessionToken, "管理会话令牌");
    const sessionId = createHash("sha256").update(token).digest("hex");
    const session = this.#sessions.get(sessionId);
    if (
      session === undefined
      || !safeDigestEqual(session.tokenDigest, token)
      || session.absoluteExpiresAt <= now
      || session.lastSeenAt + this.#idleTtlMs <= now
    ) {
      this.#sessions.delete(sessionId);
      throw new ManagementSecurityError("management.session-invalid", "管理会话无效或已过期", 401);
    }
    if (!readonlyMethod(method) && !safeDigestEqual(session.csrfDigest, csrfToken)) {
      throw new ManagementSecurityError("management.csrf-invalid", "管理请求缺少有效 CSRF 凭据");
    }
    session.lastSeenAt = now;
    return {
      sessionId,
      expiresAt: Math.min(session.absoluteExpiresAt, now + this.#idleTtlMs),
    };
  }

  logout(sessionToken) {
    const token = typeof sessionToken === "string" ? sessionToken : "";
    const sessionId = createHash("sha256").update(token).digest("hex");
    return this.#sessions.delete(sessionId);
  }

  revokeAll() {
    this.#sessions.clear();
    this.#attempts.clear();
  }

  #assertOrigin(value) {
    if (value !== this.#origin) {
      throw new ManagementSecurityError("management.origin-invalid", "管理请求来源无效");
    }
  }

  #prune(now) {
    for (const [source, attempts] of this.#attempts) {
      const retained = attempts.filter((timestamp) => timestamp + this.#attemptWindowMs > now);
      if (retained.length === 0) this.#attempts.delete(source);
      else this.#attempts.set(source, retained);
    }
    for (const [id, session] of this.#sessions) {
      if (session.absoluteExpiresAt <= now || session.lastSeenAt + this.#idleTtlMs <= now) {
        this.#sessions.delete(id);
      }
    }
  }
}

export class ManagementRateLimiter {
  #now;
  #windowMs;
  #entries = new Map();

  constructor({ now = Date.now, windowMs = 60_000 } = {}) {
    this.#now = now;
    this.#windowMs = positiveDuration(windowMs, "请求限速窗口");
  }

  consume({ sessionId, category }) {
    const id = boundedIdentifier(sessionId, "会话 ID");
    if (!Object.hasOwn(requestRateLimits, category)) throw new Error("管理请求限速类别无效");
    const now = this.#now();
    this.#prune(now);
    const key = `${id}:${category}`;
    const retained = (this.#entries.get(key) ?? []).filter((timestamp) => timestamp + this.#windowMs > now);
    if (retained.length >= requestRateLimits[category]) {
      throw new ManagementSecurityError("management.rate-limited", "管理请求过于频繁", 429);
    }
    if (!this.#entries.has(key) && this.#entries.size >= maximumRateLimitEntries) {
      throw new ManagementSecurityError("management.rate-limited", "管理请求过于频繁", 429);
    }
    this.#entries.set(key, [...retained, now]);
    return { remaining: requestRateLimits[category] - retained.length - 1 };
  }

  #prune(now) {
    for (const [key, timestamps] of this.#entries) {
      const retained = timestamps.filter((timestamp) => timestamp + this.#windowMs > now);
      if (retained.length === 0) this.#entries.delete(key);
      else this.#entries.set(key, retained);
    }
  }
}

export function provisionManagementCredential(
  path,
  { rotate = false, randomBytesImpl = randomBytes } = {},
) {
  const exists = existsSync(path);
  if (exists && !rotate) return { path, created: false, rotated: false, credential: null };
  const credential = exactRandomToken(randomBytesImpl, 32);
  writePrivateFileAtomicSync(path, `${credential}\n`);
  return { path, created: !exists, rotated: exists, credential };
}

export function readManagementCredential(path) {
  const credential = readPrivateFileSync(path, 256).trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(credential)) throw new Error("管理凭据文件内容无效");
  return credential;
}

export function managementSecurityHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

export function managementSessionCookie(sessionToken, { secure = false } = {}) {
  const token = requiredString(sessionToken, "管理会话令牌");
  if (!/^[A-Za-z0-9_-]+$/u.test(token)) throw new Error("管理会话令牌格式无效");
  return [
    `codexc_management=${token}`,
    "Path=/api/v1/management",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=1800",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearManagementSessionCookie({ secure = false } = {}) {
  return [
    "codexc_management=",
    "Path=/api/v1/management",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function validateManagementJsonRequest({
  method,
  origin,
  expectedOrigin,
  contentType,
  contentLength,
  requestLineBytes = 0,
  headerBytes = 0,
}) {
  if (origin !== exactOrigin(expectedOrigin)) {
    throw new ManagementSecurityError("management.origin-invalid", "管理请求来源无效");
  }
  if (!Number.isInteger(requestLineBytes) || requestLineBytes < 0 || requestLineBytes > 8_192) {
    throw new ManagementSecurityError("management.request-line-too-large", "管理请求行过大", 414);
  }
  if (!Number.isInteger(headerBytes) || headerBytes < 0 || headerBytes > 16_384) {
    throw new ManagementSecurityError("management.headers-too-large", "管理请求 Header 过大", 431);
  }
  if (readonlyMethod(method)) return { maximumBodyBytes: 0 };
  if (String(contentType).toLowerCase().split(";", 1)[0]?.trim() !== "application/json") {
    throw new ManagementSecurityError("management.content-type-invalid", "管理请求只接受 JSON", 415);
  }
  if (!Number.isInteger(contentLength) || contentLength < 0 || contentLength > 65_536) {
    throw new ManagementSecurityError("management.body-too-large", "管理请求正文过大", 413);
  }
  return { maximumBodyBytes: 65_536 };
}

function safeCredentialEqual(expectedDigest, candidate) {
  return safeDigestEqual(expectedDigest, typeof candidate === "string" ? candidate : "");
}

function safeDigestEqual(expectedDigest, candidate) {
  const candidateDigest = digestCredential(typeof candidate === "string" ? candidate : "");
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function digestCredential(value) {
  return createHash("sha256").update(value).digest();
}

function exactOrigin(value) {
  const normalized = requiredString(value, "可信 Origin");
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("可信 Origin 无效");
  }
  if (url.origin !== normalized || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("可信 Origin 必须是精确协议、主机和端口");
  }
  return url.origin;
}

function exactRandomToken(randomBytesImpl, length) {
  const value = randomBytesImpl(length);
  if (!Buffer.isBuffer(value) || value.length !== length) throw new Error("随机数生成器返回长度无效");
  return value.toString("base64url");
}

function readonlyMethod(method) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function requiredString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function boundedIdentifier(value, label) {
  const normalized = requiredString(value, label);
  if (normalized.length > 256 || /[\0\r\n]/u.test(normalized)) throw new Error(`${label}无效或过长`);
  return normalized;
}

function positiveDuration(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) throw new Error(`${label}无效`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100) throw new Error(`${label}无效`);
  return value;
}
