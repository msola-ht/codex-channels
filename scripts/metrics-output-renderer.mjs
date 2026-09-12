import {
  csvCell,
  formatLocalTime,
  formatTokenCount,
  markdownCell,
} from "./metrics-export-format.mjs";
import { metricsDatabaseCanUpgrade } from "./metrics-database-access.mjs";

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
  console.log(`记录：${result.count ?? "无法读取"}`);
  if (!result.compatible) {
    console.log(metricsDatabaseCanUpgrade(result.schemaVersion)
      ? "处理：运行 codexc update"
      : "处理：停止 Gateway 后运行 codexc metrics reset");
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
  if (result.periods.length === 0) {
    console.log("暂无已记录的额度周期快照。");
    return;
  }
  for (const period of result.periods) {
    const start = period.periodStartAtMs === null ? "未知" : formatLocalTime(period.periodStartAtMs);
    const reset = formatLocalTime(period.periodEndAtMs);
    const used = period.latestUsedPercentMillionths === null
      ? "未记录历史百分比"
      : `${(period.latestUsedPercentMillionths / 1_000_000).toFixed(2)}%`;
    console.log(`- ${period.provider} · ${period.windowId} · 周期 ${start} ～ ${reset} · 最新使用 ${used} · 请求 ${period.requestCount} · Token ${formatTokenCount(period.totalTokens)}`);
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
      ["lastErrorMessage", (row) => row.lastErrorMessage],
      ["httpStatus", (row) => row.httpStatus],
      ["lastOccurredAtMs", (row) => row.lastOccurredAtMs],
      ["requestCount", (row) => row.requestCount],
      ["unsuccessfulRequestCount", (row) => row.unsuccessfulRequestCount],
      ["inputTokens", (row) => row.inputTokens],
      ["cachedInputTokens", (row) => row.cachedInputTokens],
      ["outputTokens", (row) => row.outputTokens],
      ["reasoningOutputTokens", (row) => row.reasoningOutputTokens],
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
      },
      ...result.errors.groups.map((group) => ({
        type: "error",
        provider: group.provider,
        model: group.model,
        group: group.model ?? group.provider ?? "全部",
        status: group.status,
        errorType: group.errorType,
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
  console.log(`- 生成时间：${result.generatedAt}`);
  console.log(`- 时间范围：${result.range.name}`);
  console.log(`- 起始时间：${new Date(result.range.startAtMs).toISOString()}`);
  console.log(`- 截止时间：${new Date(result.range.endAtMs).toISOString()}`);
  printWeeklyQuotaMarkdown(result.weeklyQuota);
  console.log("");
  console.log("## 汇总");
  console.log("");
  if (!aggregate) {
    console.log("本时间范围没有请求记录。");
    return;
  }
  console.log(`- 模型请求：${aggregate.requestCount}`);
  console.log(`- 异常或未完整观测：${aggregate.unsuccessfulRequestCount}`);
  console.log(`- 输入 Token：${aggregate.inputTokens}`);
  console.log(`- 缓存输入 Token：${aggregate.cachedInputTokens ?? "未知"}`);
  console.log(`- 输出 Token：${aggregate.outputTokens}`);
  console.log(`- 推理输出 Token：${aggregate.reasoningOutputTokens}`);
  printCompactSummary(aggregate.compact);
  if (result.report.groups.length > 0) {
    console.log("");
    console.log("## 明细");
    console.log("");
    console.log("| 提供商 | 模型 | 请求 | 异常/未完整 | 输入 | 缓存输入 | 输出 | 上下文压缩 |");
    console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const group of result.report.groups) {
      const value = group.aggregate;
      console.log(`| ${markdownCell(group.provider ?? "全部")} | ${markdownCell(group.model ?? "全部/未观测")} | ${value.requestCount} | ${value.unsuccessfulRequestCount} | ${value.inputTokens} | ${value.cachedInputTokens ?? "未知"} | ${value.outputTokens} | ${markdownCell(formatCompactSummary(value.compact) ?? "无")} |`);
    }
    const hidden = result.report.totalGroupCount - result.report.groups.length;
    if (hidden > 0) console.log(`\n仅显示请求量最高的 ${result.report.groups.length} 组，另有 ${hidden} 组。`);
  }
  console.log("");
  console.log("## 异常与未完整观测");
  console.log("");
  if (result.errors.groups.length === 0) {
    console.log("本时间范围没有异常或未完整观测请求。");
    return;
  }
  console.log("| 提供商 | 模型 | 状态 | 类型 | HTTP | 次数 |");
  console.log("| --- | --- | --- | --- | ---: | ---: |");
  for (const group of result.errors.groups) {
    console.log(`| ${markdownCell(group.provider)} | ${markdownCell(group.model ?? "未观测")} | ${group.status} | ${markdownCell(group.errorType ?? "未提供")} | ${group.httpStatus ?? ""} | ${group.requestCount} |`);
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

export function printMetricsExport(result, format) {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (format === "markdown") {
    console.log("# Codex Connect 请求明细");
    console.log("");
    console.log(`- 生成时间：${result.generatedAt}`);
    console.log(`- 时间范围：${result.range.name}`);
    printWeeklyQuotaMarkdown(result.weeklyQuota);
    console.log("");
    if (result.records.length === 0) {
      console.log("本时间范围没有请求记录。");
      return;
    }
    console.log("| 时间 | 提供商 | 模型 | 操作 | 思考等级 | 状态 | 输入 | 缓存输入 | 输出 |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const record of result.records) {
      console.log(
        [
          markdownCell(formatLocalTime(record.recordedAtMs)),
          markdownCell(record.provider ?? ""),
          markdownCell(record.model ?? ""),
          markdownCell(record.operation),
          markdownCell(record.reasoningEffort ?? "模型默认"),
          markdownCell(record.status ?? ""),
          markdownCell(formatTokenCount(record.inputTokens ?? 0)),
          markdownCell(formatTokenCount(record.cachedInputTokens ?? 0)),
          markdownCell(formatTokenCount(record.outputTokens ?? 0)),
        ].join(" | "),
      );
    }
    return;
  }
  const columns = [
    ["type", (row) => row.type],
    ...csvColumns(),
    ...weeklyQuotaCsvColumns(),
  ];
  const rows = [
    ...result.records.map((record) => ({
      type: "request",
      ...record,
      ...flattenRecordedWeeklyQuota(record),
    })),
    ...(result.weeklyQuota === null
      ? []
      : [{
          type: "weekly_quota_summary",
          ...flattenWeeklyQuota(result.weeklyQuota),
        }]),
  ];
  console.log(columns.map(([heading]) => csvCell(heading)).join(","));
  for (const row of rows) {
    console.log(columns.map(([, read]) => csvCell(read(row))).join(","));
  }
}

function printWeeklyQuotaMarkdown(quota) {
  console.log("");
  console.log("## 当前周额度区间");
  console.log("");
  if (quota === null) {
    console.log("暂无统计代理捕获的周额度快照。");
    return;
  }
  console.log(`- 已用：${quota.usedPercent}%`);
  console.log(`- 剩余：${quota.remainingPercent}%`);
  console.log(`- 重置时间：${new Date(quota.resetsAt * 1_000).toISOString()}`);
  console.log(`- 观测时间：${new Date(quota.observedAtMs).toISOString()}`);
  if (quota.estimate === null) {
    console.log("- 每 1% 估算：正在采样，尚未观测到额度增长");
    return;
  }
  console.log(`- 观测变化：${quota.estimate.observedDeltaPercent}%（${quota.estimate.intervalCount} 个区间）`);
  console.log(`- 每 1%：约 ${quota.estimate.totalTokensPerPercent} Token`);
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
    weeklyQuotaObservedAtMs: record.recordedAtMs,
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
    ["compactInputTokens", (row) => row.compact?.inputTokens],
    ["compactCachedInputTokens", (row) => row.compact?.cachedInputTokens],
    ["compactOutputTokens", (row) => row.compact?.outputTokens],
  ];
}

function printCompactSummary(compact) {
  const summary = formatCompactSummary(compact);
  if (summary === null) return;
  console.log(`- 上下文压缩：${summary}`);
}

function formatCompactSummary(compact) {
  if (compact == null) return null;
  const model = compact.hasMixedModels
    ? "混合模型"
    : compact.model ?? "模型未知";
  const failures = compact.unsuccessfulRequestCount > 0
    ? `（异常 ${compact.unsuccessfulRequestCount} 次）`
    : "";
  return `${compact.requestCount} 次${failures} · ${model} · ${formatTokenCount(compact.inputTokens + compact.outputTokens)} Token`;
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
  console.log(`- 生成时间：${result.generatedAt}`);
  console.log("");
  console.log("## 最近运行聚合");
  console.log("");
  if (latestTurn === null) {
    console.log("该 Thread 暂无已记录请求。");
  } else {
    printTurnSummary(latestTurn);
  }
  console.log("");
  console.log("## 当前会话指标累计");
  console.log("");
  if (threadAggregate === null) {
    console.log("该 Thread 暂无累计记录。");
  } else {
    printTurnSummary(threadAggregate);
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
    ["inputTokens", (row) => row.inputTokens],
    ["cachedInputTokens", (row) => row.cachedInputTokens],
    ["outputTokens", (row) => row.outputTokens],
    ["reasoningOutputTokens", (row) => row.reasoningOutputTokens],
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
  console.log("");
  if (result.turns.length === 0) {
    console.log("该会话暂无可导出的对话记录。");
    return;
  }
  console.log("| # | 对话 ID | 时间 | 模型 | 思考等级 | 请求 | 异常 | 总 Token | 缓存率 | 上下文压缩 |");
  console.log("| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const [index, turn] of result.turns.entries()) {
    const cacheRate = turn.cachedInputTokens === null || turn.inputTokens === 0
      ? "未知"
      : `${((turn.cachedInputTokens / turn.inputTokens) * 100).toFixed(2)}%`;
    console.log(
      [
        String(result.turns.length - index),
        markdownCell(turn.turnId),
        markdownCell(formatLocalTime(turn.recordedAtMs)),
        markdownCell(turn.model ?? "未观测"),
        markdownCell(turn.reasoningEffort ?? "模型默认"),
        String(turn.requestCount),
        String(turn.unsuccessfulRequestCount),
        formatTokenCount(turn.inputTokens + turn.outputTokens),
        cacheRate,
        markdownCell(formatCompactSummary(turn.compact) ?? "无"),
      ].join(" | "),
    );
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
      ["inputTokens", (thread) => thread.inputTokens],
      ["outputTokens", (thread) => thread.outputTokens],
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
  console.log("");
  console.log("| # | Thread | 模型 | 思考等级 | 类型 | 对话数 | 请求数 | 总 Token | 上下文压缩 | 最近记录 |");
  console.log("| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |");
  for (const [index, thread] of result.threads.entries()) {
    console.log(
      [
        String(index + 1),
        markdownCell(thread.threadId),
        markdownCell(thread.model ?? "未观测"),
        markdownCell(thread.reasoningEffort ?? "模型默认"),
        markdownCell(thread.agentPath === null
          ? "主会话"
          : `子代理 · ${thread.agentPath}`),
        String(thread.turnCount),
        String(thread.requestCount),
        formatTokenCount(thread.inputTokens + thread.outputTokens),
        markdownCell(formatCompactSummary(thread.compact) ?? "无"),
        markdownCell(formatLocalTime(thread.lastRecordedAtMs)),
      ].join(" | "),
    );
  }
  console.log("");
  console.log("导出某会话每次对话：codexc metrics turns <Thread ID>");
}

function printTurnSummary(summary) {
  const totalTokens = summary.inputTokens + summary.outputTokens;
  if (summary.model !== undefined && summary.model !== null) {
    console.log(`- 模型：${summary.model}`);
  }
  if (summary.reasoningEffort !== undefined && summary.reasoningEffort !== null) {
    console.log(`- 思考等级：${summary.reasoningEffort}`);
  }
  console.log(
    `- 模型请求：${summary.requestCount} 次${summary.unsuccessfulRequestCount > 0 ? `（异常 ${summary.unsuccessfulRequestCount} 次）` : ""}`,
  );
  console.log(`- 总 Token：${formatTokenCount(totalTokens)}`);
  if (summary.cachedInputTokens === null) {
    console.log("  - 缓存：上游未提供完整数据");
  } else {
    console.log(`  - 输入命中缓存：${formatTokenCount(summary.cachedInputTokens)}`);
    console.log(
      `  - 输入未命中缓存：${formatTokenCount(Math.max(0, summary.inputTokens - summary.cachedInputTokens))}`,
    );
    console.log(
      `  - 缓存命中率：${summary.inputTokens === 0 ? "0%" : `${((summary.cachedInputTokens / summary.inputTokens) * 100).toFixed(2)}%`}`,
    );
  }
  console.log(`  - 输出：${formatTokenCount(summary.outputTokens)}`);
  if (summary.reasoningOutputTokens > 0) {
    console.log(`    - 其中推理输出：${formatTokenCount(summary.reasoningOutputTokens)}`);
  }
  printCompactSummary(summary.compact);
}

function csvColumns() {
  return [
    ["id", (record) => record.id],
    ["recordedAt", (record) => record.recordedAtMs === undefined
      ? ""
      : new Date(record.recordedAtMs).toISOString()],
    ["provider", (record) => record.provider],
    ["model", (record) => record.model],
    ["serviceTier", (record) => record.serviceTier],
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
    ["inputTokens", (record) => record.inputTokens],
    ["cachedInputTokens", (record) => record.cachedInputTokens],
    ["uncachedInputTokens", (record) => record.uncachedInputTokens],
    ["outputTokens", (record) => record.outputTokens],
    ["reasoningOutputTokens", (record) => record.reasoningOutputTokens],
  ];
}
