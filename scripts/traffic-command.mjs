#!/usr/bin/env node

import { statSync } from "node:fs";
import { join } from "node:path";
import { modelNameComparison } from "../runtime/model-name-comparison.mjs";

import { locateOptionalUserConfig, userDataDir } from "./runtime-config.mjs";
import { parseTrafficCommandArgs } from "./traffic-command-options.mjs";
import { formatElapsedDuration } from "./metrics-export-format.mjs";
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
  return selectFilesOfLabel(sessions, labelOf(newest)).slice(-1);
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
    `模型对照：${modelNameComparison(detail.requestModel, detail.responseModels.length === 1 ? detail.responseModels[0] : undefined)}（仅比较名称，不验证模型身份）`,
  ];
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
    lines.push("", "响应：等待终态");
  } else {
    lines.push("", `响应：${stateLabel(detail.response.state)}`
      + (detail.response.status === null ? "" : ` HTTP ${detail.response.status}`)
      + (detail.response.durationMs === undefined ? "" : ` 原始记录耗时（墙钟）=${formatElapsedDuration(detail.response.durationMs)}`));
    lines.push(`单请求首字耗时：${detail.response.firstContentMs === undefined ? "未采集" : formatElapsedDuration(detail.response.firstContentMs)}`);
    const call = detail.response.callTiming;
    lines.push("本次调用（单调时钟）：");
    if (call === null) lines.push("  未记录阶段，不从历史记录补算；上方为原始记录的墙钟耗时。");
    else {
      const stages = [
        ["总耗时", call.totalMs], ["转发前准备", call.preForwardMs],
        ["转发至首字事件", call.firstEventWaitMs], ["首字事件至结束", call.afterFirstEventMs],
        ...(detail.response.httpTiming === null ? [
          ["转发开始至提交发送", call.submitWaitMs], ["提交发送至首字事件", call.submittedToFirstEventMs],
        ] : [
          ["入口至收齐请求体", call.receiveRequestMs], ["收齐请求体至响应头", call.waitResponseHeadMs], ["响应头至结束", call.receiveResponseMs],
        ]),
      ];
      for (const [label, value] of stages) lines.push(`  ${label}：${value === undefined ? "未记录" : formatElapsedDuration(value)}`);
      if (call.connectionReady !== undefined) lines.push(`  进入转发时连接${call.connectionReady ? "已就绪" : "尚未就绪"}；提交发送不表示上游已经收到。`);
    }
    lines.push("首字后包含生成、传输和背压暂停；HTTP 阶段可重叠，不能重复相加。失败记录的结束表示本地观察到中断。", "上游轮次统计（独立口径）：");
    lines.push(`上游轮次首 Token：${detail.response.timing?.firstTokenMs === undefined ? "未提供" : formatElapsedDuration(detail.response.timing.firstTokenMs)}`);
    for (const [label, key] of [["最大排队", "queueMaxMs"], ["轮次累计生成", "samplingMs"], ["logical turn", "totalMs"], ["客户端工具暂停", "toolPauseMs"]]) {
      const value = detail.response.timing?.[key];
      lines.push(`  ${label}：${value === undefined ? "未提供" : formatElapsedDuration(value)}`);
    }
    if (detail.response.failureStage !== undefined) lines.push(`失败阶段：${detail.response.failureStage}`);
    lines.push(...headerLines(detail.response.headers), "", "终态正文：", indent(pretty(detail.response.body)));
    if (detail.response.bodyTruncated) lines.push("（终态正文展示已截断）");
    const usage = detail.response.usage;
    if (usage !== null) lines.push(`Token：输入 ${usage.inputTokens ?? "—"} · 缓存 ${usage.cachedTokens ?? "—"} · 输出 ${usage.outputTokens ?? "—"} · 其中推理 ${usage.reasoningTokens ?? "—"}`);
    for (const item of detail.response.output) {
      lines.push("", `输出 ${item.type}${item.name === undefined ? "" : ` · ${item.name}`}：`, indent(item.text));
    }
    if (detail.response.outputTruncated) lines.push("（输出展示不完整：超出上限或传输记录残缺、无法解析）");
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
