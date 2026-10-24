import { formatGenerationSpeed, generationSpeed } from "../runtime/request-timing.mjs";
import {
  csvCell,
  formatElapsedDuration,
  formatLocalTime,
  formatLocalTimeZone,
  formatRequestCount,
  formatTokenCount,
  formatObservedTotal as formatUsageTotal,
  markdownCell,
} from "./metrics-export-format.mjs";

export function printStatus(result, { json = false, output = process.stdout } = {}) {
  if (json) {
    output.write(`${JSON.stringify({
      databasePath: result.databasePath,
      exists: result.exists,
      schemaVersion: result.schemaVersion,
      compatible: result.compatible,
      count: result.count,
    }, null, 2)}\n`);
    return;
  }
  console.log(`指标数据库：${result.databasePath}`);
  if (!result.exists) {
    console.log("状态：尚未创建");
    return;
  }
  console.log(`Schema：${result.schemaVersion ?? "无法识别"}`);
  console.log(`兼容：${result.compatible ? "是" : "否"}`);
  if (result.count == null) console.log("记录：无法读取");
  else if (result.count > 0) console.log(`记录：${formatRequestCount(result.count)}`);
  if (!result.compatible) {
    console.log("处理：请核对数据库版本及备份；不支持的 Schema 不会被清理或重置。");
  }
}

export function printQuotaHistory(result, format = "markdown") {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (format === "csv") {
    const columns = ["provider", "windowId", "periodStartAtMs", "periodEndAtMs", "resetsAt", "firstObservedAtMs", "lastObservedAtMs", "snapshotCount", "requestCount", "unsuccessfulRequestCount", "inputTokens", "outputTokens", "totalTokens", "latestUsedPercentMillionths", "planType"];
    console.log(columns.join(","));
    for (const period of result.periods) console.log(columns.map((column) => csvCell(period[column])).join(","));
    return;
  }
  console.log(`额度历史（${result.range.name}）`);
  console.log(`时区：${formatLocalTimeZone()}`);
  if (result.periods.length === 0) {
    console.log("暂无已记录的额度周期快照。");
    return;
  }
  for (const period of result.periods) {
    const start = period.periodStartAtMs === null ? "未知" : formatLocalTime(period.periodStartAtMs);
    const reset = formatLocalTime(period.periodEndAtMs);
    const used = !(period.latestUsedPercentMillionths > 0)
      ? ""
      : `${(period.latestUsedPercentMillionths / 1_000_000).toFixed(2)}%`;
    console.log(`- ${[
      period.provider, period.windowId, `周期 ${start} ～ ${reset}`,
      ...(used ? [`最新使用 ${used}`] : []),
      ...(period.requestCount > 0 ? [`请求 ${formatRequestCount(period.requestCount)}`] : []),
      ...(period.totalTokens > 0 ? [`Token ${formatTokenCount(period.totalTokens)}`] : []),
    ].join(" · ")}`);
  }
}

