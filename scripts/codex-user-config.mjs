import { isDeepStrictEqual } from "node:util";
import { statSync } from "node:fs";
import { homedir } from "node:os";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  resolveOptionalExecutable,
} from "../runtime/executable.mjs";
import { codexProcessInvocation } from "../runtime/owned-process.mjs";
import { terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { readGatewayConfig, validateCodexConfigDocument } from "../runtime/gateway-config.mjs";
import { locateUserConfig } from "./runtime-config.mjs";

export async function disableCodexDaemonAutoStart(environment = process.env, dependencies = {}) {
  await updateCodexUserConfig(environment, (config) => {
    const features = config.features;
    return features?.daemon_auto_start === false
      ? []
      : [{ keyPath: "features.daemon_auto_start", value: false }];
  }, dependencies);
}

export async function updateCodexUserConfig(
  environment,
  createEdits,
  { createClient = createCodexUserConfigClient } = {},
) {
  const client = await createClient({ environment });
  try {
    await client.connect();
    const snapshot = await client.readUserConfigSnapshot();
    const edits = createEdits(snapshot.config);
    if (edits.length === 0) return;
    await client.writeUserConfigEdits(edits, { expectedVersion: snapshot.version });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function readCodexUserConfigSnapshot(
  environment,
  { createClient = createCodexUserConfigClient } = {},
) {
  const client = await createClient({ environment });
  try {
    await client.connect();
    return await client.readUserConfigSnapshot();
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function areCodexUserConfigEditsApplied(config, edits) {
  return edits.every(({ keyPath, value }) => {
    const current = configValueAtPath(config, keyPath);
    return value === null ? current === undefined : isDeepStrictEqual(current, value);
  });
}

export async function writeCodexUserConfigEdits(
  environment,
  edits,
  { expectedVersion, createClient = createCodexUserConfigClient } = {},
) {
  const client = await createClient({ environment });
  try {
    await client.connect();
    await client.writeUserConfigEdits(edits, {
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function createCodexUserConfigClient({
  environment = process.env,
  cwd = codexUserConfigWorkingDirectory(environment),
  codexBinary: configuredBinary = stringValue(environment.CODEX_BINARY) || "codex",
} = {}) {
  const codexBinary = resolveOptionalExecutable(configuredBinary, environment) ?? configuredBinary;
  // Metadata-only config/read, config/batchWrite and model/list do not require Provider credentials.
  // Keep explicit repair available when a private reference is missing or invalid.
  const {
    CodexAppServerClient,
    JsonRpcClient,
    StdioTransport,
  } = await import("../dist/codex-client/index.js");
  return new CodexAppServerClient(
    new JsonRpcClient(new StdioTransport({
      cwd,
      environment,
      createCodexProcessInvocation: (args) =>
        codexProcessInvocation(codexBinary, args, environment),
      terminateCodexProcess: terminateChildProcess,
    })),
    { sandbox: "read-only" },
  );
}

function codexUserConfigWorkingDirectory(environment) {
  const home = codexHomePath(environment);
  try {
    if (!statSync(home).isDirectory()) throw new Error("Codex Home 必须指向目录");
    return home;
  } catch (error) {
    // 首次使用由 Codex 创建默认 Home；不能把尚不存在的目录传给 spawn。
    // 显式 CODEX_HOME 必须已经存在，保持官方 CLI 的路径约束。
    if (error?.code === "ENOENT" && !environment.CODEX_HOME?.trim()) return homedir();
    if (error?.code === "ENOENT") throw new Error("CODEX_HOME 必须指向已存在的目录", { cause: error });
    throw error;
  }
}

/** WebUI reads reuse the running primary server; never start a temporary server. */
export async function createSharedCodexUserConfigClient({ environment = process.env } = {}) {
  const config = locateUserConfig(environment);
  const document = readGatewayConfig(config.configPath);
  const codex = validateCodexConfigDocument(document.codex ?? {});
  const socketPath = resolvePrimaryAppServerSocketPath({ codex }, config.dataDir);
  const configuredBinary = stringValue(environment.CODEX_BINARY) || codex.binary;
  const codexBinary = resolveOptionalExecutable(configuredBinary, environment) ?? configuredBinary;
  const { CodexAppServerClient, JsonRpcClient, createAppServerTransport } = await import("../dist/codex-client/index.js");
  const transport = createAppServerTransport({ kind: "local-app-server", socketPath }, {
    connectTimeoutMs: 3_000,
    createCodexProcessInvocation: (args) => codexProcessInvocation(codexBinary, args, environment),
    terminateCodexProcess: terminateChildProcess,
  });
  return new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function configValueAtPath(config, keyPath) {
  let current = config;
  for (const segment of keyPath.split(".")) {
    if (
      current === null
      || typeof current !== "object"
      || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}
