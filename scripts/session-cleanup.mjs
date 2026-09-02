#!/usr/bin/env node

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createAppServerTransport, CodexAppServerClient, JsonRpcClient } from "../dist/codex-client/index.js";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { ensureAppServerProvider } from "../runtime/app-server-supervisor.mjs";
import { gatewayOwnerIsActive } from "../runtime/gateway-owner.mjs";
import { effectiveCodexBinary, executableInvocation, resolveExecutable } from "../runtime/executable.mjs";
import { terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";
import { createPrompter } from "./terminal-prompter.mjs";
import { SqliteSessionDisplayCache } from "../dist/storage/index.js";

const usage = `用法：codexc sessions cleanup <最大轮数> [--idle-days <天数>] [--confirm]

默认只预览，不归档。加 --confirm 才会归档符合条件的旧会话。
执行前必须停止 Gateway；App Server 保持运行。清理覆盖配置中的全部 Workspace 和 Provider。
指定 --idle-days 后，只有“Turn 不超过上限 且 连续空闲达到天数”的会话才会进入候选。`;

export async function runSessionCleanup(args, { environment = process.env, output = console } = {}) {
  if (args.length === 0 || args.some((arg) => arg === "-h" || arg === "--help")) {
    if (args.length > 1 || (args.length === 1 && !["-h", "--help"].includes(args[0]))) {
      throw new Error(usage);
    }
    output.log(usage);
    return;
  }
  const { confirm, maxTurns, idleDays } = parseSessionCleanupArgs(args);

  const config = requireUserConfig(environment);
  if (await gatewayOwnerIsActive(config.configPath)) {
    throw new Error("清理会话前必须先停止 Gateway：codexc service stop gateway");
  }
  const document = readGatewayConfig(config.configPath);
  const workspaces = readWorkspaceConfig(document).workspaces;
  const runtime = resolveAppServerRuntime(document, config.dataDir, environment);
  const codexBinary = resolveExecutable(effectiveCodexBinary(document.codex.binary, environment), environment);
  const cache = new SqliteSessionDisplayCache(join(config.dataDir, "data", "session-display-cache.sqlite3"));
  const bound = readBoundThreadIds(resolveConfiguredPath(document.storage?.database_path, config.dataDir, "data/gateway.sqlite3"));
  const clients = [];
  const unavailable = [];
  const candidates = [];
  const failures = [];
  const seen = new Set();
  let listedThreads = 0;
  let filteredThreads = 0;
  let cacheHits = 0;
  let historyReads = 0;
  try {
    for (const provider of runtime.managedProviders) {
      await ensureAppServerProvider(runtime.primarySocketPath, provider.provider);
    }
    const socketEntries = runtime.socketPaths.map((socketPath, index) => ({
      socketPath,
      provider: index === 0
        ? runtime.primaryProvider
        : runtime.managedProviders[index - 1]?.provider ?? "unknown",
    }));
    for (const { socketPath, provider } of socketEntries) {
      const transport = createAppServerTransport({ kind: "local-app-server", socketPath }, {
        codexBinary,
        createCodexProcessInvocation: (args) => executableInvocation(codexBinary, args, environment),
        terminateCodexProcess: terminateChildProcess,
        connectTimeoutMs: 3_000,
      });
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      try { await client.connect(); } catch {
        await client.close().catch(() => undefined);
        unavailable.push(`${provider}（${socketPath}）`);
        continue;
      }
      clients.push(client);
    }
    if (unavailable.length > 0) {
      throw new Error(`以下 App Server 无法连接，已拒绝不完整清理：${unavailable.join("、")}`);
    }
    if (clients.length === 0) throw new Error("无法连接任何 App Server，请确认 App Server 正在运行");
    output.log(`正在扫描会话目录（${clients.length} 个 Provider，${workspaces.length} 个 Workspace）…`);
    const jobs = clients.flatMap((client) => workspaces.map((workspace) => ({ client, workspace })));
    const scanned = await mapWithConcurrency(jobs, 3, async ({ client, workspace }) => ({
      client,
      workspace,
      threads: await client.listThreads(workspace.cwd, { fullScan: true }),
    }));
    const idleCutoff = idleDays === null ? null : Math.floor(Date.now() / 1000) - idleDays * 86_400;
    for (const { client, workspace, threads } of scanned) {
      for (const thread of threads) {
        listedThreads += 1;
        if (seen.has(thread.id) || bound.has(thread.id) || thread.isPinned || thread.activeTurnId
          || thread.status.type === "active") {
          filteredThreads += 1;
          continue;
        }
        if (idleCutoff !== null && !isThreadIdle(thread, idleCutoff)) {
          filteredThreads += 1;
          continue;
        }
        seen.add(thread.id);
        const cached = cache.get(thread.id);
        let turnCount = cached && cached.measuredAt !== null && Date.now() - cached.measuredAt < 5 * 60_000
          ? cached.turnCount : null;
        if (turnCount !== null) cacheHits += 1;
        if (turnCount === null) {
          historyReads += 1;
          turnCount = await countTurns(client, thread.id);
        }
        cache.put({ threadId: thread.id, workspaceId: workspace.id, archived: false, preview: thread.preview,
          name: thread.name, modelProvider: thread.modelProvider, status: thread.status,
          activeTurnId: thread.activeTurnId, isPinned: thread.isPinned, turnCount, measuredAt: Date.now() });
        if (turnCount <= maxTurns) candidates.push({ id: thread.id, name: thread.name, turnCount, client });
      }
    }
    output.log(`扫描完成：发现 ${listedThreads} 个 Thread，过滤 ${filteredThreads} 个，读取历史 ${historyReads} 个，缓存命中 ${cacheHits} 个。`);
    output.log(`待归档会话（Turn ≤ ${maxTurns}${idleDays === null ? "" : ` 且空闲 ≥ ${idleDays} 天`}）：${candidates.length} 个`);
    candidates.forEach((item, index) => output.log(`${index + 1}. ${item.name ?? "未命名"} · ${item.turnCount} 轮 · ${item.id.slice(0, 13)}`));
    if (!confirm) {
      output.log(`确认执行：codexc sessions cleanup ${maxTurns}${idleDays === null ? "" : ` --idle-days ${idleDays}`} --confirm（仅限交互终端）`);
      return { maxTurns, idleDays, candidates };
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("归档确认必须在交互终端执行；请先预览，再在本机终端加 --confirm 重试");
    }
    const prompter = createPrompter(process.stdin, process.stdout);
    let accepted;
    try { accepted = await prompter.confirm(`确认归档以上 ${candidates.length} 个会话`, false); }
    finally { prompter.close(); }
    if (!accepted) {
      output.log("已取消会话清理。");
      return { maxTurns, idleDays, candidates, archived: 0 };
    }
    let archived = 0;
    for (const candidate of candidates) {
      try {
        const current = await candidate.client.readThread(candidate.id);
        if (bound.has(candidate.id)) {
          failures.push({ candidate, reason: "已重新绑定渠道" });
          continue;
        }
        if (current.isPinned) {
          failures.push({ candidate, reason: "已被固定" });
          continue;
        }
        if (current.activeTurnId || current.status.type === "active") {
          failures.push({ candidate, reason: "已进入活动状态" });
          continue;
        }
        if (idleCutoff !== null && !isThreadIdle(current, idleCutoff)) {
          failures.push({ candidate, reason: `最近活动时间未达到 ${idleDays} 天` });
          continue;
        }
        const currentTurnCount = await countTurns(candidate.client, candidate.id);
        if (currentTurnCount !== candidate.turnCount) {
          failures.push({ candidate, reason: `Turn 数已变化（当前 ${currentTurnCount}）` });
          continue;
        }
        if (currentTurnCount > maxTurns) {
          failures.push({ candidate, reason: `当前 Turn 数 ${currentTurnCount} 超过上限` });
          continue;
        }
        await candidate.client.archiveThread(candidate.id);
        cache.remove(candidate.id);
        archived += 1;
      } catch (error) {
        failures.push({ candidate, reason: summarizeFailure(error) });
      }
    }
    output.log(`会话清理完成：归档 ${archived} 个，失败 ${failures.length} 个。`);
    for (const failure of failures) {
      output.log(`失败：${failure.candidate.name ?? "未命名"} · ${failure.candidate.id} · ${failure.reason}`);
    }
    return { maxTurns, idleDays, candidates, archived, failed: failures };
  } finally {
    cache.close();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }
}

export function parseSessionCleanupArgs(args) {
  const confirm = args.includes("--confirm");
  const values = args.filter((arg) => arg !== "--confirm");
  if (values.length < 1 || !/^\d+$/u.test(values[0] ?? "")) throw new Error(usage);
  const maxTurns = Number(values[0]);
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 0 || maxTurns > 10_000) throw new Error(usage);
  let idleDays = null;
  if (values.length > 1) {
    if (values[1] !== "--idle-days" || !/^\d+$/u.test(values[2] ?? "") || values.length !== 3) {
      throw new Error(usage);
    }
    idleDays = Number(values[2]);
    if (!Number.isSafeInteger(idleDays) || idleDays < 1 || idleDays > 36_500) throw new Error(usage);
  }
  return { confirm, maxTurns, idleDays };
}

