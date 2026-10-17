const reservedKeys = new Set(["__proto__", "constructor", "prototype"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function validateValue(value, path, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value !== "object") throw new Error(`${path} 必须为 JSON 数据`);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} 必须为普通 JSON 对象或数组`);
  }
  if (ancestors.has(value)) throw new Error(`${path} 包含循环引用`);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error(`${path} 包含不受支持的 Symbol 属性`);
    if (Array.isArray(value) && key === "length") continue;
    const childPath = `${path}[${JSON.stringify(key)}]`;
    if (reservedKeys.has(key)) throw new Error(`${childPath} 包含不受支持的属性名`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error(`${childPath} 必须为普通 JSON 数据属性`);
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key)) throw new Error(`${childPath} 必须为数组索引`);
    validateValue(descriptor.value, childPath, ancestors);
  }
  ancestors.delete(value);
}

function cloneMessages(value, path) {
  if (!object(value)) throw new Error(`${path} 必须为提示词对象`);
  validateValue(value, path);
  return structuredClone(value);
}

// Only absent, nonempty prompt strings are inherited; explicit values are authoritative.
function fillPrompts(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(target, key)) {
      if (object(target[key]) && object(value)) fillPrompts(target[key], value);
    } else if (typeof value === "string" && value.length > 0) target[key] = value;
    else if (object(value)) {
      const nested = {};
      fillPrompts(nested, value);
      if (Object.keys(nested).length > 0) target[key] = nested;
    }
  }
}

/** Complete third-party model messages without mutating either JSON input. */
export function completeModelMessages(messages, baselineMessages) {
  const completed = cloneMessages(messages, "model_messages");
  const baseline = cloneMessages(baselineMessages, "baselineModelMessages");
  const inheritApprovals = completed.approvals === null;
  if (inheritApprovals) delete completed.approvals;
  // These prompts require the baseline's accompanying switches and thresholds.
  if (!Object.hasOwn(completed, "token_budget") && Object.hasOwn(baseline, "token_budget")) {
    completed.token_budget = baseline.token_budget;
  }
  fillPrompts(completed, baseline);
  if (inheritApprovals && !Object.hasOwn(completed, "approvals")) completed.approvals = null;
  return completed;
}
