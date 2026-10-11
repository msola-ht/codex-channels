import type { TurnErrorPhase } from "./request-metrics-port.js";

/** 单次 Turn 失败的分类、错误码与安全文案；只读取已归约的错误对象，不执行 RPC 或平台输出。 */
export function turnErrorType(error: unknown, phase: TurnErrorPhase): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("You've hit your usage limit")) {
    return "usage_limit_reached";
  }
  if (phase === "start") return "turn_start_error";
  if (phase === "steer") return "turn_steer_error";
  return "turn_notification_error";
}

export function turnErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number" && Number.isSafeInteger(code)) {
    return `rpc:${code}`;
  }
  return typeof code === "string" && code.length > 0 && code.length <= 64
    ? code
    : null;
}

export function turnErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.replace(/\s+/gu, " ").trim();
  if (message.length === 0) return null;
  return message.length <= 500 ? message : `${message.slice(0, 500)}…`;
}
