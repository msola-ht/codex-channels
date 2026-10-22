#!/usr/bin/env node

import { lstatSync, statSync } from "node:fs";
import { formatGenerationSpeed } from "../runtime/request-timing.mjs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { modelNameComparison } from "../runtime/model-name-comparison.mjs";
import { formatFailureStage } from "./traffic-dump-presentation.mjs";

import { locateOptionalUserConfig, userDataDir } from "./runtime-config.mjs";
import { parseTrafficCommandArgs } from "./traffic-command-options.mjs";
import { formatElapsedDuration, formatLocalTime, formatLocalTimeZone } from "./metrics-export-format.mjs";
import {
  describeDumpExchange,
  acquireDumpSnapshot,
  createTrafficIndexStore,
  createTrafficReadContext,
  labelOf,
  listDumpFiles,
  readDumpCatalog,
  readDumpSessionPath,
  selectFilesOfLabel,
  shortId,
  summarizeDumpExchange,
  summarizeDumpChanges,
  summarizeDumpFiles,
  writerSessionOf,
} from "./traffic-dump-reader.mjs";

const followIntervalMs = 1_000;
const pageSize = 100;
const maximumPending = 100_000;
const maximumObserved = 2_000_000;
const maximumFollowSessions = 2_048;
const options = parseTrafficCommandArgs(process.argv.slice(2));
const directory = options.directory ?? defaultTrafficDirectory();
const controller = new AbortController();
const indexes = createTrafficIndexStore(controller.signal);
const targets = new Map();
const pageLimits = new Map();
let catalogTargets = new Map();
let reportedPending = false;
let interactionSnapshot;
const stop = (code) => {
  if (!options.follow) process.exitCode = code;
  controller.abort();
};
const interrupt = () => stop(130);
const terminate = () => stop(143);
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);

try {
  if (options.follow) await followTraffic();
  else await renderSessions(selectedSessions());
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} finally {
  controller.abort();
  await indexes.close();
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}

function defaultTrafficDirectory() {
  const located = locateOptionalUserConfig(process.env);
  return join(located?.dataDir ?? userDataDir(process.env), "traffic");
}

function selectedSessions() {
  if (options.files.length > 0) return options.files;
  const sessions = listDumpFiles(directory);
  const newest = sessions.at(-1);
  if (newest === undefined) return [];
  return selectFilesOfLabel(sessions, labelOf(newest)).slice(-1);
}

async function followTraffic() {
  const explicit = options.files.length > 0;
  const states = new Map();
  let known = new Set();
  let label;
  let pendingCount = 0;
  let observedCount = 0;
  const add = (path, baseline) => {
    if (states.has(path)) return states.get(path);
    if (states.size >= maximumFollowSessions) throw new Error(`跟随批次数超过 ${maximumFollowSessions} 上限，请缩小目录范围`);
    const target = targetOf(path);
    states.set(path, { ...target, path, offset: 0, pending: new Set(), observed: new Set(), baseline });
    return target;
  };
  if (explicit) add(options.files[0], false);
  else {
    const files = await catalogFiles();
    known = new Set(files);
    const latest = files.at(-1);
    if (latest !== undefined) label = add(latest, true).label;
  }
  console.log(`时区：${formatLocalTimeZone()}`);
  console.log(`跟随 ${explicit ? options.files[0] : directory} 中的新模型调用，按 Ctrl-C 停止`);
  while (!controller.signal.aborted) {
    if (!explicit) {
      const files = await catalogFiles();
      if (label === undefined && files.length > 0) label = targetOf(files.at(-1)).label;
      for (const path of files) {
        if (!known.has(path) && catalogTargets.get(path).label === label) add(path, false);
      }
      known = new Set(files);
    }
    for (const state of states.values()) {
      try {
        await withSnapshot(state.path, state.snapshotIdentity, async (empty) => {
          if (empty) { state.baseline = false; return; }
          // Retain identifiers and cursors across rotations, never request bodies.
          for (const id of state.pending) {
            const summary = await readSession(state.path, context => summarizeDumpExchange([state.path], id, context), state.snapshotIdentity);
            if (summary?.state === "pending") continue;
            if (summary === null) console.error(`跟随调用已缺失：${state.label}/${state.session} #${id}`);
            else await printFollowExchange(state, summary);
            state.pending.delete(id);
            pendingCount--;
          }
          let throughOffset;
          for (;;) {
            const page = await readPage(state.path, (context, limit) => summarizeDumpChanges([state.path], {
              afterOffset: state.offset, throughOffset, limit, context,
              expectedSnapshotIdentity: state.snapshotIdentity,
            }));
            if (page.snapshotIdentity !== null) state.snapshotIdentity = page.snapshotIdentity;
            throughOffset ??= page.watermark;
            for (const summary of page.exchanges) {
              if (state.observed.has(summary.id)) {
                if (state.pending.has(summary.id) && summary.state !== "pending") {
                  await printFollowExchange(state, summary);
                  state.pending.delete(summary.id);
                  pendingCount--;
                }
                continue;
              }
              if (observedCount >= maximumObserved) throw new Error(`跟随中已观察的调用超过 ${maximumObserved} 上限，请选择单个批次重新跟随`);
              state.observed.add(summary.id);
              observedCount++;
              if (summary.state === "pending") {
                if (pendingCount >= maximumPending) throw new Error(`跟随中的未终态调用超过 ${maximumPending} 上限，请缩小目录范围`);
                state.pending.add(summary.id);
                pendingCount++;
              } else if (!state.baseline) await printFollowExchange(state, summary);
            }
            state.offset = page.nextOffset;
            if (!page.hasMore) break;
          }
          state.baseline = false;
        });
      } catch (error) {
        if (error.code !== "ENOENT" || statSync(state.path, { throwIfNoEntry: false }) !== undefined) throw error;
        console.error(`跟随批次已缺失：${state.label}/${state.session}（${state.pending.size} 个未终态调用停止跟随）`);
        pendingCount -= state.pending.size;
        observedCount -= state.observed.size;
        states.delete(state.path);
        targets.delete(state.path);
        pageLimits.delete(state.path);
      }
    }
    await delay(followIntervalMs, undefined, { signal: controller.signal });
  }
}

