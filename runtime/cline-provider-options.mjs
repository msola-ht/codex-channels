const maximumBytes = 32 * 1024;
const maximumDepth = 12;
const maximumNodes = 512;
const maximumObjectKeys = 256;
const maximumArrayItems = 64;
const maximumStringLength = 4096;
const maximumKeyLength = 128;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const credentialSuffix = /(?:api[-_]?key|authorization|password|secret|token)$/iu;

/**
 * One CLP model's providerOptions overlay. Field names and values are passed
 * through unchanged; only the enclosing JSON object, size, prototype and
 * credential boundaries are checked locally.
 */
export function validateClinePassProviderOptions(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("请求改写必须为 JSON 对象");
  let nodes = 0;
  const normalized = normalizeObject(value, "providerOptions", 0, () => {
    nodes += 1;
    if (nodes > maximumNodes) throw new Error(`请求改写最多包含 ${maximumNodes} 个 JSON 节点`);
  });
  const bytes = new TextEncoder().encode(JSON.stringify(normalized)).length;
  if (bytes > maximumBytes) throw new Error(`请求改写不能超过 ${maximumBytes} 字节`);
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function normalizeObject(value, path, depth, countNode) {
  countNode();
  if (depth > maximumDepth) throw new Error(`请求改写不能超过 ${maximumDepth} 层嵌套`);
  const entries = Object.entries(value);
  if (entries.length > maximumObjectKeys) throw new Error(`请求改写 ${path} 不能超过 ${maximumObjectKeys} 个字段`);
  const result = {};
  for (const [key, entry] of entries) {
    const childPath = `${path}.${key}`;
    validateKey(key, childPath);
    if (childPath === "providerOptions.gateway.byok") {
      throw new Error("请求改写不能保存 gateway.byok；凭据应保存在受管账户或系统凭据后端");
    }
    if (credentialSuffix.test(key)) throw new Error(`请求改写 ${childPath} 看起来包含凭据，不能保存到模型目录`);
    if (path === "providerOptions" && !isRecord(entry)) {
      throw new Error(`请求改写 ${childPath} 必须为 JSON 对象`);
    }
    result[key] = normalizeValue(entry, childPath, depth + 1, countNode);
  }
  return result;
}

function normalizeValue(value, path, depth, countNode) {
  countNode();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`请求改写 ${path} 必须为有限数字`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > maximumStringLength) throw new Error(`请求改写 ${path} 不能超过 ${maximumStringLength} 字符`);
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > maximumDepth) throw new Error(`请求改写不能超过 ${maximumDepth} 层嵌套`);
    if (value.length > maximumArrayItems) throw new Error(`请求改写 ${path} 不能超过 ${maximumArrayItems} 项`);
    return value.map((entry, index) => normalizeValue(entry, `${path}[${index}]`, depth + 1, countNode));
  }
  if (isRecord(value)) return normalizeObject(value, path, depth, countNode);
  throw new Error(`请求改写 ${path} 必须为 JSON 值`);
}

function validateKey(key, path) {
  if (key.length === 0 || key.length > maximumKeyLength || /\p{Cc}/u.test(key)) {
    throw new Error(`请求改写 ${path} 的字段名无效`);
  }
  if (forbiddenKeys.has(key)) throw new Error(`请求改写 ${path} 包含保留字段名`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
