import pino, { type Logger } from "pino";

import type { GatewayConfig } from "../config/index.js";

export function createLogger(
  config: Pick<GatewayConfig, "logLevel">,
): Logger {
  return pino({
    level: config.logLevel,
    serializers: {
      err: errorMetadata,
    },
    redact: {
      paths: [
        "telegramBotToken",
        "telegramProxyUrl",
        "networkProxy",
        "proxyUrl",
        "token",
        "password",
        "appSecret",
        "app_secret",
        "feishu.appSecret",
        "feishu.app_secret",
        "config.feishu.appSecret",
        "config.feishu.app_secret",
        "cookie",
        "authorization",
        "Authorization",
        "Cookie",
        "headers.authorization",
        "headers.Authorization",
        "headers.cookie",
        "headers.Cookie",
        "req.headers.authorization",
        "req.headers.Authorization",
        "req.headers.cookie",
        "req.headers.Cookie",
      ],
      censor: "[REDACTED]",
    },
  });
}

function errorMetadata(error: unknown): Record<string, unknown> {
  const constructorName = error instanceof Error
    ? error.constructor.name
    : undefined;
  const type = typeof constructorName === "string"
    && /^[A-Za-z][A-Za-z0-9]{0,40}$/u.test(constructorName)
    ? constructorName
    : error instanceof Error
      ? "Error"
      : error === null
        ? "null"
        : typeof error;
  if (typeof error !== "object" || error === null) {
    return { type };
  }
  const record = error as Record<string, unknown>;
  if (
    typeof record.code === "string"
    && /^[A-Z][A-Z0-9_]{1,40}$/u.test(record.code)
  ) {
    return { type, code: record.code };
  }
  if (
    typeof record.error_code === "number"
    && Number.isSafeInteger(record.error_code)
  ) {
    return { type, code: record.error_code };
  }
  return { type };
}
