#!/usr/bin/env node

import { statSync } from "node:fs";
import { join } from "node:path";

import { locateOptionalUserConfig, userDataDir } from "./runtime-config.mjs";
import { parseTrafficCommandArgs } from "./traffic-command-options.mjs";
import {
  describeDumpExchange,
  dumpCatalog,
  formatTime,
  labelOf,
  listDumpFiles,
  selectFilesOfLabel,
  shortId,
  summarizeDumpFiles,
} from "./traffic-dump-reader.mjs";

const followIntervalMs = 1_000;
const options = parseTrafficCommandArgs(process.argv.slice(2));
const directory = options.directory ?? defaultTrafficDirectory();

try {
  if (options.follow) await followTraffic();
  else await renderSessions(selectedSessions());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
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
  return selectFilesOfLabel(sessions, labelOf(newest));
}

async function followTraffic() {
  if (options.files.length > 1) throw new Error("一次只能跟随一个 V2 session 目录");
  const initial = selectedSessions();
  let session = initial[0];
  let displayed = new Set();
  if (session !== undefined && options.files.length === 0) {
    const page = await summarizeDumpFiles(initial);
    displayed = new Set(page.exchanges
      .filter((summary) => summary.state !== "pending")
      .map((summary) => summary.id));
  }
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`跟随 ${directory} 中的新模型调用，按 Ctrl-C 停止`);
  while (!stopped) {
    const selected = selectedSessions();
    const current = selected[0];
    if (current !== undefined) {
      if (current !== session) {
        session = current;
        displayed = new Set();
      }
      const page = await summarizeDumpFiles(selected);
      for (const summary of page.exchanges) {
        if (summary.state === "pending" || displayed.has(summary.id)) continue;
        displayed.add(summary.id);
        const rendered = await renderExchange(selected, summary);
        if (rendered !== undefined) console.log(rendered);
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, followIntervalMs));
  }
}

async function renderSessions(paths) {
  if (paths.length === 0) {
    const catalog = dumpCatalog(directory);
    console.error(catalog.legacyFiles.length > 0
      ? "只找到旧版逐帧 JSONL；请重启 App Server 生成 V2 转储，旧文件不会自动迁移"
      : `没有找到转储 session：${directory}`);
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
  const page = await summarizeDumpFiles(paths);
  if (options.exchange !== undefined
    && !page.exchanges.some((entry) => entry.id === options.exchange)) {
    console.error(`没有找到模型调用 #${options.exchange}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n### ${paths.join("\n### ")}（${page.total} 次模型调用）`);
  const details = !options.list && (options.all || options.exchange !== undefined);
  for (const summary of page.exchanges) {
    const rendered = await renderExchange(paths, summary, details);
    if (rendered !== undefined) console.log(rendered);
  }
}

async function renderExchange(
  paths,
  summary,
  details = !options.list && (options.all || options.exchange !== undefined),
) {
  if (options.exchange !== undefined && summary.id !== options.exchange) return undefined;
  let rendered = summaryLine(summary);
  if (details) {
    const detail = await describeDumpExchange(paths, summary.id, {
      maxSectionBytes: options.maxBytes ?? Number.MAX_SAFE_INTEGER,
    });
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
  ];
  if (detail.account !== undefined) lines.push(`账户：${detail.account}`);
  lines.push("", "请求头：", ...headerLines(detail.request.headers));
  lines.push("", "请求：", indent(pretty(detail.request.body)));
  if (detail.response === null) {
    lines.push("", "响应：等待终态");
  } else {
    lines.push("", `响应：${stateLabel(detail.response.state)}`
      + (detail.response.status === null ? "" : ` HTTP ${detail.response.status}`)
      + (detail.response.durationMs === undefined ? "" : ` ${detail.response.durationMs} ms`));
    lines.push(...headerLines(detail.response.headers), "", "终态正文：", indent(pretty(detail.response.body)));
    if (detail.response.errorScope !== undefined) {
      lines.push(`错误：${detail.response.errorScope}`
        + (detail.response.error === undefined ? "" : ` ${detail.response.error}`));
    }
  }
  return lines.join("\n");
}

function stateLabel(state) {
  if (state === "completed") return "完成";
  if (state === "failed") return "失败";
  if (state === "incomplete") return "不完整";
  return "进行中";
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
