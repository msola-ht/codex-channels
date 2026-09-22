#!/usr/bin/env node

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
主会话轮数用于筛选，派生后代随官方归档；指定 --idle-days 时可查询成员均须达到空闲天数。`;

export async function runSessionCleanup(args, { environment = process.env, output = console } = {}) {
  if (args.length === 0 || args.some((arg) => arg === "-h" || arg === "--help")) {
    if (args.length > 1 || (args.length === 1 && !["-h", "--help"].includes(args[0]))) throw new Error(usage);
    output.log(usage);
    return;
  }
  const { confirm, maxTurns, idleDays } = parseSessionCleanupArgs(args);
  const config = requireUserConfig(environment);
  await requireStoppedGateway(config.configPath);
  const document = readGatewayConfig(config.configPath);
  const workspaces = readWorkspaceConfig(document).workspaces;
  const runtime = resolveAppServerRuntime(document, config.dataDir, environment);
  const codexBinary = resolveExecutable(effectiveCodexBinary(document.codex.binary, environment), environment);
  const databasePath = resolveConfiguredPath(document.storage?.database_path, config.dataDir, "data/gateway.sqlite3");
  const clients = new Map();
  const candidates = [];
  const skipped = [];
  const results = [];
  let cache;
  try {
    const socketEntries = [
      { socketPath: runtime.primarySocketPath, provider: runtime.primaryProvider },
      ...runtime.managedProviders.map((provider, index) => ({
        socketPath: runtime.managedSocketPaths[index], provider: provider.provider,
      })),
    ];
    for (const { socketPath, provider } of socketEntries) {
      await ensureAppServerProvider(runtime.primarySocketPath, provider);
      const transport = createAppServerTransport({ kind: "local-app-server", socketPath }, {
        codexBinary,
        createCodexProcessInvocation: (values) => executableInvocation(codexBinary, values, environment),
        terminateCodexProcess: terminateChildProcess,
        connectTimeoutMs: 3_000,
      });
      const client = new CodexAppServerClient(new JsonRpcClient(transport), { sandbox: "read-only" });
      try {
        await client.connect();
      } catch (error) {
        await client.close().catch(() => undefined);
        throw new Error("Provider " + provider + " 无法连接，已拒绝不完整扫描", { cause: error });
      }
      clients.set(provider, client);
    }
    const context = {
      clients, workspaces, databasePath, maxTurns,
      idleCutoff: idleDays === null ? null : Math.floor(Date.now() / 1000) - idleDays * 86_400,
    };
    output.log("正在扫描主会话（" + clients.size + " 个 Provider，" + workspaces.length + " 个 Workspace）…");
    const roots = new Map();
    for (const client of clients.values()) {
      for (const workspace of workspaces) {
        for (const thread of await client.listThreads(workspace.cwd, { fullScan: true })) {
          if (!thread.parentThreadId && thread.source !== "automation") roots.set(thread.id, thread);
        }
      }
    }
    for (const thread of roots.values()) {
      try {
        candidates.push(await inspectCandidate(thread, context));
      } catch (error) {
        skipped.push({ id: thread.id, reason: summarizeFailure(error) });
      }
    }
    output.log("待归档主会话组：" + candidates.length + "；跳过：" + skipped.length);
    for (const [index, candidate] of candidates.entries()) {
      const children = candidate.members.slice(1);
      output.log((index + 1) + ". " + (candidate.thread.name ?? "未命名") + " · "
        + candidate.thread.modelProvider + " · " + candidate.thread.cwd + " · "
        + candidate.turnCount + " 轮 · " + candidate.thread.id
        + " · 未归档后代 " + children.filter((item) => !item.archived).length
        + "，已归档后代 " + children.filter((item) => item.archived).length);
    }
    for (const item of skipped) output.log("跳过：" + item.id + " · " + item.reason);
    output.log("父会话及派生后代由官方一起归档；后代数量仅含可查询成员。操作不是整组原子事务，请勿同时操作候选会话。");
    if (!confirm || candidates.length === 0) {
      if (!confirm) output.log("确认执行：codexc sessions cleanup " + maxTurns
        + (idleDays === null ? "" : " --idle-days " + idleDays) + " --confirm（仅限交互终端）");
      return { maxTurns, idleDays, candidates, skipped, results };
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("归档确认必须在交互终端执行；请先预览，再在本机终端加 --confirm 重试");
    }
    const prompter = createPrompter(process.stdin, process.stdout);
    let accepted;
    try {
      accepted = await prompter.confirm("确认归档以上 " + candidates.length + " 个主会话及其派生后代", false);
    } finally { prompter.close(); }
    if (!accepted) {
      output.log("已取消会话归档。");
      return { maxTurns, idleDays, candidates, skipped, results };
    }
    for (const candidate of candidates) {
      if (await gatewayOwnerIsActive(config.configPath)) {
        output.log("Gateway 已启动，停止执行剩余归档。");
        for (const remaining of candidates.slice(results.length)) {
          results.push({ id: remaining.thread.id, status: "skipped", reason: "Gateway 已启动" });
        }
        break;
      }
      let current;
      try {
        current = await inspectCandidate(candidate.thread, context);
        if (candidateSnapshot(current) !== candidateSnapshot(candidate)) throw new Error("会话组已变化，请重新预览");
        await requireStoppedGateway(config.configPath);
        requireUnbound(current.members, readBoundThreadIds(databasePath));
      } catch (error) {
        results.push({ id: candidate.thread.id, status: "skipped", reason: summarizeFailure(error) });
        continue;
      }
      const client = clientFor(current.thread, clients);
      let requestError;
      try { await client.archiveThread(current.thread.id); }
      catch (error) { requestError = summarizeFailure(error); }
      let result;
      try { result = await verifyArchive(current, client); }
      catch (error) {
        result = { status: "unconfirmed", archivedIds: [], reason: "结果核验失败：" + summarizeFailure(error) };
      }
      if (requestError) result.requestError = requestError;
      if (result.archivedIds.length > 0) {
        try {
          cache ??= new SqliteSessionDisplayCache(join(dirname(databasePath), "session-display-cache.sqlite3"));
          for (const id of result.archivedIds) cache.remove(id);
        } catch (error) {
          result.cacheError = summarizeFailure(error);
        }
      }
      results.push({ id: current.thread.id, ...result });
    }
    const labels = { confirmed: "已核验可查询成员归档", partial: "部分完成", failed: "未归档", unconfirmed: "结果未确认", skipped: "跳过" };
    for (const result of results) {
      output.log(labels[result.status] + "：" + result.id + (result.reason ? " · " + result.reason : "")
        + (result.requestError ? " · 请求错误：" + result.requestError : "")
        + (result.cacheError ? " · 展示缓存清理失败：" + result.cacheError : ""));
    }
    output.log("归档结束：已核验 " + results.filter((item) => item.status === "confirmed").length
      + " 组，其余 " + results.filter((item) => item.status !== "confirmed").length + " 组；未自动重试或回滚。");
    return { maxTurns, idleDays, candidates, skipped, results };
  } finally {
    try { cache?.close(); }
    finally { await Promise.all([...clients.values()].map((client) => client.close().catch(() => undefined))); }
  }
}

async function requireStoppedGateway(configPath) {
  if (await gatewayOwnerIsActive(configPath)) throw new Error("清理会话前必须先停止 Gateway：codexc service stop gateway");
}

function clientFor(thread, clients) {
  const client = clients.get(thread.modelProvider);
  if (!client) throw new Error("会话所属 Provider 不可用：" + thread.modelProvider);
  return client;
}

async function readOwnedThread(thread, clients) {
  const current = await clientFor(thread, clients).readThread(thread.id);
  if (current.modelProvider !== thread.modelProvider) throw new Error("会话 Provider 已变化");
  return current;
}

async function readDescendants(client, id) {
  const members = [];
  for (const archived of [false, true]) {
    for (const thread of await client.listThreadDescendants(id, archived)) members.push({ thread, archived });
  }
  const ids = new Set();
  for (const { thread } of members) {
    if (thread.id === id || ids.has(thread.id)) throw new Error("后代列表已变化或包含重复成员");
    ids.add(thread.id);
  }
  return members;
}

function requireUnbound(members, bound) {
  if (members.some(({ thread }) => bound.has(thread.id))) throw new Error("会话组包含渠道当前或后台绑定");
}

async function inspectCandidate(listed, context) {
  const { clients, workspaces, databasePath, maxTurns, idleCutoff } = context;
  const thread = await readOwnedThread(listed, clients);
  if (thread.parentThreadId || thread.source === "automation") throw new Error("不是可清理的交互主会话");
  const client = clientFor(thread, clients);
  const members = [{ thread, archived: false }];
  const children = await readDescendants(client, thread.id);
  for (const child of children) {
    members.push({ thread: await readOwnedThread(child.thread, clients), archived: child.archived });
  }
  for (const { thread: member } of members) {
    if (!workspaces.some((workspace) => workspace.cwd === member.cwd)) throw new Error("会话组包含未配置 Workspace：" + member.id);
    if (member.isPinned) throw new Error("会话组包含固定会话：" + member.id);
    if (member.activeTurnId || member.status.type === "active") throw new Error("会话组包含活动会话：" + member.id);
    if (member.status.type !== "idle" && member.status.type !== "notLoaded") throw new Error("会话状态不可确认：" + member.id);
    if (idleCutoff !== null && !isThreadIdle(member, idleCutoff)) throw new Error("会话组未达到空闲天数条件");
  }
  requireUnbound(members, readBoundThreadIds(databasePath));
  const turnCount = await countTurns(client, thread.id, maxTurns);
  if (turnCount > maxTurns) throw new Error("主会话 Turn 数超过上限");
  return { thread, members, turnCount };
}

function candidateSnapshot(candidate) {
  return JSON.stringify({
    turnCount: candidate.turnCount,
    members: candidate.members.map(({ thread, archived }) => ({
      id: thread.id, parentThreadId: thread.parentThreadId, provider: thread.modelProvider,
      cwd: thread.cwd, archived, updatedAt: thread.updatedAt, recencyAt: thread.recencyAt,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

async function verifyArchive(candidate, client) {
  const descendants = await readDescendants(client, candidate.thread.id);
  const archivedRoots = await client.listThreads(candidate.thread.cwd, { fullScan: true, archived: true });
  const activeRoots = await client.listThreads(candidate.thread.cwd, { fullScan: true, archived: false });
  const archived = new Set(descendants.filter((item) => item.archived).map((item) => item.thread.id));
  const active = new Set(descendants.filter((item) => !item.archived).map((item) => item.thread.id));
  if (archivedRoots.some((thread) => thread.id === candidate.thread.id)) archived.add(candidate.thread.id);
  if (activeRoots.some((thread) => thread.id === candidate.thread.id)) active.add(candidate.thread.id);
  const expected = candidate.members.filter((item) => !item.archived).map((item) => item.thread.id);
  const archivedIds = expected.filter((id) => archived.has(id) && !active.has(id));
  const known = new Set(candidate.members.map((item) => item.thread.id));
  const uncertain = candidate.members.some(({ thread }) => !archived.has(thread.id) && !active.has(thread.id))
    || [...archived].some((id) => active.has(id))
    || descendants.some(({ thread }) => !known.has(thread.id));
  const remaining = candidate.members.filter(({ thread }) => active.has(thread.id)).map(({ thread }) => thread.id);
  if (uncertain) return { status: "unconfirmed", archivedIds, reason: "会话组成员或归档状态无法完整核验" };
  if (remaining.length === 0) return { status: "confirmed", archivedIds };
  return {
    status: archivedIds.length > 0 ? "partial" : "failed", archivedIds,
    reason: "仍未归档：" + remaining.join("、"),
  };
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

async function countTurns(client, threadId, maxTurns) {
  let cursor;
  let total = 0;
  const cursors = new Set();
  do {
    const page = await client.listThreadTurns(threadId, { cursor, limit: 100 });
    total += page.turns.length;
    if (total > maxTurns) return total;
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("Codex Turn 列表返回了循环游标");
    if (cursor) cursors.add(cursor);
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
