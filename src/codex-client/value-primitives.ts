/** codex-client 内部适配器共用的最小 JSON 取值断言；不含协议语义、不持有状态。 */

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 字符串去掉首尾空白后仍非空才有效；空白串按缺失处理。 */
export function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 原样取字符串，不去空白；非字符串按缺失处理。 */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