export function printMetricsReport(result, format) {
  const aggregateProvider = singleReportProvider(result.report);
  if (format === "json") {
    console.log(JSON.stringify({
      ...result,
      report: {
        ...result.report,
      },
    }, null, 2));
    return;
  }
  if (format === "csv") {
    const columns = [
      ["type", (row) => row.type],
      ["provider", (row) => row.provider],
      ["model", (row) => row.model],
      ["group", (row) => row.group],
      ["status", (row) => row.status],
      ["errorType", (row) => row.errorType],
      ["errorCode", (row) => row.errorCode],
      ["source", (row) => row.source],
      ["lastErrorMessage", (row) => row.lastErrorMessage],
      ["httpStatus", (row) => row.httpStatus],
      ["lastOccurredAtMs", (row) => row.lastOccurredAtMs],
      ["requestCount", (row) => row.requestCount],
      ["unsuccessfulRequestCount", (row) => row.unsuccessfulRequestCount],
      ...outcomeCsvColumns(),
      ["inputTokens", (row) => row.inputTokens],
      ["cachedInputTokens", (row) => row.cachedInputTokens],
      ["outputTokens", (row) => row.outputTokens],
      ["reasoningOutputTokens", (row) => row.reasoningOutputTokens],
      ...usageCoverageCsvColumns(),
      ...reviewUsageCsvColumns(),
      ...compactCsvColumns(),
      ...weeklyQuotaCsvColumns(),
    ];
    console.log(columns.map(([heading]) => csvCell(heading)).join(","));
    const rows = [
      ...(result.report.aggregate === null
        ? []
        : [{
            type: "aggregate",
            provider: aggregateProvider,
            model: null,
            group: "global",
            ...result.report.aggregate,
          }]),
      ...result.report.groups.map((group) => ({
        type: "group",
        provider: group.provider,
        model: group.model,
        group: group.model ?? group.provider ?? "全部",
        ...group.aggregate,
      })),
      {
        type: "error_summary",
        provider: null,
        model: null,
        group: "global",
        requestCount: result.errors.requestCount,
        unsuccessfulRequestCount: result.errors.unsuccessfulRequestCount,
        requestOutcomes: result.errors.requestOutcomes,
      },
      ...result.errors.groups.map((group) => ({
        type: "error",
        provider: group.provider,
        model: group.model,
        group: group.model ?? group.provider ?? "全部",
        status: group.status,
        errorType: group.errorType,
        errorCode: group.errorCode,
        source: group.source,
        lastErrorMessage: group.lastErrorMessage,
        httpStatus: group.httpStatus,
        lastOccurredAtMs: group.lastOccurredAtMs,
        requestCount: group.requestCount,
      })),
      ...(result.weeklyQuota === null
        ? []
        : [{ type: "weekly_quota", ...flattenWeeklyQuota(result.weeklyQuota) }]),
    ];
    for (const row of rows) {
      console.log(
        columns.map(([, read]) => csvCell(read(row))).join(","),
      );
    }
    return;
  }
  const aggregate = result.report.aggregate;
  console.log("# Codex Connect 请求指标报告");
  console.log("");
  console.log(`- 时区：${formatLocalTimeZone()}`);
  console.log(`- 生成时间：${formatLocalTime(Date.parse(result.generatedAt))}`);
  console.log(`- 时间范围：${result.range.name}`);
  console.log(`- 起始时间：${formatLocalTime(result.range.startAtMs)}`);
  console.log(`- 截止时间：${formatLocalTime(result.range.endAtMs)}`);
  printUsageNote();
  printWeeklyQuotaMarkdown(result.weeklyQuota);
  console.log("");
  console.log("## 汇总");
  console.log("");
  if (!aggregate) {
    console.log("本时间范围没有请求记录。");
    return;
  }
  printMetric("模型请求", formatPositiveCount(aggregate.requestCount));
  const outcomes = formatRequestOutcomes(aggregate.requestOutcomes);
  if (outcomes) console.log(`- ${outcomes}`);
  printMetric("总 Token", formatPositiveUsageTotal(aggregate));
  printMetric("输入 Token", formatUsageField(aggregate, "input"));
  printMetric("其中缓存", formatObservedTokens(aggregate.cachedInputTokens));
  printMetric("输出 Token", formatUsageField(aggregate, "output"));
  printMetric("其中推理输出 Token", formatUsageField(aggregate, "reasoning"));
  printMetric("其中自动审批审查", formatReviewUsage(aggregate.reviewUsage));
  printCompactSummary(aggregate.compact);
  if (result.report.groups.length > 0) {
    console.log("");
    console.log("## 明细");
    console.log("");
    console.log("| 提供商 | 模型 | 请求 | 请求结果 | 输入 | 其中缓存 | 输出 | 其中自动审批审查 | 其中上下文压缩 |");
    console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |");
    for (const group of result.report.groups) {
      const value = group.aggregate;
      console.log(`| ${markdownCell(group.provider ?? "全部")} | ${markdownCell(group.model ?? "全部/未观测")} | ${formatPositiveCount(value.requestCount)} | ${formatRequestOutcomes(value.requestOutcomes)} | ${formatUsageField(value, "input")} | ${formatObservedTokens(value.cachedInputTokens)} | ${formatUsageField(value, "output")} | ${markdownCell(formatReviewUsage(value.reviewUsage))} | ${markdownCell(formatCompactSummary(value.compact) ?? "")} |`);
    }
    const hidden = result.report.totalGroupCount - result.report.groups.length;
    if (hidden > 0) console.log(`\n仅显示请求量最高的 ${result.report.groups.length} 组，另有 ${hidden} 组。`);
  }
  console.log("");
  console.log("## 中断、失败与未完整观测");
  console.log("");
  if (result.errors.groups.length === 0) {
    console.log("本时间范围没有中断、失败或未完整观测请求。");
    return;
  }
  console.log("| 来源 | 提供商 | 模型 | 状态 | 类型 | 错误码 | HTTP | 次数 |");
  console.log("| --- | --- | --- | --- | --- | --- | ---: | ---: |");
  for (const group of result.errors.groups) {
    console.log(`| ${markdownCell(group.source)} | ${markdownCell(group.provider)} | ${markdownCell(group.model ?? "未观测")} | ${formatRequestStatus(group)} | ${markdownCell(group.errorType ?? "未提供")} | ${markdownCell(group.errorCode ?? "未提供")} | ${group.httpStatus ?? ""} | ${formatPositiveCount(group.requestCount)} |`);
  }
}

