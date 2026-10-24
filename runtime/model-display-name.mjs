const forbiddenModelIds = new Set(["__proto__", "prototype", "constructor"]);

/** Validate statistics groups without normalizing stored model IDs. */
export function validateModelDisplayAliases(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("模型统计分组必须是对象");
  }
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error("模型统计分组最多允许 128 条");
  const aliases = {};
  for (const [model, alias] of entries) {
    if (!validDisplayString(model, 265) || forbiddenModelIds.has(model)) {
      throw new Error("模型 ID 必须为 1–265 个有效 Unicode 字符，不含控制字符或首尾空白，且不能是保留对象键");
    }
    if (!validDisplayString(alias, 120)) {
      throw new Error("模型统计组名必须为 1–120 个有效 Unicode 字符，不含控制字符或首尾空白");
    }
    aliases[model] = alias;
  }
  return aliases;
}

function validDisplayString(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength
    && value.isWellFormed() && value === value.trim() && !/\p{Cc}/u.test(value);
}
