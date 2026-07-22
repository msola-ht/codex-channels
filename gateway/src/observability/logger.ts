import pino, { type Logger } from "pino";

import type { GatewayConfig } from "../config/index.js";

export function createLogger(config: GatewayConfig): Logger {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        "telegramBotToken",
        "telegramProxyUrl",
        "proxyUrl",
        "token",
        "authorization",
        "headers.authorization",
        "req.headers.authorization",
      ],
      censor: "[REDACTED]",
    },
  });
}