function singleReportProvider(report) {
  if (report.totalGroupCount !== report.groups.length) return null;
  const providers = new Set(
    report.groups
      .map((group) => group.provider)
      .filter((provider) => provider != null),
  );
  return providers.size === 1 ? providers.values().next().value : null;
}

export function* renderMetricsExport(frames, format) {
  const iterator = frames[Symbol.iterator]();
  try {
    const header = iterator.next();
    if (header.done || header.value.type !== "header") throw new Error("指标导出元数据缺失");
    yield* renderMetricsExportBody(iterator, header.value.value, format);
  } finally {
    iterator.return?.();
  }
}

function* renderMetricsExportBody(iterator, result, format) {
  if (format === "json") {
    const metadata = JSON.stringify(result);
    yield `${metadata.slice(0, -1)},"records":[`;
    let separator = "";
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      yield `${separator}${JSON.stringify(next.value.value)}`;
      separator = ",";
    }
    yield "]}\n";
    return;
  }
  if (format === "markdown") {
    yield `# Codex Connect 请求明细\n\n- 时区：${formatLocalTimeZone()}\n- 生成时间：${formatLocalTime(Date.parse(result.generatedAt))}\n- 时间范围：${result.range.name}\n\n${usageNote}\n`;
    if (result.aggregate !== null) {
      for (const [label, value] of [
        ["模型请求", formatPositiveCount(result.aggregate.requestCount)],
        ["总 Token", formatPositiveUsageTotal(result.aggregate)],
        ["其中自动审批审查", formatReviewUsage(result.aggregate.reviewUsage)],
      ]) {
        if (value) yield `\n- ${label}：${value}\n`;
      }
    }
    yield* weeklyQuotaMarkdownLines(result.weeklyQuota);
    const first = iterator.next();
    if (first.done) {
      yield "\n本时间范围没有请求记录。\n";
      return;
    }
    yield "\n| 时间 | 提供商 | 上游地址 | 模型 | 操作 | 用途 | 思考等级 | 状态 | 输入 | 其中缓存 | 输出 | 首 Token | 速度 | 请求模型 | 响应回显 | 转储定位 | 来源 | 调用方 | 交付 |\n";
    yield "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n";
    for (let next = first; !next.done; next = iterator.next()) {
      const record = next.value.value;
      yield (
        [
          markdownCell(formatLocalTime(record.recordedAtMs)),
          markdownCell(record.provider ?? ""),
          markdownCell(record.upstreamUrl ?? "未知"),
          markdownCell(record.model ?? ""),
          markdownCell(record.operation),
          markdownCell(record.requestPurpose === "autoApprovalReview" ? "自动审批审查" : "未标记（含历史未知）"),
          markdownCell(record.reasoningEffort ?? "未观测"),
          markdownCell(formatRequestStatus(record)),
          markdownCell(formatObservedTokens(record.inputTokens)),
          markdownCell(formatObservedTokens(record.cachedInputTokens)),
          markdownCell(formatObservedTokens(record.outputTokens)),
          markdownCell(record.firstTokenMs > 0 ? formatElapsedDuration(record.firstTokenMs) : ""),
          markdownCell(generationSpeed(record) > 0 ? formatGenerationSpeed(record) : ""),
          markdownCell(record.requestModel ?? "未知"),
          markdownCell(record.responseModel ?? "未回显"),
          markdownCell(record.traffic == null ? "未关联"
            : `${record.traffic.label} / ${record.traffic.session} / #${record.traffic.interaction}`),
          markdownCell(record.source), markdownCell(record.callerId), markdownCell(record.deliveryStatus),
        ].join(" | ") + "\n"
      );
    }
    return;
  }
  const columns = [
    ["type", (row) => row.type],
    ...csvColumns(),
    ...weeklyQuotaCsvColumns(),
  ];
  yield columns.map(([heading]) => csvCell(heading)).join(",") + "\n";
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const record = next.value.value;
    const row = { type: "request", ...record, ...flattenRecordedWeeklyQuota(record) };
    yield columns.map(([, read]) => csvCell(read(row))).join(",") + "\n";
  }
  if (result.weeklyQuota !== null) {
    const row = { type: "weekly_quota_summary", ...flattenWeeklyQuota(result.weeklyQuota) };
    yield columns.map(([, read]) => csvCell(read(row))).join(",") + "\n";
  }
}

