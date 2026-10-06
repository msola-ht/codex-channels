import { isDeepStrictEqual } from "node:util";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  executableInvocation,
  resolveOptionalExecutable,
} from "../runtime/executable.mjs";
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
  cwd = codexHomePath(environment),
} = {}) {
  const configuredBinary = stringValue(environment.CODEX_BINARY) || "codex";
  const codexBinary = resolveOptionalExecutable(configuredBinary, environment) ?? configuredBinary;
  const {
    CodexAppServerClient,
    JsonRpcClient,
    StdioTransport,
  } = await import("../dist/codex-client/index.js");
  return new CodexAppServerClient(
    new JsonRpcClient(new StdioTransport({
      codexBinary,
      cwd,
      environment,
      createCodexProcessInvocation: (args) =>
        executableInvocation(codexBinary, args, environment),
      terminateCodexProcess: terminateChildProcess,
    })),
    { sandbox: "read-only" },
  );
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
    codexBinary,
    connectTimeoutMs: 3_000,
    createCodexProcessInvocation: (args) => executableInvocation(codexBinary, args, environment),
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
