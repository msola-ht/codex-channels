#!/usr/bin/env node

import { lstatSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";

import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import {
  appServerSocketAcceptsWebSocket,
  inspectAppServerSupervisorState,
} from "../runtime/app-server-supervisor.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";
import { queryModelRelayControl } from "../runtime/model-relay-control.mjs";
import { inspectManagedServiceStatus } from "./service-status.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  parseTrafficCleanupArgs,
  TRAFFIC_CLEANUP_USAGE,
} from "./traffic-command-options.mjs";
import { dumpCatalog } from "./traffic-dump-reader.mjs";
import { locateOptionalUserConfig, userDataDir } from "./runtime-config.mjs";
import { withCliLifecycleCancellation } from "./cli-lifecycle-command.mjs";

export async function runTrafficCleanup(
  args,
  {
    assertAppServersStopped = assertConfiguredAppServersStopped,
    environment = process.env,
    expectedFingerprint,
    output = console,
    signal,
  } = {},
) {
  signal?.throwIfAborted();
  const options = parseTrafficCleanupArgs(args);
  const located = locateOptionalUserConfig(environment);
  const directory = options.directory ?? join(located?.dataDir ?? userDataDir(environment), "traffic");
  const { preview } = trafficCleanupSnapshot(directory);
  const fingerprint = preview.fingerprint;
  const plan = { ...preview, fingerprint };
  renderPreview(preview, output);
  const expected = expectedFingerprint ?? options.expectedFingerprint;
  if (expected !== undefined && expected !== fingerprint) {
    throw new Error("转储范围在预览后发生变化，请重新预览并确认；未删除任何文件");
  }
  if (preview.targets.length === 0) return plan;
  if (!options.confirm) {
    output.log("未删除。停止全部 App Server 与 Relay 后，加 --confirm 再执行。");
    return plan;
  }
  await assertAppServersStopped(environment, directory);
  signal?.throwIfAborted();
  const { preview: confirmed, identity: current } = trafficCleanupSnapshot(directory);
  if (preview.fingerprint !== confirmed.fingerprint) {
    throw new Error("转储范围在预览后发生变化，请重新预览并确认；未删除任何文件");
  }
  let deleted = 0;
  for (const [index, target] of confirmed.targets.entries()) {
    await setImmediate();
    if (signal?.aborted) {
      output.log(`清理已中止，已删除 ${deleted}/${confirmed.targets.length} 个 V2 session。`);
      signal.throwIfAborted();
    }
    if (JSON.stringify(directoryIdentity(directory)) !== JSON.stringify(current.root)
      || JSON.stringify(targetIdentity(target)) !== JSON.stringify(current.targets[index])) {
      throw new Error(`转储对象在删除前发生变化，已停止；已删除 ${deleted}/${confirmed.targets.length} 个 V2 session`);
    }
    rmSync(target, { force: true, recursive: true });
    // Removing our own child changes the root directory's timestamps, not its identity.
    deleted++;
  }
  output.log(`已删除 ${confirmed.v2Sessions} 个 V2 session（${formatBytes(confirmed.bytes)}）。`);
  return { ...confirmed, fingerprint };
}

function directoryIdentity(path) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory()) throw new Error("转储清理目录类型无效");
  return { dev: metadata.dev, ino: metadata.ino };
}

function targetIdentity(path) {
  const directory = directoryIdentity(path);
  const metadata = lstatSync(join(path, "manifest.json"));
  if (!metadata.isFile()) throw new Error("转储清理 manifest 类型无效");
  return { path, directory, dev: metadata.dev, ino: metadata.ino, size: metadata.size,
    mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs };
}

function cleanupIdentity(preview) {
  return { root: directoryIdentity(preview.directory), resources: preview.resources, bytes: preview.bytes,
    targets: preview.targets.map(targetIdentity) };
}

export function trafficCleanupPreview(directory) {
  return trafficCleanupSnapshot(directory).preview;
}

function trafficCleanupSnapshot(directory) {
  const catalog = dumpCatalog(directory);
  const targets = catalog.files;
  const preview = {
    bytes: targets.reduce((total, target) => total + pathSize(target), 0),
    directory,
    labels: catalog.labels.length,
    resources: [
      ...catalog.sessions.map((session) => ({
        createdAtMs: session.createdAtMs,
        label: session.label,
        session: session.session,
        type: "v2",
      })),
    ],
    targets,
    v2Sessions: catalog.files.length,
  };
  // Empty previews also bind the selected directory, never newly added data.
  const identity = targets.length === 0 ? { directory, targets: [] } : cleanupIdentity(preview);
  preview.fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return { preview, identity };
}

export async function assertConfiguredAppServersStopped(environment, directory) {
  const located = locateOptionalUserConfig(environment);
  if (located === undefined) {
    throw new Error("确认清理转储前必须先初始化并使用对应的 Gateway 配置");
  }
  const configuredDirectory = join(located.dataDir, "traffic");
  if (directory !== configuredDirectory) {
    throw new Error(
      `确认清理只允许当前配置的转储目录：${configuredDirectory}`,
    );
  }
  const relay = await queryModelRelayControl(modelRelayPaths(located.configPath).control, "status");
  if (relay.result !== "not_running") throw new Error("清理转储前必须停止 Relay 并确认进程退出：codexc stop relay");
  for (const target of ["model-relay", "app-server"]) {
    const managed = inspectManagedServiceStatus({ environment: { ...environment, CODEX_CONNECT_HOME: located.dataDir }, target });
    if (managed.services.length === 0 || managed.services.some(service => service.running
      || !["inactive", "inactive/dead", "not-found", "missing", "not-loaded", "stopped", "disabled", "ready"].includes(service.state))) {
      throw new Error(`${target} 服务仍在运行或状态未确认；请先停止服务再清理转储`);
    }
  }
  const document = readGatewayConfig(located.configPath);
  const runtime = resolveAppServerRuntime(document, located.dataDir, environment);
  const supervisor = await inspectAppServerSupervisorState(runtime.primarySocketPath);
  const occupied = await Promise.all(runtime.socketPaths.map((socketPath) =>
    appServerSocketAcceptsWebSocket(socketPath, { ...environment, CODEX_BINARY: document.codex?.binary ?? environment.CODEX_BINARY ?? "codex" })));
  if (supervisor.status !== "missing" || occupied.some(Boolean)) {
    throw new Error("清理转储前必须先停止全部 App Server：codexc stop appserver");
  }
}

function renderPreview(preview, output) {
  output.log([
    "转储清理预览：",
    `目录：${preview.directory}`,
    `V2 session：${preview.v2Sessions}（${preview.labels} 个 Provider 标签）`,
    `占用：${formatBytes(preview.bytes)}`,
  ].join("\n"));
}

function pathSize(path) {
  const status = lstatSync(path);
  if (!status.isDirectory()) return status.size;
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name);
    return total + (entry.isDirectory() ? pathSize(child) : lstatSync(child).size);
  }, 0);
}

function formatBytes(bytes) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  withCliLifecycleCancellation("转储清理", signal => runTrafficCleanup(process.argv.slice(2), { signal })).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.exitCode ?? 1;
  });
}

export { TRAFFIC_CLEANUP_USAGE };