function printWeeklyQuotaMarkdown(quota) {
  for (const line of weeklyQuotaMarkdownLines(quota)) process.stdout.write(line);
}

function* weeklyQuotaMarkdownLines(quota) {
  if (quota === null) return;
  yield "\n## 当前周额度区间\n\n";
  if (quota.usedPercent > 0) yield `- 已用：${quota.usedPercent}%\n`;
  if (quota.remainingPercent > 0) yield `- 剩余：${quota.remainingPercent}%\n`;
  yield `- 重置时间：${formatLocalTime(quota.resetsAt * 1_000)}\n- 观测时间：${formatLocalTime(quota.observedAtMs)}\n`;
  if (quota.estimate === null) return;
  if (quota.estimate.observedDeltaPercent > 0) {
    const intervals = quota.estimate.intervalCount > 0 ? `（${quota.estimate.intervalCount} 个区间）` : "";
    yield `- 观测变化：${quota.estimate.observedDeltaPercent}%${intervals}\n`;
  }
  if (quota.estimate.totalTokensPerPercent > 0) yield `- 每 1%：约 ${quota.estimate.totalTokensPerPercent} Token\n`;
}

function flattenWeeklyQuota(quota) {
  if (quota === null) return {};
  return {
    weeklyQuotaLimitId: quota.limitId,
    weeklyQuotaPlanType: quota.planType,
    weeklyQuotaUsedPercent: quota.usedPercent,
    weeklyQuotaRemainingPercent: quota.remainingPercent,
    weeklyQuotaResetsAt: quota.resetsAt,
    weeklyQuotaObservedAtMs: quota.observedAtMs,
    weeklyQuotaObservedDeltaPercent: quota.estimate?.observedDeltaPercent,
    weeklyQuotaIntervalCount: quota.estimate?.intervalCount,
    weeklyQuotaRequestCount: quota.estimate?.requestCount,
    weeklyQuotaTotalTokensPerPercent: quota.estimate?.totalTokensPerPercent,
  };
}

function flattenRecordedWeeklyQuota(record) {
  const quota = record.weeklyQuota;
  if (quota === null) return {};
  const usedPercent = quota.usedPercentMillionths / 1_000_000;
  return {
    weeklyQuotaLimitId: quota.limitId,
    weeklyQuotaPlanType: quota.planType,
    weeklyQuotaUsedPercent: usedPercent,
    weeklyQuotaRemainingPercent: Math.max(0, 100 - usedPercent),
    weeklyQuotaResetsAt: quota.resetsAt,
    weeklyQuotaObservedAtMs: record.quotaObservedAtMs ?? record.recordedAtMs,
  };
}

function weeklyQuotaCsvColumns() {
  return [
    ["weeklyQuotaLimitId", (row) => row.weeklyQuotaLimitId],
    ["weeklyQuotaPlanType", (row) => row.weeklyQuotaPlanType],
    ["weeklyQuotaUsedPercent", (row) => row.weeklyQuotaUsedPercent],
    ["weeklyQuotaRemainingPercent", (row) => row.weeklyQuotaRemainingPercent],
    ["weeklyQuotaResetsAt", (row) => row.weeklyQuotaResetsAt],
    ["weeklyQuotaObservedAtMs", (row) => row.weeklyQuotaObservedAtMs],
    ["weeklyQuotaObservedDeltaPercent", (row) => row.weeklyQuotaObservedDeltaPercent],
    ["weeklyQuotaIntervalCount", (row) => row.weeklyQuotaIntervalCount],
    ["weeklyQuotaRequestCount", (row) => row.weeklyQuotaRequestCount],
    ["weeklyQuotaTotalTokensPerPercent", (row) => row.weeklyQuotaTotalTokensPerPercent],
  ];
}

