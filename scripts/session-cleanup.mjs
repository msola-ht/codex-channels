#!/usr/bin/env node

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createAppServerTransport, CodexAppServerClient, JsonRpcClient } from "../dist/codex-client/index.js";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { aggregateProviderId } from "../runtime/aggregate-model-provider.mjs";
import { ensureAppServerProvider } from "../runtime/app-server-supervisor.mjs";
import { gatewayOwnerIsActive } from "../runtime/gateway-owner.mjs";
import { effectiveCodexBinary, resolveExecutable } from "../runtime/executable.mjs";
import { codexProcessInvocation } from "../runtime/owned-process.mjs";
import { terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { requireUserConfig } from "./runtime-config.mjs";
import { readWorkspaceConfig } from "./workspace-config.mjs";
import { createPrompter } from "./terminal-prompter.mjs";
import { SqliteSessionDisplayCache } from "../dist/storage/index.js";
import { sessionCleanupUsage as usage } from "./cli-command-usage.mjs";
import { assertStateDatabaseSchema } from "./state-database.mjs";
import { withCliLifecycleCancellation } from "./cli-lifecycle-command.mjs";

const unclosedClients = new Set();
async function closeClients(clients) {
  const results = await Promise.allSettled([...clients].map(async client => {
    unclosedClients.add(client);
    await client.close();
    unclosedClients.delete(client);
  }));
  return results.every(result => result.status === "fulfilled");
}

export async function runSessionCleanup(args, { environment = process.env, output = console, signal } = {}) {
  signal?.throwIfAborted();
  if (args.length === 0 || args.some((arg) => arg === "-h" || arg === "--help")) {
    if (args.length > 1 || (args.length === 1 && !["-h", "--help"].includes(args[0]))) throw new Error(usage);
    output.log(usage);
    return;
  }
  const { confirm, maxTurns, idleDays } = parseSessionCleanupArgs(args);
  if (!(await closeClients(unclosedClients))) throw new Error("上次归档检查连接清理未确认，已拒绝启动新的扫描");
  if (confirm && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error("归档确认必须在交互终端执行；请先不加 --confirm 预览，再在本机终端加 --confirm 重试");
  }
  const config = requireUserConfig(environment);
  await requireStoppedGateway(config.configPath);
  signal?.throwIfAborted();
  const document = readGatewayConfig(config.configPath);
  const workspaces = readWorkspaceConfig(document).workspaces;
  const runtime = resolveAppServerRuntime(document, config.dataDir, environment);
  const codexBinary = resolveExecutable(effectiveCodexBinary(document.codex.binary, environment), environment);
  const databasePath = resolveConfiguredPath(document.storage?.database_path, config.dataDir, "data/gateway.sqlite3");
  readBoundThreadIds(databasePath);
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
    const connectProvider = async ({ socketPath, provider }) => {
      signal?.throwIfAborted();
      await ensureAppServerProvider(runtime.primarySocketPath, provider);
      signal?.throwIfAborted();
      const transport = createAppServerTransport({ kind: "local-app-server", socketPath }, {
        createCodexProcessInvocation: (values) => codexProcessInvocation(codexBinary, values, environment),
        terminateCodexProcess: terminateChildProcess,
        connectTimeoutMs: 3_000,
      });
      const client = new CodexAppServerClient(new JsonRpcClient(transport), {});
      clients.set(provider, client);
      try {
        await client.connect();
      } catch (error) {
        throw new Error("Provider " + provider + " 无法连接，已拒绝不完整扫描", { cause: error });
      }
    };
    for (const entry of socketEntries) {
      if (entry.provider === runtime.primaryProvider || entry.provider !== aggregateProviderId) {
        output.log("正在连接归档检查入口：" + entry.provider);
        await connectProvider(entry);
      }
    }
    // thread/list explicitly includes every Provider in the shared Codex Home.
    // Do not start an unused virtual instance merely to discover its history.
    let aggregateConnection;
    const ensureClient = async (provider) => {
      signal?.throwIfAborted();
      if (provider !== aggregateProviderId || clients.has(provider)) return;
      const entry = socketEntries.find(value => value.provider === provider);
      if (!entry) return; // Removed Providers use shared-history maintenance.
      aggregateConnection ??= connectProvider(entry);
      await aggregateConnection;
    };
    const context = {
      clients, ensureClient, primaryClient: clients.get(runtime.primaryProvider), workspaces, databasePath, maxTurns, signal,
      idleCutoff: idleDays === null ? null : Math.floor(Date.now() / 1000) - idleDays * 86_400,
    };
    output.log("正在扫描主会话（已连接 " + clients.size + " 个 Provider，" + workspaces.length + " 个 Workspace；聚合会话按需连接）…");
    const roots = new Map();
    // Every instance shares the same history; modelProviders: [] already covers
    // historical Providers. Only live-state reads need the owning instance.
    for (const cwd of new Set(workspaces.map(workspace => workspace.cwd))) {
      signal?.throwIfAborted();
      for (const thread of await context.primaryClient.listThreads(cwd, { fullScan: true })) {
        if (!thread.parentThreadId && thread.source !== "automation") roots.set(thread.id, thread);
      }
    }
    output.log("正在检查 " + roots.size + " 个主会话（最多同时检查 4 组）…");
    let inspected = 0;
    const inspections = await inspectInBatches([...roots.values()], async thread => {
      try {
        return { candidate: await inspectCandidate(thread, context) };
      } catch (error) {
        return { skipped: { id: thread.id, reason: summarizeFailure(error) } };
      } finally {
        inspected++;
        if (inspected % 10 === 0 || inspected === roots.size) output.log("扫描进度：" + inspected + "/" + roots.size);
      }
    }, signal);
    signal?.throwIfAborted();
    for (const inspection of inspections) {
      if (inspection.candidate) candidates.push(inspection.candidate);
      else skipped.push(inspection.skipped);
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
    output.log("父会话及派生后代由官方一起归档；后代数量仅含可查询成员。已移除 Provider 的历史仍可维护，不需要恢复模型凭据。");
    output.log("活动预检覆盖已连接实例；其他实例的写入占用由官方归档锁拒绝。操作不是整组原子事务，请勿同时操作候选会话。");
    if (!confirm || candidates.length === 0) {
      if (!confirm) output.log("确认执行：codexc cleanup sessions " + maxTurns
        + (idleDays === null ? "" : " --idle-days " + idleDays) + " --confirm（仅限交互终端）");
      return { maxTurns, idleDays, candidates, skipped, results };
    }
    const prompter = createPrompter(process.stdin, process.stdout);
    let accepted;
    try {
      accepted = await prompter.confirm("确认归档以上 " + candidates.length + " 个主会话及其派生后代", false, { signal });
    } finally { prompter.close(); }
    if (!accepted) {
      output.log("已取消会话归档。");
      return { maxTurns, idleDays, candidates, skipped, results };
    }
    const pendingVerification = [];
    for (const [index, candidate] of candidates.entries()) {
      output.log("归档进度：" + (index + 1) + "/" + candidates.length + " · 复核 " + candidate.thread.id);
      let stopReason;
      if (signal?.aborted) stopReason = "已收到取消请求";
      try {
        if (!stopReason && await gatewayOwnerIsActive(config.configPath)) stopReason = "Gateway 已启动";
      } catch (error) { stopReason = "Gateway 状态无法确认：" + summarizeFailure(error); }
      if (stopReason) {
        output.log(stopReason + "，停止执行剩余归档，继续核验已发出的请求。");
        for (const remaining of candidates.slice(index)) {
          results.push({ id: remaining.thread.id, status: "skipped", reason: stopReason });
        }
        break;
      }
      let current;
      try {
        current = await inspectCandidate(candidate.thread, context);
        if (candidateSnapshot(current) !== candidateSnapshot(candidate)) throw new Error("会话组已变化，请重新预览");
        await requireStoppedGateway(config.configPath);
        requireUnbound(current.members, readBoundThreadIds(databasePath));
        signal?.throwIfAborted();
      } catch (error) {
        results.push({ id: candidate.thread.id, status: "skipped", reason: summarizeFailure(error) });
        continue;
      }
      const client = clients.get(current.maintenanceProvider);
      let requestError;
      try { await client.archiveThread(current.thread.id); }
      catch (error) { requestError = summarizeFailure(error); }
      const result = { id: current.thread.id, status: "unconfirmed", archivedIds: [] };
      if (requestError) result.requestError = requestError;
      results.push(result);
      pendingVerification.push({ candidate: current, client, result });
    }
    // Take fresh authoritative root lists after writes, once per Workspace,
    // rather than rescanning the entire history for every archived group.
    const rootStates = new Map();
    for (const cwd of new Set(pendingVerification.map(item => item.candidate.thread.cwd))) {
      output.log("正在核验归档结果：" + cwd);
      try {
        const archived = await context.primaryClient.listThreads(cwd, { fullScan: true, archived: true });
        const active = await context.primaryClient.listThreads(cwd, { fullScan: true, archived: false });
        rootStates.set(cwd, { archived: new Set(archived.map(thread => thread.id)), active: new Set(active.map(thread => thread.id)) });
      } catch (error) { rootStates.set(cwd, { error }); }
    }
    for (const { candidate: current, client, result } of pendingVerification) {
      let verification;
      try { verification = await verifyArchive(current, client, rootStates.get(current.thread.cwd)); }
      catch (error) {
        verification = { status: "unconfirmed", archivedIds: [], reason: "结果核验失败：" + summarizeFailure(error) };
      }
      Object.assign(result, verification);
      if (result.archivedIds.length > 0) {
        try {
          cache ??= new SqliteSessionDisplayCache(join(dirname(databasePath), "session-display-cache.sqlite3"));
          for (const id of result.archivedIds) cache.remove(id);
        } catch (error) {
          result.cacheError = summarizeFailure(error);
        }
      }
    }
    const labels = { confirmed: "已核验可查询成员归档", partial: "部分完成", failed: "未归档", unconfirmed: "结果未确认", skipped: "跳过" };
    for (const result of results) {
      output.log(labels[result.status] + "：" + result.id + (result.reason ? " · " + result.reason : "")
        + (result.requestError ? " · 请求错误：" + result.requestError : "")
        + (result.cacheError ? " · 展示缓存清理失败：" + result.cacheError : ""));
    }
    output.log("归档结束：已核验 " + results.filter((item) => item.status === "confirmed").length
      + " 组，其余 " + results.filter((item) => item.status !== "confirmed").length + " 组；未自动重试或回滚。");
    signal?.throwIfAborted();
    if (results.some(item => item.status !== "confirmed" || item.cacheError)) {
      throw new Error("归档执行未全部完成或展示缓存清理失败，请按逐组结果核查后重新预览；未自动重试或回滚");
    }
    return { maxTurns, idleDays, candidates, skipped, results };
  } finally {
    try { cache?.close(); }
    finally {
      if (!(await closeClients(clients.values()))) {
        output.log("归档检查连接清理未确认，已保留资源归属；已报告的归档结果不变，请勿因此重复提交。");
      }
    }
  }
}

async function requireStoppedGateway(configPath) {
  if (await gatewayOwnerIsActive(configPath)) throw new Error("清理会话前必须先停止 Gateway：codexc stop gateway");
}

async function readOwnedThread(thread, { clients, ensureClient, primaryClient, signal }) {
  signal?.throwIfAborted();
  await ensureClient(thread.modelProvider);
  const preferred = clients.get(thread.modelProvider) ?? primaryClient;
  const readers = [...clients.entries()];
  let selected;
  for (const [provider, client] of readers) {
    signal?.throwIfAborted();
    const current = await client.readThread(thread.id);
    if (current.id !== thread.id || current.modelProvider !== thread.modelProvider) throw new Error("会话身份或 Provider 已变化");
    requireEligibleMember(current);
    // Historical Providers need no model credentials for maintenance. A live
    // instance still owns its loaded Thread; never replace its active state
    // with the primary instance's notLoaded projection.
    if (current.status.type !== "notLoaded") {
      if (selected && selected.thread.status.type !== "notLoaded") throw new Error("会话被多个实例加载，无法确认归档归属");
      selected = { thread: current, client, provider };
    } else if (!selected || (selected.thread.status.type === "notLoaded" && client === preferred)) {
      selected = { thread: current, client, provider };
    }
  }
  if (!selected) throw new Error("没有可用的历史维护连接");
  return selected;
}

async function readDescendants(client, id, signal) {
  const members = [];
  for (const archived of [false, true]) {
    signal?.throwIfAborted();
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
  context.signal?.throwIfAborted();
  const { workspaces, databasePath, maxTurns, idleCutoff } = context;
  const { thread, client, provider } = await readOwnedThread(listed, context);
  if (thread.parentThreadId || thread.source === "automation") throw new Error("不是可清理的交互主会话");
  if (!workspaces.some(workspace => workspace.cwd === thread.cwd)) throw new Error("会话组包含未配置 Workspace：" + thread.id);
  if (idleCutoff !== null && !isThreadIdle(thread, idleCutoff)) throw new Error("会话组未达到空闲天数条件");
  const turnCount = await countTurns(client, thread.id, maxTurns, context.signal);
  if (turnCount > maxTurns) throw new Error("主会话 Turn 数超过上限");
  const members = [{ thread, archived: false }];
  const loadedProviders = new Set(thread.status.type === "idle" ? [provider] : []);
  const children = await readDescendants(client, thread.id, context.signal);
  for (const child of children) {
    const current = await readOwnedThread(child.thread, context);
    if (current.thread.status.type === "idle") loadedProviders.add(current.provider);
    members.push({ thread: current.thread, archived: child.archived });
  }
  if (loadedProviders.size > 1) throw new Error("会话组被多个实例加载，请先退出对应会话再归档");
  for (const { thread: member } of members) {
    if (!workspaces.some((workspace) => workspace.cwd === member.cwd)) throw new Error("会话组包含未配置 Workspace：" + member.id);
    if (idleCutoff !== null && !isThreadIdle(member, idleCutoff)) throw new Error("会话组未达到空闲天数条件");
  }
  requireUnbound(members, readBoundThreadIds(databasePath));
  const maintenanceProvider = loadedProviders.values().next().value ?? provider;
  return { thread, members, turnCount, maintenanceProvider };
}

function requireEligibleMember(member) {
  if (member.isPinned) throw new Error("会话组包含固定会话：" + member.id);
  if (member.activeTurnId || member.status.type === "active") throw new Error("会话组包含活动会话：" + member.id);
  if (member.status.type !== "idle" && member.status.type !== "notLoaded") throw new Error("会话状态不可确认：" + member.id);
}

async function inspectInBatches(threads, inspect, signal) {
  const results = new Array(threads.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, threads.length) }, async () => {
    while (next < threads.length && !signal?.aborted) {
      const index = next++;
      results[index] = await inspect(threads[index]);
    }
  }));
  return results;
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

async function verifyArchive(candidate, client, rootState) {
  if (rootState.error) throw rootState.error;
  const descendants = await readDescendants(client, candidate.thread.id);
  const archived = new Set(descendants.filter((item) => item.archived).map((item) => item.thread.id));
  const active = new Set(descendants.filter((item) => !item.archived).map((item) => item.thread.id));
  if (rootState.archived.has(candidate.thread.id)) archived.add(candidate.thread.id);
  if (rootState.active.has(candidate.thread.id)) active.add(candidate.thread.id);
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
  if (args.filter((arg) => arg === "--confirm").length > 1) throw new Error("--confirm 不能重复");
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

async function countTurns(client, threadId, maxTurns, signal) {
  let cursor;
  let total = 0;
  const cursors = new Set();
  do {
    signal?.throwIfAborted();
    const page = await client.listThreadTurns(threadId, { cursor, limit: Math.min(100, maxTurns - total + 1) });
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
    assertStateDatabaseSchema(database);
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
  withCliLifecycleCancellation("会话归档", signal => runSessionCleanup(process.argv.slice(2), { signal }))
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = error?.exitCode ?? 1; });
}
