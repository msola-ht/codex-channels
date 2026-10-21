import { isDeepStrictEqual } from "node:util";
import { statSync } from "node:fs";
import { homedir } from "node:os";

import { codexHomePath } from "../runtime/codex-home.mjs";
import {
  effectiveCodexBinary,
  resolveOptionalExecutable,
} from "../runtime/executable.mjs";
import { codexProcessInvocation } from "../runtime/owned-process.mjs";
import { registerChildProcessGroup, terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import {
  acquireAppServerProviderLease,
  inspectAppServerSupervisorState,
} from "../runtime/app-server-supervisor.mjs";
import { readGatewayConfig, validateCodexConfigDocument } from "../runtime/gateway-config.mjs";
import { locateOptionalUserConfig, locateUserConfig } from "./runtime-config.mjs";

// Failed temporary-client cleanup remains owned before any new operation.
const unclosedReadClients = new Set();
const activeOperations = new Set();
let clientsClosing = false;

/** Final host shutdown: stop admission, let submitted writes settle, then clean. */
export async function closeCodexUserConfigClients() {
  clientsClosing = true;
  await Promise.allSettled([...activeOperations]);
  await closePendingCodexUserConfigReads();
}

export async function closePendingCodexUserConfigReads() {
  const results = await Promise.allSettled([...unclosedReadClients].map(async client => {
    await client.close();
    unclosedReadClients.delete(client);
  }));
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "用户设置连接清理未确认");
}

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
  return withCodexUserConfigClient(environment, createClient, undefined, async (client) => {
    const snapshot = await client.readUserConfigSnapshot();
    const edits = createEdits(snapshot.config);
    if (edits.length === 0) return;
    await client.writeUserConfigEdits(edits, { expectedVersion: snapshot.version });
  }, { preserveOperationResult: true });
}

export async function readCodexUserConfigSnapshot(
  environment,
  { createClient = createCodexUserConfigClient, signal } = {},
) {
  return readWithCodexUserConfigClient(environment, createClient, signal,
    (client) => client.readUserConfigSnapshot());
}

/** A cancelled read closes only its owned connection (and any owned proxy). */
export async function readWithCodexUserConfigClient(environment, createClient, signal, read) {
  return withCodexUserConfigClient(environment, createClient, signal, read);
}

/** Writes are never cancelled after submission; cleanup must not imply a replay. */
export function withCodexUserConfigClient(
  environment, createClient, signal, operation, options = {},
) {
  if (clientsClosing) return Promise.reject(new Error("用户设置客户端正在关闭"));
  const task = runWithCodexUserConfigClient(environment, createClient, signal, operation, options)
    .finally(() => activeOperations.delete(task));
  activeOperations.add(task);
  return task;
}

async function runWithCodexUserConfigClient(
  environment, createClient, signal, operation, { preserveOperationResult = false } = {},
) {
  signal?.throwIfAborted();
  await closePendingCodexUserConfigReads();
  signal?.throwIfAborted();
  const client = await createClient({ environment });
  let closing;
  const close = () => closing ??= Promise.resolve().then(() => client.close()).catch(error => {
    unclosedReadClients.add(client);
    throw error;
  });
  const abort = () => { void close().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect();
    signal?.throwIfAborted();
    const result = await operation(client);
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    await close().catch(error => {
      if (!preserveOperationResult) throw error;
      process.emitWarning("用户设置操作已结束，但临时连接清理未确认；已保留归属，后续操作须先完成清理，请勿因此重复提交写入。", {
        code: "CODEX_CONFIG_CLIENT_CLEANUP_UNCONFIRMED",
      });
    });
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
  return withCodexUserConfigClient(environment, createClient, undefined, async (client) => {
    await client.writeUserConfigEdits(edits, {
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  }, { preserveOperationResult: true });
}

export async function createCodexUserConfigClient({
  environment = process.env,
  cwd = codexUserConfigWorkingDirectory(environment),
  codexBinary: configuredBinary = resolveCodexUserConfigBinary(environment),
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
      registerCodexProcess: (child) => {
        if (process.platform !== "win32") registerChildProcessGroup(child);
      },
    })),
    {},
  );
}

export function resolveCodexUserConfigBinary(environment = process.env) {
  const config = locateOptionalUserConfig(environment);
  const codex = config === undefined
    ? { binary: "codex" }
    : validateCodexConfigDocument(readGatewayConfig(config.configPath).codex ?? {});
  const configuredBinary = effectiveCodexBinary(codex.binary, environment);
  return resolveOptionalExecutable(configuredBinary, environment) ?? configuredBinary;
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

/** WebUI reads lease the supervised primary, waking it after idle release. */
export async function createSharedCodexUserConfigClient({ environment = process.env } = {}) {
  const config = locateUserConfig(environment);
  const document = readGatewayConfig(config.configPath);
  const codex = validateCodexConfigDocument(document.codex ?? {});
  const socketPath = resolvePrimaryAppServerSocketPath({ codex }, config.dataDir);
  const configuredBinary = effectiveCodexBinary(codex.binary, environment);
  const codexBinary = resolveOptionalExecutable(configuredBinary, environment) ?? configuredBinary;
  const { CodexAppServerClient, JsonRpcClient, createAppServerTransport } = await import("../dist/codex-client/index.js");
  const transport = createAppServerTransport({ kind: "local-app-server", socketPath }, {
    connectTimeoutMs: 3_000,
    createCodexProcessInvocation: (args) => codexProcessInvocation(codexBinary, args, environment),
    terminateCodexProcess: terminateChildProcess,
  });
  const client = new CodexAppServerClient(new JsonRpcClient(transport), {});
  const connect = client.connect.bind(client);
  const close = client.close.bind(client);
  const cancellation = new AbortController();
  let connecting;
  let closing;
  let lease;
  client.connect = () => {
    if (cancellation.signal.aborted) return Promise.reject(new Error("共享用户设置连接已关闭"));
    return connecting ??= (async () => {
      const inspection = await inspectAppServerSupervisorState(socketPath, cancellation.signal);
      if (inspection.status === "incompatible") throw new Error("App Server 监管协议不兼容");
      if (inspection.status === "ready") {
        lease = await acquireAppServerProviderLease(
          socketPath, inspection.topology.primaryProvider, cancellation.signal,
        );
      }
      // A missing supervisor still permits an explicitly running standalone primary.
      // Inspection errors must never be interpreted as permission to bypass a lease.
      cancellation.signal.throwIfAborted();
      const initialized = await connect();
      cancellation.signal.throwIfAborted();
      return initialized;
    })();
  };
  client.close = () => {
    cancellation.abort();
    return closing ??= (async () => {
      // Interrupt initialization before waiting for it; never stop the shared server.
      const result = await Promise.allSettled([close(), connecting]);
      if (result[0].status === "rejected") throw result[0].reason;
      // Retain the lease if connection/proxy cleanup is unconfirmed.
      await lease?.close();
      lease = undefined;
    })().finally(() => { closing = undefined; });
  };
  return client;
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