function compactCsvColumns() {
  return [
    ["compactModel", (row) => row.compact?.model],
    ["compactHasMixedModels", (row) => row.compact?.hasMixedModels],
    ["compactRequestCount", (row) => row.compact?.requestCount],
    ["compactUnsuccessfulRequestCount", (row) =>
      row.compact?.unsuccessfulRequestCount],
    ...outcomeCsvColumns("compact", (row) => row.compact?.requestOutcomes),
    ["compactInputTokens", (row) => row.compact?.inputTokens],
    ["compactCachedInputTokens", (row) => row.compact?.cachedInputTokens],
    ["compactOutputTokens", (row) => row.compact?.outputTokens],
    ...usageCoverageCsvColumns("compact.", (row) => row.compact),
  ];
}

function usageCoverageCsvColumns(prefix = "", read = (row) => row) {
  return ["inputMissingRequestCount", "outputMissingRequestCount", "reasoningMissingRequestCount"].map((key) => [
    `${prefix}usageCoverage.${key}`, (row) => read(row)?.usageCoverage?.[key],
  ]);
}

function reviewUsageCsvColumns() {
  return [
    ...["requestCount", "inputTokens", "outputTokens"].map((key) => [
      `reviewUsage.${key}`, (row) => row.reviewUsage?.[key],
    ]),
    ...usageCoverageCsvColumns("reviewUsage.", (row) => row.reviewUsage),
  ];
}

const usageNote = "Token 总量为已记录的输入加输出；缓存已包含在输入中，推理已包含在输出中，压缩与自动审批审查均为其中项。历史数据可能包含旧版本合成的 Turn 错误记录，保留原样且不推断用途。";

function printUsageNote() {
  console.log(`\n${usageNote}`);
}

function formatObservedTokens(value) {
  return value > 0 ? formatTokenCount(value) : "";
}

function formatPositiveCount(value) {
  return value > 0 ? formatRequestCount(value) : "";
}

function formatPositiveUsageTotal(summary) {
  return summary.inputTokens + summary.outputTokens > 0 ? formatUsageTotal(summary) : "";
}

function printMetric(label, value, indent = "") {
  if (value) console.log(`${indent}- ${label}：${value}`);
}

function formatUsageField(summary, field) {
  const value = summary[field === "reasoning" ? "reasoningOutputTokens" : `${field}Tokens`];
  return formatObservedTokens(value);
}

function formatReviewUsage(summary) {
  if (summary == null) return "";
  return [
    ...(summary.requestCount > 0 ? [`${formatRequestCount(summary.requestCount)} 次`] : []),
    ...(summary.inputTokens > 0 ? [`输入 ${formatUsageField(summary, "input")}`] : []),
    ...(summary.outputTokens > 0 ? [`输出 ${formatUsageField(summary, "output")}`] : []),
    ...(summary.inputTokens + summary.outputTokens > 0 ? [`总 Token ${formatUsageTotal(summary)}`] : []),
  ].join(" · ");
}

function formatCacheRate(summary) {
  return summary.inputTokens > 0 && summary.cachedInputTokens > 0
    ? `${((summary.cachedInputTokens / summary.inputTokens) * 100).toFixed(2)}%` : "";
}

function printCompactSummary(compact) {
  const summary = formatCompactSummary(compact);
  if (summary === null) return;
  console.log(`- 其中上下文压缩：${summary}`);
}

function formatCompactSummary(compact) {
  if (compact == null || (compact.requestCount === 0 && compact.inputTokens + compact.outputTokens === 0)) return null;
  const model = compact.hasMixedModels
    ? "混合模型"
    : compact.model ?? "模型未知";
  return [
    ...(compact.requestCount > 0 ? [`${formatRequestCount(compact.requestCount)} 次`] : []),
    model,
    ...(compact.inputTokens + compact.outputTokens > 0 ? [`${formatUsageTotal(compact)} Token`] : []),
    formatRequestOutcomes(compact.requestOutcomes),
  ].filter(Boolean).join(" · ");
}

function formatRequestOutcomes(outcomes) {
  return [["完成", outcomes.completed], ["客户端中断", outcomes.interrupted], ["其他失败", outcomes.failed], ["未完整观测", outcomes.incomplete]]
    .filter(([, count]) => count > 0).map(([label, count]) => `${label}：${formatRequestCount(count)}`).join(" · ");
}

function formatRequestStatus(record) {
  if (record.status === "completed") return "完成";
  if ((record.source === "relay" ? record.errorCode : record.errorType) === "client_disconnected") return "客户端中断";
  if (record.status === "failed") return "其他失败";
  return "未完整观测";
}

