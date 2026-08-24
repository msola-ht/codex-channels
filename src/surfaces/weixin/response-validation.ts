import { WeixinProtocolError } from "./protocol-types.js";

export function throwForApiError(
  value: Record<string, unknown>,
  operation: string,
): void {
  const ret = optionalSafeInteger(value.ret, `${operation}返回码无效`);
  const errorCode = optionalSafeInteger(
    value.errcode,
    `${operation}错误码无效`,
  );
  const failure = ret !== undefined && ret !== 0
    ? ret
    : errorCode !== undefined && errorCode !== 0
      ? errorCode
      : undefined;
  if (failure !== undefined) {
    throw new WeixinProtocolError(
      "api-error",
      `${operation}失败（返回码 ${failure}）`,
      undefined,
      failure,
    );
  }
}

export function parseJsonRecord(
  raw: string,
  operation: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WeixinProtocolError(
      "invalid-response",
      `${operation}不是有效 JSON`,
    );
  }
  return requiredRecord(value, `${operation}格式无效`);
}

export function requiredRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value as Record<string, unknown>;
}

export function requiredArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value;
}

export function optionalResponseString(
  value: unknown,
  message: string,
  maximumLength: number,
): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || value.length > maximumLength) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value;
}

export function optionalBoundedString(
  value: unknown,
  message: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
  ) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value;
}

export function optionalSafeInteger(
  value: unknown,
  message: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value)) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return value as number;
}

export function optionalBoundedPositiveInteger(
  value: unknown,
  message: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = optionalSafeInteger(value, message);
  if (
    parsed !== undefined
    && (parsed < minimum || parsed > maximum)
  ) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return parsed;
}

export function optionalNonNegativeInteger(
  value: unknown,
  message: string,
): number | undefined {
  const parsed = optionalSafeInteger(value, message);
  if (parsed !== undefined && parsed < 0) {
    throw new WeixinProtocolError("invalid-response", message);
  }
  return parsed;
}