async function printFollowExchange(state, summary) {
  const rendered = await renderExchange([state.path], summary, undefined, state.snapshotIdentity);
  if (rendered !== undefined) console.log(`批次：${state.label}/${state.session}\n${rendered}`);
}

async function catalogFiles() {
  const context = createTrafficReadContext(controller.signal);
  const catalog = await readDumpCatalog(directory, context);
  catalogTargets = new Map(catalog.files.map(path => [path, {
    label: labelOf(path, context), session: writerSessionOf(path, context),
  }]));
  return catalog.files;
}

function targetOf(path) {
  let target = targets.get(path);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory()) throw new Error(`V2 转储参数必须是 session 目录：${path}`);
  const identity = `${metadata.dev}:${metadata.ino}`;
  if (target === undefined) {
    target = { ...(catalogTargets.get(path) ?? { label: labelOf(path), session: writerSessionOf(path) }), identity };
    targets.set(path, target);
  } else if (target.identity !== identity) throw new Error(`跟随批次目录已被替换：${target.label}/${target.session}`);
  return target;
}

async function readSession(path, read, expectedSnapshotIdentity) {
  const target = targetOf(path);
  const timeout = new AbortController();
  const signal = globalThis.AbortSignal.any([controller.signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(), 35_000);
  try {
    for (;;) {
      const context = createTrafficReadContext(signal);
      context.indexes = indexes;
      context.expectedSnapshotIdentity = expectedSnapshotIdentity;
      context.interactionSnapshot = interactionSnapshot;
      await readDumpSessionPath(path, context);
      const current = context.directories.get(path);
      if (`${current.dev}:${current.ino}` !== target.identity) {
        throw new Error(`模型调用批次目录已被替换：${target.label}/${target.session}`);
      }
      if (labelOf(path, context) !== target.label || writerSessionOf(path, context) !== target.session) {
        throw new Error(`模型调用批次的 manifest 身份已变化：${target.label}/${target.session}`);
      }
      try {
        const result = await read(context);
        if (!context.diagnosticsPending) {
          if (context.indexPending && !options.follow && !reportedPending) {
            console.error("当前按已完成的索引水位输出，仍有追加记录待索引；可稍后重读或使用 --follow。");
            reportedPending = true;
          }
          return result;
        }
      } catch (error) {
        if (error.code !== "traffic_index_building") throw error;
      }
      await delay(100, undefined, { signal });
    }
  } catch (error) {
    if (timeout.signal.aborted && !controller.signal.aborted) {
      throw new Error(`调用索引或诊断在 35 秒内仍未完成：${target.label}/${target.session}，请稍后重试`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withSnapshot(path, expectedSnapshotIdentity, visit) {
  const snapshot = await readSession(path, context => acquireDumpSnapshot([path], context), expectedSnapshotIdentity);
  interactionSnapshot = snapshot ?? undefined;
  try { return await visit(snapshot === null); }
  finally {
    interactionSnapshot = undefined;
    snapshot?.release();
  }
}

function summaryPage(path, offset) {
  return readPage(path, (context, limit) => summarizeDumpFiles([path], { offset, limit, context }));
}

async function readPage(path, read) {
  let limit = pageLimits.get(path) ?? pageSize;
  for (;;) {
    try { return await readSession(path, context => read(context, limit)); }
    catch (error) {
      if (error.code !== "traffic_read_limit" || limit === 1) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
      pageLimits.set(path, limit);
      console.error(`摘要页超过读取预算，缩小为最多 ${limit} 条后重试。`);
    }
  }
}

async function renderSessions(paths) {
  if (paths.length === 0) {
    console.error(`没有找到转储 session：${directory}`);
    process.exitCode = 1;
    return;
  }
  if (paths.length > 1) {
    console.error("一次只能读取一个 V2 session 目录");
    process.exitCode = 1;
    return;
  }
  const invalid = paths.filter((path) => !statSync(path, { throwIfNoEntry: false })?.isDirectory());
  if (invalid.length > 0) {
    console.error(`V2 转储参数必须是 session 目录：${invalid.join("、")}`);
    process.exitCode = 1;
    return;
  }
  return options.exchange === undefined
    ? withSnapshot(paths[0], undefined, empty => renderSessionSnapshot(paths, empty))
    : renderSessionSnapshot(paths);
}

async function renderSessionSnapshot(paths, empty = false) {
  if (options.exchange !== undefined) {
    const detail = await readSession(paths[0], context => options.list
      ? summarizeDumpExchange(paths, options.exchange, context)
      : describeDumpExchange(paths, options.exchange, { maxSectionBytes: options.maxBytes ?? Number.MAX_SAFE_INTEGER, context }));
    if (detail === null) throw new Error(`没有找到模型调用 #${options.exchange}`);
    console.log(`\n### ${paths[0]}（模型调用 #${options.exchange}）`);
    console.log(`时区：${formatLocalTimeZone()}`);
    const rendered = options.list ? summaryLine(detail) : renderDetail(detail);
    if (options.grep === undefined || rendered.includes(options.grep)) console.log(rendered);
    return;
  }
  let page = empty ? { exchanges: [], total: 0, nextOffset: null } : await summaryPage(paths[0], 0);
  console.log(`\n### ${paths.join("\n### ")}（${page.total} 次模型调用）`);
  console.log(`时区：${formatLocalTimeZone()}`);
  const details = !options.list && (options.all || options.exchange !== undefined);
  for (;;) {
    for (const summary of page.exchanges) {
      const rendered = await renderExchange(paths, summary, details);
      if (rendered !== undefined) console.log(rendered);
    }
    if (page.nextOffset === null) break;
    page = await summaryPage(paths[0], page.nextOffset);
  }
}

async function renderExchange(
  paths,
  summary,
  details = !options.list && (options.all || options.exchange !== undefined),
  expectedSnapshotIdentity,
) {
  if (options.exchange !== undefined && summary.id !== options.exchange) return undefined;
  let rendered = summaryLine(summary);
  if (details) {
    const detail = await readSession(paths[0], context => describeDumpExchange(paths, summary.id, {
      maxSectionBytes: options.maxBytes ?? Number.MAX_SAFE_INTEGER,
      context,
    }), expectedSnapshotIdentity);
    if (detail === null) return undefined;
    rendered = renderDetail(detail);
  }
  return options.grep === undefined || rendered.includes(options.grep)
    ? rendered
    : undefined;
}

function summaryLine(summary) {
  const target = summary.transport === "websocket"
    ? `WebSocket ${summary.url ?? ""}`
    : `${summary.method ?? "HTTP"} ${summary.path ?? ""}`.trim();
  return [
    `#${summary.id}`,
    formatTime(summary.startedAtMs),
    target,
    `线程=${shortId(summary.threadId)}`,
    `轮次=${shortId(summary.turnId)}`,
    `模型=${summary.requestModel ?? "-"}→${summary.responseModels.join("、") || "-"}`,
    `上游=${summary.upstreamProvider ?? "-"}`,
    `类型=${summary.category === "models" ? "模型列表" : summary.category === "prewarm" ? "连接预热" : summary.requestKind ?? "模型请求"}`,
    `结果=${stateLabel(summary.state)}`,
  ].join("  ");
}

function renderDetail(detail) {
  const requestTarget = detail.transport === "websocket"
    ? `WebSocket ${detail.request.url ?? detail.url ?? ""}`
    : `${detail.request.method ?? "HTTP"} ${detail.request.path ?? ""}`.trim();
  const lines = [
    "",
    `#${detail.id} ${formatTime(detail.startedAtMs)} ${requestTarget}`,
    `线程：${detail.threadId ?? "未提供"}  轮次：${detail.turnId ?? "未提供"}  类型：${detail.requestKind ?? "未提供"}`,
    `模型：${detail.requestModel ?? "未提供"} → ${detail.responseModels.join("、") || "未提供"}`,
    `上游提供商：${detail.upstreamProvider ?? "未记录"}`,
    `模型对照：${modelNameComparison(detail.requestModel, detail.responseModels.length === 1 ? detail.responseModels[0] : undefined)}（仅比较名称，不验证模型身份）`,
  ];
  if (detail.diagnosticsComplete === false) lines.push("（诊断读取未完成：输出或模型声明可能不完整，不能据此认定未发生）");
  for (const [label, entries] of [["服务端模型声明", detail.modelEvidence.serverModels], ["安全缓冲候选声明", detail.modelEvidence.safetyModels]]) {
    lines.push(`${label}：${entries.length === 0 ? "未记录" : entries.map((entry) => `${entry.model}（来源：${entry.source}）`).join("；")}`);
  }
  lines.push("安全缓冲候选不表示已经切换，也不表示由该模型执行安全检查；缺失仅表示保留转储中未记录。");
  lines.push(`X-Codex-Turn-State 字符数：${detail.modelEvidence.turnStateLengths.length === 0 ? "未记录" : detail.modelEvidence.turnStateLengths.map((entry) => `${entry.characters} 字符（来源：${entry.source}）`).join("；")}`);
  if (detail.modelEvidence.truncated) lines.push("（模型声明展示不完整：超过条数或字段长度限制，或含无效字符）");
  if (detail.account !== undefined) lines.push(`账户：${detail.account}`);
  lines.push("", "请求头：", ...headerLines(detail.request.headers));
  lines.push("", "请求：", indent(pretty(detail.request.body)));
  if (detail.request.bodyTruncated) lines.push("（请求正文展示已截断）");
  const parameters = detail.request.parameters;
  lines.push(`思考等级：${parameters.reasoningEffort ?? "未提供"} · 请求服务层级：${parameters.serviceTier ?? "未提供"}`);
  if (parameters.previousResponseId !== undefined) lines.push(`接续响应：${parameters.previousResponseId}`);
  if (detail.response === null) {
    lines.push("", "响应：未记录终态");
  } else {
    lines.push("", `响应：${stateLabel(detail.response.state)}`
      + (detail.response.status === null ? "" : ` HTTP ${detail.response.status}`));
    lines.push(`首 Token：${detail.response.firstTokenMs === undefined ? "未提供" : formatElapsedDuration(detail.response.firstTokenMs)}`);
    lines.push(`生成速度：${formatGenerationSpeed({ ...detail.response, status: detail.response?.state, totalDurationMs: detail.response?.durationMs })}`);
    if (detail.response.failureStage !== undefined) lines.push(`失败阶段：${formatFailureStage(detail.response.failureStage)}`);
    if (detail.response.websocketClose !== undefined) lines.push(`客户端 WebSocket 关闭码：${detail.response.websocketClose.code}`);
    if (detail.continuation !== undefined) {
      const next = detail.continuation.next;
      lines.push(detail.continuation.complete === false ? "同轮后续调用：关联读取未完成，不能判定是否存在"
        : next === null ? "同轮后续调用：当前批次尚未观察到"
        : `同轮后续调用：#${next.id} · ${stateLabel(next.state)} · 断开后 ${formatElapsedDuration(next.gapMs)}`);
      if (next?.agentMessageObserved) lines.push("后续请求保留输入中含代理消息；不证明消息为新增或触发了本次断开。");
      lines.push("关联仅限当前批次的相同原始 Thread/Turn；后续状态不改变本次响应状态，也不代表整轮任务结果。");
    }
    lines.push(...headerLines(detail.response.headers), "", "终态正文：", indent(pretty(detail.response.body)));
    if (detail.response.bodyTruncated) lines.push("（终态正文展示已截断）");
    const usage = detail.response.usage;
    if (usage !== null) lines.push(`Token：输入 ${usage.inputTokens ?? "—"} · 缓存 ${usage.cachedTokens ?? "—"} · 输出 ${usage.outputTokens ?? "—"} · 其中推理 ${usage.reasoningTokens ?? "—"}`);
    for (const item of detail.response.output) {
      lines.push("", `输出 ${item.type}${item.name === undefined ? "" : ` · ${item.name}`}：`, indent(item.text));
    }
    if (detail.response.outputTruncated) lines.push("（输出展示不完整：超出上限或传输记录残缺、无法解析）");
    if (detail.response.errorScope !== undefined) {
      lines.push(`${detail.response.state === "completed" ? "完成后的诊断" : "错误"}：${detail.response.errorScope}`
        + (detail.response.error === undefined ? "" : ` ${detail.response.error}`));
    }
  }
  return lines.join("\n");
}

function stateLabel(state) {
  if (state === "completed") return "完成";
  if (state === "failed") return "失败";
  if (state === "incomplete") return "不完整";
  return "未记录终态";
}

function pretty(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function indent(text) {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function headerLines(headers) {
  return Object.entries(headers ?? {}).map(([name, value]) => (
    `  ${name}: ${Array.isArray(value) ? value.join(", ") : String(value)}`
  ));
}

function formatTime(atMs) {
  return Number.isFinite(atMs) ? formatLocalTime(atMs) : "-";
}