function outcomeCsvColumns(prefix = "", read = (row) => row.requestOutcomes) {
  return ["completed", "interrupted", "failed", "incomplete"].map((key) => [
    `${prefix}${prefix ? "Request" : "request"}Outcomes.${key}`,
    (row) => read(row)?.[key],
  ]);
}

function interruptionCsvColumns() {
  return ["followedByCompletion", "noObservedCompletion", "usageUnobserved"].map((key) => [
    `interruptionSummary.${key}`, (row) => row.interruptionSummary?.[key],
  ]);
}

function formatInterruptionSummary(summary) {
  return [
    ...(summary.followedByCompletion > 0 ? [`同一 Turn 后续有完成 ${formatRequestCount(summary.followedByCompletion)} 次`] : []),
    ...(summary.noObservedCompletion > 0 ? [`未观测到后续完成 ${formatRequestCount(summary.noObservedCompletion)} 次`] : []),
  ].join(" · ");
}

export function printMetricsRun(result, format) {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (format === "csv") {
    const rows = [
      ...(result.latestTurn === null
        ? []
        : [{ type: "latest", ...result.latestTurn }]),
      ...(result.threadAggregate === null
        ? []
        : [{ type: "thread", ...result.threadAggregate }]),
    ];
    printTurnSummaryCsv(rows);
    return;
  }
  const { latestTurn, threadAggregate } = result;
  console.log("# Codex Connect 本次运行统计");
  console.log("");
  console.log(`- Thread：${result.threadId}`);
  console.log(`- 时区：${formatLocalTimeZone()}`);
  console.log(`- 生成时间：${formatLocalTime(Date.parse(result.generatedAt))}`);
  printUsageNote();
  for (const [title, summary] of [["最近运行聚合", latestTurn], ["当前会话指标累计", threadAggregate]]) {
    if (summary === null || !hasTurnSummary(summary)) continue;
    console.log("");
    console.log(`## ${title}`);
    console.log("");
    printTurnSummary(summary);
  }
}

function printTurnSummaryCsv(rows) {
  const columns = [
    ["type", (row) => row.type],
    ["provider", (row) => row.provider],
    ["model", (row) => row.model],
    ["reasoningEffort", (row) => row.reasoningEffort],
    ["recordedAt", (row) => row.recordedAtMs === undefined ? "" : new Date(row.recordedAtMs).toISOString()],
    ["turnId", (row) => row.turnId],
    ["requestCount", (row) => row.requestCount],
    ["unsuccessfulRequestCount", (row) => row.unsuccessfulRequestCount],
    ...outcomeCsvColumns(),
    ...interruptionCsvColumns(),
    ["inputTokens", (row) => row.inputTokens],
    ["cachedInputTokens", (row) => row.cachedInputTokens],
    ["outputTokens", (row) => row.outputTokens],
    ["reasoningOutputTokens", (row) => row.reasoningOutputTokens],
    ...usageCoverageCsvColumns(),
    ...compactCsvColumns(),
  ];
  console.log(columns.map(([heading]) => csvCell(heading)).join(","));
  for (const row of rows) {
    console.log(columns.map(([, read]) => csvCell(read(row))).join(","));
  }
}

export function printMetricsTurns(result, format) {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (format === "csv") {
    printTurnSummaryCsv(result.turns.map((turn) => ({
      type: "turn",
      ...turn,
    })));
    return;
  }
  console.log(`# 会话对话明细 · ${result.threadId}`);
  console.log(`- 时区：${formatLocalTimeZone()}`);
  console.log(`- 时间范围：${result.range.name} · 当前会话自身的期间统计`);
  printUsageNote();
  console.log("");
  if (result.turns.length === 0) {
    console.log("该会话暂无可导出的对话记录。");
    return;
  }
  console.log("| # | 对话 ID | 时间 | 模型 | 思考等级 | 请求 | 请求结果 | 中断后续观测 | 总 Token | 缓存率 | 其中上下文压缩 |");
  console.log("| --- | --- | --- | --- | --- | ---: | --- | --- | ---: | --- | --- |");
  for (const [index, turn] of result.turns.entries()) {
    console.log(
      [
        String(result.turns.length - index),
        markdownCell(turn.turnId),
        markdownCell(formatLocalTime(turn.recordedAtMs)),
        markdownCell(turn.model ?? "未观测"),
        markdownCell(turn.reasoningEffort ?? "未观测"),
        formatPositiveCount(turn.requestCount),
        formatRequestOutcomes(turn.requestOutcomes),
        formatInterruptionSummary(turn.interruptionSummary),
        formatPositiveUsageTotal(turn),
        formatCacheRate(turn),
        markdownCell(formatCompactSummary(turn.compact) ?? ""),
      ].join(" | "),
    );
  }
  if (result.turns.some((turn) => formatInterruptionSummary(turn.interruptionSummary) !== "")) {
    console.log("后续完成仅表示时间顺序，不代表重试或恢复因果。");
  }
}

