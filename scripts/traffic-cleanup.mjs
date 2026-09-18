#!/usr/bin/env node

import { lstatSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import {
  appServerSocketAcceptsWebSocket,
  inspectAppServerSupervisorState,
} from "../runtime/app-server-supervisor.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  parseTrafficCleanupArgs,
  TRAFFIC_CLEANUP_USAGE,
} from "./traffic-command-options.mjs";
import { dumpCatalog } from "./traffic-dump-reader.mjs";
import { locateOptionalUserConfig, userDataDir } from "./runtime-config.mjs";

export async function runTrafficCleanup(
  args,
  {
    assertAppServersStopped = assertConfiguredAppServersStopped,
    environment = process.env,
    output = console,
  } = {},
) {
  const options = parseTrafficCleanupArgs(args);
  const located = locateOptionalUserConfig(environment);
  const directory = options.directory ?? join(located?.dataDir ?? userDataDir(environment), "traffic");
  const preview = trafficCleanupPreview(directory);
  renderPreview(preview, output);
  if (preview.targets.length === 0) return preview;
  if (!options.confirm) {
    output.log("未删除。停止全部 App Server 后，加 --confirm 再执行。");
    return preview;
  }
  await assertAppServersStopped(environment, directory);
  const confirmed = trafficCleanupPreview(directory);
  for (const target of confirmed.targets) {
    rmSync(target, { force: true, recursive: true });
  }
  output.log(`已删除 ${confirmed.v2Sessions} 个 V2 session、${confirmed.legacyFiles} 个旧版 JSONL（${formatBytes(confirmed.bytes)}）。`);
  return confirmed;
}

export function trafficCleanupPreview(directory) {
  const catalog = dumpCatalog(directory);
  const targets = [...catalog.files, ...catalog.legacyFiles];
  return {
    bytes: targets.reduce((total, target) => total + pathSize(target), 0),
    directory,
    labels: catalog.labels.length,
    legacyFiles: catalog.legacyFiles.length,
    resources: [
      ...catalog.sessions.map((session) => ({
        createdAtMs: session.createdAtMs,
        label: session.label,
        session: session.session,
        type: "v2",
      })),
      ...catalog.legacyFiles.map((path) => ({ name: basename(path), type: "legacy" })),
    ],
    targets,
    v2Sessions: catalog.files.length,
  };
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
  const document = readGatewayConfig(located.configPath);
  const runtime = resolveAppServerRuntime(document, located.dataDir, environment);
  const supervisor = await inspectAppServerSupervisorState(runtime.primarySocketPath);
  const occupied = await Promise.all(runtime.socketPaths.map((socketPath) =>
    appServerSocketAcceptsWebSocket(socketPath)));
  if (supervisor.status !== "missing" || occupied.some(Boolean)) {
    throw new Error("清理转储前必须先停止全部 App Server：codexc service stop app-server");
  }
}

function renderPreview(preview, output) {
  output.log([
    "转储清理预览：",
    `目录：${preview.directory}`,
    `V2 session：${preview.v2Sessions}（${preview.labels} 个 Provider 标签）`,
    `旧版 JSONL：${preview.legacyFiles}`,
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
  runTrafficCleanup(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { TRAFFIC_CLEANUP_USAGE };
