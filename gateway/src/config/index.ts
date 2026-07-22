import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
  TELEGRAM_PROXY_URL: z.string().optional(),
  HTTPS_PROXY: z.string().optional(),
  https_proxy: z.string().optional(),
  HTTP_PROXY: z.string().optional(),
  http_proxy: z.string().optional(),
  CODEX_BINARY: z.string().min(1).default("codex"),
  CODEX_WORKDIR: z.string().min(1),
  CODEX_SOCKET_PATH: z.string().min(1).optional(),
  CODEX_MODEL: z.string().optional(),
  CODEX_BRIDGE_SANDBOX: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
  STATE_DATABASE_PATH: z.string().min(1).optional(),
  APPROVAL_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  LOG_LEVEL: z.preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : value),
    z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  ),
});

export interface GatewayConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: ReadonlySet<number>;
  telegramProxyUrl?: string;
  codexBinary: string;
  codexWorkdir: string;
  codexSocketPath: string;
  codexModel?: string;
  codexSandbox: "read-only" | "workspace-write";
  stateDatabasePath: string;
  approvalTimeoutMs: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

export class ConfigurationError extends Error {}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError(z.prettifyError(parsed.error));
  }

  const raw = parsed.data;
  if (!isAbsolute(raw.CODEX_WORKDIR)) {
    throw new ConfigurationError("CODEX_WORKDIR 必须是绝对路径");
  }
  if (!existsSync(raw.CODEX_WORKDIR)) {
    throw new ConfigurationError("CODEX_WORKDIR 必须是已存在的目录");
  }

  const allowedIds = new Set<number>();
  for (const value of raw.TELEGRAM_ALLOWED_USER_IDS.split(",")) {
    const id = Number(value.trim());
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ConfigurationError(`无效的 TELEGRAM_ALLOWED_USER_IDS：${value}`);
    }
    allowedIds.add(id);
  }

  const workdir = realpathSync(raw.CODEX_WORKDIR);
  const socketPath = resolve(
    raw.CODEX_SOCKET_PATH ?? resolve(workdir, ".runtime/codex-app-server.sock"),
  );
  if (!isAbsolute(socketPath)) {
    throw new ConfigurationError("CODEX_SOCKET_PATH 必须解析为绝对路径");
  }
  const proxyUrl = normalizeProxyUrl(
    raw.TELEGRAM_PROXY_URL ?? raw.HTTPS_PROXY ?? raw.https_proxy ?? raw.HTTP_PROXY ?? raw.http_proxy,
  );

  return {
    telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: allowedIds,
    ...(proxyUrl ? { telegramProxyUrl: proxyUrl } : {}),
    codexBinary: raw.CODEX_BINARY,
    codexWorkdir: workdir,
    codexSocketPath: socketPath,
    ...(raw.CODEX_MODEL ? { codexModel: raw.CODEX_MODEL } : {}),
    codexSandbox: raw.CODEX_BRIDGE_SANDBOX,
    stateDatabasePath: resolve(raw.STATE_DATABASE_PATH ?? "data/gateway.sqlite3"),
    approvalTimeoutMs: raw.APPROVAL_TIMEOUT_SECONDS * 1000,
    logLevel: raw.LOG_LEVEL,
  };
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ConfigurationError("TELEGRAM_PROXY_URL/HTTPS_PROXY 不是有效 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError("Telegram 代理目前只支持 http:// 或 https://");
  }
  return parsed.toString();
}