export function printMetricsThreads(result, format) {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (format === "csv") {
    const columns = [
      ["threadId", (thread) => thread.threadId],
      ["provider", (thread) => thread.provider],
      ["model", (thread) => thread.model],
      ["reasoningEffort", (thread) => thread.reasoningEffort],
      ["agentPath", (thread) => thread.agentPath],
      ["turnCount", (thread) => thread.turnCount],
      ["requestCount", (thread) => thread.requestCount],
      ...outcomeCsvColumns(),
      ["inputTokens", (thread) => thread.inputTokens],
      ["outputTokens", (thread) => thread.outputTokens],
      ["cachedInputTokens", (thread) => thread.cachedInputTokens],
      ...usageCoverageCsvColumns(),
      ...["requestCount", "inputTokens", "cachedInputTokens", "outputTokens"].map((key) => [
        `subagentUsage.${key}`, (thread) => thread.subagentUsage?.[key],
      ]),
      ...usageCoverageCsvColumns("subagentUsage.", (thread) => thread.subagentUsage),
      ...compactCsvColumns(),
      ["lastRecordedAtMs", (thread) => thread.lastRecordedAtMs],
    ];
    console.log(columns.map(([heading]) => csvCell(heading)).join(","));
    for (const thread of result.threads) {
      console.log(columns.map(([, read]) => csvCell(read(thread))).join(","));
    }
    return;
  }
  if (result.threads.length === 0) {
    console.log("指标库中暂无可导出的会话记录。");
    return;
  }
  console.log(`# 指标会话列表（${result.threads.length}）`);
  console.log(`- 时区：${formatLocalTimeZone()}`);
  console.log(`- 时间范围：${result.range.name} · 各会话自身的期间统计`);
  printUsageNote();
  console.log("");
  console.log("| # | Thread | 模型 | 思考等级 | 类型 | 对话数 | 请求数 | 请求结果 | 总 Token | 其中上下文压缩 | 最近记录 |");
  console.log("| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- | --- |");
  for (const [index, thread] of result.threads.entries()) {
    console.log(
      [
        String(index + 1),
        markdownCell(thread.threadId),
        markdownCell(thread.model ?? "未观测"),
        markdownCell(thread.reasoningEffort ?? "未观测"),
        markdownCell(thread.agentPath === null
          ? "主会话"
          : `子代理 · ${thread.agentPath}`),
        formatPositiveCount(thread.turnCount),
        formatPositiveCount(thread.requestCount),
        formatRequestOutcomes(thread.requestOutcomes),
        formatPositiveUsageTotal(thread),
        markdownCell(formatCompactSummary(thread.compact) ?? ""),
        markdownCell(formatLocalTime(thread.lastRecordedAtMs)),
      ].join(" | "),
    );
  }
  console.log("");
  console.log("导出某会话每次对话：codexc metrics turns <Thread ID>");
}

function hasTurnSummary(summary) {
  return summary.model != null || summary.reasoningEffort != null
    || summary.requestCount > 0 || formatRequestOutcomes(summary.requestOutcomes) !== ""
    || summary.inputTokens + summary.outputTokens > 0 || summary.cachedInputTokens > 0
    || summary.reasoningOutputTokens > 0 || formatCompactSummary(summary.compact) !== null;
}

