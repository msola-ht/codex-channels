/** Errors deliberately contain no upstream payload or user content. */
export class ModelConversionError extends Error {
  constructor(message = "Unsupported or invalid model API payload") {
    super(message);
    this.name = "ModelConversionError";
  }
}
export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConversionError();
  return value as JsonObject;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new ModelConversionError();
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ModelConversionError();
  return value;
}

/** 解析 Chat 工具参数；失败或不是 JSON 对象时抛出不含报文的转换错误。 */
export function toolArguments(text: string, message: string): JsonObject {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ModelConversionError(message); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConversionError(message);
  return value as JsonObject;
}

/** 自由格式工具在 Chat 侧只经 `input` 字段承载；其他字段一律拒绝，不猜测。 */
export function customToolInput(value: unknown): string {
  const source = object(value);
  if (Object.keys(source).some((key) => key !== "input")) throw new ModelConversionError("Unsupported custom tool arguments");
  return string(source.input);
}

/** 客户端 tool_search 参数：`limit` 缺省或 null 沿用 Codex Option<usize> 的默认值语义。 */
export function toolSearchArguments(value: unknown): JsonObject {
  const source = object(value);
  if (Object.keys(source).some((key) => key !== "query" && key !== "limit")) throw new ModelConversionError("Unsupported tool search arguments");
  const query = string(source.query);
  if (source.limit == null) return { query };
  if (!Number.isSafeInteger(source.limit) || Number(source.limit) < 0) throw new ModelConversionError("Invalid tool search limit");
  return { query, limit: Number(source.limit) };
}
