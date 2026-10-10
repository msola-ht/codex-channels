import { array, ModelConversionError, object, string } from "./validation.js";
import type { JsonObject } from "./validation.js";

/**
 * Codex multi-agent v2 的 agent_message 正文由可读信封与载荷两段构成，信封自带结尾换行，
 * 因此直接拼接即可还原锁定 CLI 的明文渲染。
 * 锁定 CLI 会为工具来源的消息使用 `encrypted_content` 段，即使第三方返回的是明文。
 * 这里只按原文搬运载荷，不解密、不伪造占位文本，也不根据字段名称推断载荷内容。
 * 工具 schema 的 `encrypted` 标记与历史调用的 `encrypted_function_args` 是不同字段；
 * CLI 会清除第三方请求中的后者，前者由下方的 schema 清理函数处理。
 */
export function agentMessageText(value: unknown): string {
  const text = array(value).map(raw => {
    const part = object(raw);
    if (part.type === "input_text") return string(part.text);
    if (part.type === "encrypted_content") return string(part.encrypted_content);
    throw new ModelConversionError("Unsupported agent message content");
  }).join("");
  if (text.trim() === "") throw new ModelConversionError("Empty agent message");
  return text;
}

export interface StrippedEncryptedMarker {
  value: unknown;
  changed: boolean;
}

/**
 * `encrypted` 是 Codex Responses 私有的参数标记（锁定 `JsonSchema` 注释：Responses-only
 * marker for reviewed encrypted tool parameters）。第三方上游没有等价语义，保留会让上游或模型
 * 把它当成参数要求，因此仅在 schema 节点删除布尔标记。枚举等实例数据与属性名保持原样。
 * 返回值同时报告是否真的删除过标记，调用方据此决定是否需要重新序列化报文；未删除时返回入参
 * 本身（同一引用），调用方不得就地修改返回的 schema。
 */
export function stripEncryptedMarker(value: unknown): StrippedEncryptedMarker {
  if (Array.isArray(value)) {
    let changed = false;
    const entries = value.map(entry => {
      const stripped = stripEncryptedMarker(entry);
      changed ||= stripped.changed;
      return stripped.value;
    });
    return { value: changed ? entries : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  // 对象展开创建自有数据属性，保留 JSON 中的 __proto__，不触发原型 setter。
  const source = value as JsonObject;
  const result: JsonObject = { ...source };
  let changed = false;
  if (typeof result.encrypted === "boolean") {
    delete result.encrypted;
    changed = true;
  }
  // 与锁定 CLI JsonSchema 的子 schema 字段一致；不递归进入 enum 等实例数据。
  for (const key of ["items", "additionalProperties", "anyOf", "oneOf", "allOf"] as const) {
    if (!Object.hasOwn(result, key)) continue;
    const stripped = stripEncryptedMarker(result[key]);
    if (!stripped.changed) continue;
    result[key] = stripped.value;
    changed = true;
  }
  for (const key of ["properties", "$defs", "definitions"] as const) {
    const table = result[key];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    let tableChanged = false;
    const entries = Object.entries(table as JsonObject).map(([name, schema]) => {
      const stripped = stripEncryptedMarker(schema);
      tableChanged ||= stripped.changed;
      return [name, stripped.value] as const;
    });
    if (!tableChanged) continue;
    result[key] = Object.fromEntries(entries);
    changed = true;
  }
  return { value: changed ? result : source, changed };
}
