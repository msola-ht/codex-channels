import { createHash, randomBytes } from "node:crypto";

import { ManagementSecurityError } from "./management-access.mjs";

const maximumConfirmations = 256;

export class ManagementConfirmationStore {
  #entries = new Map();
  #now;
  #randomBytes;

  constructor({ now = Date.now, randomBytesImpl = randomBytes } = {}) {
    this.#now = now;
    this.#randomBytes = randomBytesImpl;
  }

  issue({ sessionId, operation, inputFingerprint, resourceRevision, previewFingerprint, ttlMs = 5 * 60_000 }) {
    const now = this.#now();
    this.#prune(now);
    if (this.#entries.size >= maximumConfirmations) {
      throw new ManagementSecurityError("management.confirmation-capacity", "待确认操作数量已达上限", 503);
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 10 * 60_000) throw new Error("确认期限无效");
    const random = this.#randomBytes(24);
    if (!Buffer.isBuffer(random) || random.length !== 24) throw new Error("随机数生成器返回长度无效");
    const token = random.toString("base64url");
    const tokenDigest = fingerprintManagementValue(token);
    this.#entries.set(tokenDigest, {
      sessionId: identifier(sessionId, "会话 ID"),
      operation: identifier(operation, "操作类型"),
      inputFingerprint: fingerprint(inputFingerprint, "输入指纹"),
      resourceRevision: fingerprint(resourceRevision, "资源修订"),
      previewFingerprint: fingerprint(previewFingerprint, "预览指纹"),
      expiresAt: now + ttlMs,
    });
    return { token, expiresAt: now + ttlMs };
  }

  consume(token, binding) {
    const now = this.#now();
    this.#prune(now);
    const tokenDigest = fingerprintManagementValue(typeof token === "string" ? token : "");
    const entry = this.#entries.get(tokenDigest);
    this.#entries.delete(tokenDigest);
    const normalizedBinding = safelyNormalizeBinding(binding);
    if (
      entry === undefined
      || entry.expiresAt <= now
      || normalizedBinding === null
      || !sameBinding(entry, normalizedBinding)
    ) {
      throw new ManagementSecurityError("management.confirmation-invalid", "确认令牌无效、已过期或已使用", 409);
    }
    return { operation: entry.operation, consumedAt: now };
  }

  revokeSession(sessionId) {
    for (const [token, entry] of this.#entries) {
      if (entry.sessionId === sessionId) this.#entries.delete(token);
    }
  }

  #prune(now) {
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token);
    }
  }
}

export function fingerprintManagementValue(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sameBinding(entry, binding) {
  return entry.sessionId === binding.sessionId
    && entry.operation === binding.operation
    && entry.inputFingerprint === binding.inputFingerprint
    && entry.resourceRevision === binding.resourceRevision
    && entry.previewFingerprint === binding.previewFingerprint;
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("确认绑定无效");
  return {
    sessionId: identifier(binding.sessionId, "会话 ID"),
    operation: identifier(binding.operation, "操作类型"),
    inputFingerprint: fingerprint(binding.inputFingerprint, "输入指纹"),
    resourceRevision: fingerprint(binding.resourceRevision, "资源修订"),
    previewFingerprint: fingerprint(binding.previewFingerprint, "预览指纹"),
  };
}

function safelyNormalizeBinding(binding) {
  try {
    return normalizeBinding(binding);
  } catch {
    return null;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("管理指纹值必须是有限数字");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("管理指纹值必须可序列化");
}

function identifier(value, label) {
  if (typeof value !== "string" || !value || value.length > 256 || /[\0\r\n]/u.test(value)) throw new Error(`${label}无效`);
  return value;
}

function fingerprint(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label}无效`);
  return value;
}
