import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  readGatewayConfig,
  validateMetricsCenterConfigDocument,
} from "../runtime/gateway-config.mjs";
import {
  resolveConfiguredPath,
  userDataDir,
} from "./runtime-config.mjs";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8790;
const CENTER_USAGE = "用法：codexc center [--host 地址] [--port 端口] [--database 路径]";

export function assertMetricsCenterHost(value) {
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(value)) {
    throw new Error("center host 只允许 127.0.0.1、::1 或 0.0.0.0");
  }
}

export function resolveMetricsCenterSettings({
  args = [],
  environment = process.env,
} = {}) {
  const cli = parseMetricsCenterCliArgs(args);
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const configPath = explicitConfigFile
    ? resolve(explicitConfigFile)
    : join(userDataDir(environment), "config.toml");
  let configured = {};
  if (existsSync(configPath)) {
    configured = validateMetricsCenterConfigDocument(readGatewayConfig(configPath));
  }
  const baseDirectory = dirname(configPath);
  return {
    host: cli.host ?? configured.host ?? DEFAULT_HOST,
    port: cli.port ?? configured.port ?? DEFAULT_PORT,
    token: configured.token ?? null,
    deviceToken: configured.device_token ?? null,
    databasePath: cli.database
      ?? resolveConfiguredPath(
        configured.database_path ?? "data/central-metrics.sqlite3",
        baseDirectory,
      ),
    configPath,
  };
}

export function parseMetricsCenterCliArgs(args) {
  const settings = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--host") {
      const raw = args[index + 1];
      if (raw === undefined) {
        throw new Error(CENTER_USAGE);
      }
      assertMetricsCenterHost(raw);
      settings.host = raw;
      index += 1;
      continue;
    }
    if (argument === "--port") {
      const raw = args[index + 1];
      if (raw === undefined || !/^[0-9]+$/u.test(raw)) {
        throw new Error(CENTER_USAGE);
      }
      const port = Number(raw);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("端口必须在 1 到 65535 之间");
      }
      settings.port = port;
      index += 1;
      continue;
    }
    if (argument === "--token") {
      throw new Error("指标中心查看令牌不得通过命令行传入，请运行 codexc config 设置");
    }
    if (argument === "--device-token") {
      throw new Error("指标中心设备令牌不得通过命令行传入，请运行 codexc config 设置");
    }
    if (argument === "--database") {
      const raw = args[index + 1];
      if (raw === undefined || raw === "" || raw.startsWith("--")) {
        throw new Error(CENTER_USAGE);
      }
      settings.database = raw;
      index += 1;
      continue;
    }
    throw new Error(
      `未知参数：${argument}\n${CENTER_USAGE}`,
    );
  }
  return settings;
}
