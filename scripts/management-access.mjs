const maximumRateLimitEntries = 128 * 3;
const requestRateLimits = { read: 120, write: 30, "high-risk": 5 };

export class ManagementSecurityError extends Error {
  constructor(code, message, status = 403) {
    super(message);
    this.name = "ManagementSecurityError";
    this.code = code;
    this.status = status;
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

  consume({ principalId, category }) {
    const id = boundedIdentifier(principalId, "主体 ID");
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

export function managementSecurityHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
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