function printTurnSummary(summary) {
  if (summary.model !== undefined && summary.model !== null) {
    console.log(`- 模型：${summary.model}`);
  }
  if (summary.reasoningEffort !== undefined && summary.reasoningEffort !== null) {
    console.log(`- 思考等级：${summary.reasoningEffort}`);
  }
  printMetric("模型请求", summary.requestCount > 0 ? `${formatRequestCount(summary.requestCount)} 次` : "");
  const outcomes = formatRequestOutcomes(summary.requestOutcomes);
  if (outcomes) console.log(`- ${outcomes}`);
  if (summary.requestOutcomes.interrupted > 0) {
    const observations = formatInterruptionSummary(summary.interruptionSummary);
    if (observations) {
      printMetric("中断后续观测", observations);
      console.log("- 后续完成仅表示时间顺序，不代表重试或恢复因果。");
    }
  }
  printMetric("总 Token", formatPositiveUsageTotal(summary));
  printMetric("输入", formatUsageField(summary, "input"), "  ");
  if (summary.cachedInputTokens !== null) {
    printMetric("其中缓存", formatObservedTokens(summary.cachedInputTokens), "    ");
    printMetric("无缓存", formatObservedTokens(Math.max(0, summary.inputTokens - summary.cachedInputTokens)), "    ");
  }
  printMetric("缓存命中率", formatCacheRate(summary), "    ");
  printMetric("输出", formatUsageField(summary, "output"), "  ");
  printMetric("其中推理输出", formatUsageField(summary, "reasoning"), "    ");
  printCompactSummary(summary.compact);
}

function csvColumns() {
  return [
    ...["source", "callerId", "keyId", "credentialGeneration", "relayRequestId", "deliveryStatus"].map(key => [key, record => record[key]]),
    ["firstTokenMs", (record) => record.firstTokenMs],
    ["responseTimeMs", (record) => record.responseTimeMs],
    ["generationSpeed", (record) => generationSpeed(record)],
    ["generationTimeMs", (record) => record.generationTiming?.totalMs],
    ["reasoningTimeMs", (record) => record.generationTiming?.reasoningMs],
    ["textTimeMs", (record) => record.generationTiming?.textMs],
    ["toolTimeMs", (record) => record.generationTiming?.toolMs],
    ["totalDurationMs", (record) => record.totalDurationMs],
    ["requestBytes", (record) => record.requestBytes],
    ["upstreamUrl", (record) => record.upstreamUrl],
    ["activity", (record) => record.activity == null ? null : JSON.stringify(record.activity)],
    ["upstreamTtftMs", (record) => record.upstreamTtftMs],
    ["responseUsageAmount", (record) => record.responseUsageAmount],
    ["upstreamProvider", (record) => record.upstreamProvider],
    ["upstreamAttemptCount", (record) => record.upstreamAttemptCount],
    ["modelAttemptCount", (record) => record.modelAttemptCount],
    ["finishReason", (record) => record.finishReason],
    ["errorStage", (record) => record.errorStage],
    ["upstreamErrorCode", (record) => record.upstreamErrorCode],
    ["upstreamErrorType", (record) => record.upstreamErrorType],
    ["upstreamHttpStatus", (record) => record.upstreamHttpStatus],

    ["requestModel", (record) => record.requestModel],
    ["responseModel", (record) => record.responseModel],
    ["trafficLabel", (record) => record.traffic?.label],
    ["trafficSession", (record) => record.traffic?.session],
    ["trafficInteraction", (record) => record.traffic?.interaction],
    ["id", (record) => record.id],
    ["recordedAt", (record) => record.recordedAtMs === undefined
      ? ""
      : new Date(record.recordedAtMs).toISOString()],
    ["quotaObservedAtMs", (record) => record.quotaObservedAtMs],
    ["provider", (record) => record.provider],
    ["model", (record) => record.model],
    ["serviceTier", (record) => record.serviceTier],
    ["requestServiceTier", (record) => record.requestServiceTier],
    ["reasoningEffort", (record) => record.reasoningEffort],
    ["status", (record) => record.status],
    ["errorType", (record) => record.errorType],
    ["errorMessage", (record) => record.errorMessage],
    ["incompleteReason", (record) => record.incompleteReason],
    ["httpStatus", (record) => record.httpStatus],
    ["transport", (record) => record.transport],
    ["responseFormat", (record) => record.responseFormat],
    ["operation", (record) => record.operation],
    ["threadId", (record) => record.threadId],
    ["turnId", (record) => record.turnId],
    ["requestPurpose", (record) => record.requestPurpose],
    ["reviewerThreadId", (record) => record.reviewerThreadId],
    ["reviewerTurnId", (record) => record.reviewerTurnId],
    ["inputTokens", (record) => record.inputTokens],
    ["cachedInputTokens", (record) => record.cachedInputTokens],
    ["uncachedInputTokens", (record) => record.uncachedInputTokens],
    ["outputTokens", (record) => record.outputTokens],
    ["reasoningOutputTokens", (record) => record.reasoningOutputTokens],
  ];
}