export function isThreadIdle(thread, cutoffSeconds) {
  const lastActivity = thread.recencyAt ?? thread.updatedAt;
  return lastActivity !== undefined && lastActivity !== null && lastActivity <= cutoffSeconds;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker));
  return results;
}

async function countTurns(client, threadId) {
  let cursor;
  let total = 0;
  const cursors = new Set();
  do {
    const page = await client.listThreadTurns(threadId, { cursor, limit: 100 });
    total += page.turns.length;
    cursor = page.nextCursor;
    if (cursor && !cursors.add(cursor)) throw new Error("Codex Turn 列表返回了循环游标");
  } while (cursor);
  return total;
}

function readBoundThreadIds(path) {
  if (!existsSync(path)) return new Set();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const ids = new Set();
    for (const table of ["conversation_bindings", "conversation_background_bindings"]) {
      for (const row of database.prepare(`SELECT thread_id FROM ${table}`).all()) ids.add(row.thread_id);
    }
    return ids;
  } finally { database.close(); }
}

function resolveConfiguredPath(value, dataDir, fallback) {
  return typeof value === "string" && value.trim() ? (isAbsolute(value) ? resolve(value) : resolve(dataDir, value)) : join(dataDir, fallback);
}

function summarizeFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 240) || "未知错误";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSessionCleanup(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
