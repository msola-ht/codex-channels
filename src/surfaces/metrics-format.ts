import type {
  ConversationCommandResult,
  RequestMetricsTimeRange,
  RequestOutcomeCounts,
  RequestInterruptionSummary,
  TurnRequestMetricsSummary,
  ThreadRequestMetricsSummary,
} from "../application/index.js";

import {
  formatPercent,
  formatTimezoneLine,
} from "./account-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import { formatElapsedDuration } from "./elapsed-duration.js";
import { formatCodexProviderLabel } from "./provider-format.js";
import {
  formatCacheHitRate,
  formatObservedTotal,
  formatRequestCount,
  formatTokenCount,
} from "./token-format.js";
export function formatConversationMetrics(
  result: Extract<ConversationCommandResult, { kind: "metrics" }>,
): string {
  const summary = result.summary;
  if (summary === null) {
    return "当前会话尚未绑定 Session，暂无请求指标。";
  }
  if ("view" in summary) {
    if (summary.view === "errors") {
      return formatErrorMetricsReport(summary);
    }
    return formatAggregateMetricsReport(summary);
  }
  const lines = [
    "## 请求指标",
    "任务执行统计排除明确标记的自动审查；Token 为保留记录中的已知累计。",
    `Session ID：${summary.threadId}`,
  ];
  if (summary.latestTurn) {
    const turn = summary.latestTurn;
    const details = [
      ...(turn.requestCount > 0 ? [`模型请求：${formatRequestCount(turn.requestCount)} 次`] : []),
      ...nonemptyLine(formatRequestOutcomes(turn.requestOutcomes)),
      ...formatInterruptionSummary(turn.interruptionSummary),
      ...formatMetricsUsage(turn),
      ...(turn.durationMs != null && Number.isFinite(turn.durationMs) && turn.durationMs > 0
        ? [`本轮耗时：${formatElapsedDuration(turn.durationMs)}`] : []),
      ...formatMetricsPerformance(turn.performance),
      ...(turn.compact
        ? nonemptyLine(formatCompactMetrics(turn.compact))
        : []),
    ];
    if (details.length > 0) lines.push("", "### 最近运行聚合", ...details);
  }
  const sessionDuration = formatSessionDuration(summary);
  if (summary.threadAggregate || sessionDuration.length > 0) {
    const aggregate = summary.threadAggregate;
    const details = [
      ...(aggregate ? [
        ...(aggregate.turnCount > 0 ? [`Turn：${aggregate.turnCount} 次`] : []),
        ...(aggregate.requestCount > 0 ? [`模型请求：${formatRequestCount(aggregate.requestCount)} 次`] : []),
        ...nonemptyLine(formatRequestOutcomes(aggregate.requestOutcomes)),
        ...formatInterruptionSummary(aggregate.interruptionSummary),
        ...formatMetricsUsage(aggregate),
      ] : []),
      ...sessionDuration,
      ...formatMetricsPerformance(aggregate?.performance),
      ...(aggregate?.compact
        ? nonemptyLine(formatCompactMetrics(aggregate.compact))
        : []),
    ];
    if (details.length > 0) lines.push("", "### 当前会话指标累计", ...details);
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

function formatErrorMetricsReport(
  report: Extract<NonNullable<Extract<
    ConversationCommandResult,
    { kind: "metrics" }
  >["summary"]>, { view: "errors" }>,
): string {
  const failureRate = report.requestCount === 0
    ? 0
    : report.requestOutcomes.failed / report.requestCount * 100;
  const lines = [
    "## 请求指标 · 中断、失败与未完整观测",
    formatTimezoneLine(),
    `范围：${formatMetricsRange(report.range)}`,
    "",
    ...(report.requestCount > 0 ? [`模型请求：${formatRequestCount(report.requestCount)} 次`] : []),
    ...nonemptyLine(formatRequestOutcomes(report.requestOutcomes)),
    ...(failureRate > 0 ? [`其他失败率：${formatPercent(failureRate)}`] : []),
  ];
  if (report.groups.length === 0) {
    lines.push("", "本时间范围未记录中断、失败或未完整观测请求。");
    return toStructuredMarkdownList(lines.join("\n"));
  }
  lines.push(
    "",
    "### 请求明细",
    ...report.groups.map((group, index) => {
      const provider = formatCodexProviderLabel(group.provider);
      const status = (group.source === "relay" ? group.errorCode : group.errorType) === "client_disconnected"
        ? "客户端中断"
        : formatRequestStatus(group.status);
      const httpStatus = group.httpStatus === null
        ? ""
        : ` · HTTP ${group.httpStatus}`;
      const code = group.errorCode === null ? "" : ` · 错误码：${/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(group.errorCode) ? group.errorCode : "未识别"}`;
      const count = group.requestCount > 0 ? ` · ${formatRequestCount(group.requestCount)} 次` : "";
      return `${index + 1}. ${group.source === "relay" ? "Relay" : "原生代理"} · ${provider} / ${group.model === null ? "未知模型" : group.model} · ${formatMetricsErrorType(group.errorType)}${code} · ${status}${httpStatus}${count} · 最近发生：${formatMetricOccurredAt(group.lastOccurredAtMs)}`;
    }),
  );
  const hidden = report.totalGroupCount - report.groups.length;
  if (hidden > 0) {
    lines.push(`按最近发生时间显示 ${report.groups.length} 项，另有 ${hidden} 项。`);
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

function formatMetricsPerformance(performance: TurnRequestMetricsSummary["performance"]): string[] {
  if (!performance) return [];
  const first = performance.averageFirstTokenMs;
  const speed = performance.generationTokensPerSecond;
  return [
    ...(performance.firstTokenSampleCount > 0 && first != null && Number.isFinite(first) && first > 0
      ? [`首 Token：${formatElapsedDuration(first)}`] : []),
    ...(performance.requestCount > 0 && speed != null && Number.isFinite(speed) && speed > 0
      ? [`速度：${speed.toFixed(1)} Token/s`] : []),
  ];
}

function formatSessionDuration(summary: ThreadRequestMetricsSummary): string[] {
  const timing = summary.sessionTiming;
  const duration = timing ? timing.knownDurationMs : summary.sessionDurationMs;
  if (duration == null || !Number.isFinite(duration) || duration <= 0) return [];
  const partial = timing && (!timing.historyComplete || timing.missingTurnCount > 0);
  return [`${partial ? "已知总耗时" : "总耗时"}：${formatElapsedDuration(duration)}${partial ? "（历史耗时未完整）" : ""}`];
}

function formatMetricsErrorType(value: string | null): string {
  if (value === null) return "未提供错误类型";
  const knownLabel = {
    websocket_closed: "WebSocket 提前关闭",
    upstream_handshake_error: "上游握手失败",
    upstream_request_error: "上游请求失败",
    upstream_response_error: "上游响应失败",
    upload_timeout: "请求上传超时",
    preparation_timeout: "请求准备超时",
    upstream_timeout: "上游等待超时",
    delivery_timeout: "响应交付超时",
    client_delivery_error: "响应交付失败",
    upstream_delivery_error: "上游请求交付失败",
    upstream_error: "上游错误",
    client_request_error: "客户端请求失败",
    client_disconnected: "客户端提前断开",
    response_not_observed: "响应结果未完整观测",
    http_error: "HTTP 请求失败",
    usage_limit_reached: "OpenAI 用量上限",
    rate_limit_reached: "速率限制",
    turn_start_error: "Turn 启动失败",
    turn_steer_error: "Turn 追加失败",
    turn_notification_error: "Turn 运行失败",
  }[value];
  if (knownLabel !== undefined) return knownLabel;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : "其他错误";
}

function formatMetricOccurredAt(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatAggregateMetricsReport(
  report: Extract<NonNullable<Extract<
    ConversationCommandResult,
    { kind: "metrics" }
  >["summary"]>, { view: "global" | "providers" | "models" }>,
): string {
  const viewName = {
    global: "全局",
    providers: "按提供商",
    models: "按模型",
  }[report.view];
  const lines = [
    `## 请求指标 · ${viewName}`,
    `范围：${formatMetricsRange(report.range)}`,
  ];
  if (report.aggregate === null) {
    lines.push("", "本时间范围暂无已记录请求。");
    return toStructuredMarkdownList(lines.join("\n"));
  }
  const details = formatMetricsAggregate(report.aggregate);
  if (details.length > 0) lines.push("", "### 本时间范围累计", ...details);
  if (report.view !== "global" && report.groups.length > 0) {
    const groupView = report.view === "providers" ? "providers" : "models";
    lines.push(
      "",
      groupView === "providers" ? "### 提供商明细" : "### 模型明细",
      ...report.groups.map((group, index) => formatMetricsGroup(
        group,
        index,
        groupView,
      )),
    );
    const hidden = report.totalGroupCount - report.groups.length;
    if (hidden > 0) {
      lines.push(`仅显示请求量最高的 ${report.groups.length} 项，另有 ${hidden} 项。`);
    }
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

function formatMetricsAggregate(
  aggregate: {
  usageCoverage: { inputMissingRequestCount: number; outputMissingRequestCount: number; reasoningMissingRequestCount: number };
  reviewUsage?: { requestCount: number; inputTokens: number; outputTokens: number; usageCoverage: { inputMissingRequestCount: number; outputMissingRequestCount: number } };
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestOutcomes: RequestOutcomeCounts;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  compact?: Parameters<typeof formatCompactMetricsValue>[0] | null;
  },
): string[] {
  return [
    ...(aggregate.requestCount > 0 ? [`模型请求：${formatRequestCount(aggregate.requestCount)} 次`] : []),
    ...nonemptyLine(formatRequestOutcomes(aggregate.requestOutcomes)),
    ...formatMetricsUsage(aggregate),
    ...formatReviewUsage(aggregate.reviewUsage),
    ...(aggregate.compact
      ? nonemptyLine(formatCompactMetrics(aggregate.compact))
      : []),
  ];
}

function formatMetricsGroup(
  group: {
    provider: string | null;
    model: string | null;
    aggregate: Parameters<typeof formatMetricsAggregate>[0];
  },
  index: number,
  view: "providers" | "models",
): string {
  const provider = group.provider === null
    ? "未知提供商"
    : formatCodexProviderLabel(group.provider);
  const label = view === "models"
    ? `${provider} / ${group.model === null ? "未知模型" : group.model}`
    : provider;
  const aggregate = group.aggregate;
  return [
    `${index + 1}. ${label}`,
    ...(aggregate.requestCount > 0 ? [`  - 请求：${formatRequestCount(aggregate.requestCount)} 次`] : []),
    ...nonemptyLine(formatRequestOutcomes(aggregate.requestOutcomes)).map((line) => `  - ${line}`),
    ...formatMetricsUsage(aggregate).map((line) => line.startsWith("- ") ? `  ${line}` : line),
    ...formatReviewUsage(aggregate.reviewUsage),
    ...(aggregate.compact
      ? nonemptyLine(formatCompactMetrics(aggregate.compact)).map((line) => `  - ${line}`)
      : []),
  ].join("\n");
}

function formatCompactMetrics(
  compact: Parameters<typeof formatCompactMetricsValue>[0],
): string {
  const value = formatCompactMetricsValue(compact);
  return value === "" ? "" : `其中上下文压缩：${value}`;
}

function nonemptyLine(value: string): string[] {
  return value === "" ? [] : [value];
}

function formatMetricsUsage(usage: {
  inputTokens: number; cachedInputTokens: number | null;
  outputTokens: number; reasoningOutputTokens: number;
}): string[] {
  const uncached = usage.cachedInputTokens === null
    ? 0 : Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return [
    ...(usage.inputTokens + usage.outputTokens > 0 ? [`- **已记录 Token**：${formatObservedTotal(usage)}`] : []),
    ...(usage.cachedInputTokens === null && usage.inputTokens > 0
      ? [`  - 输入：${formatTokenCount(usage.inputTokens)}`] : []),
    ...(usage.cachedInputTokens !== null && usage.cachedInputTokens > 0
      ? [`  - 缓存：${formatTokenCount(usage.cachedInputTokens)}`] : []),
    ...(uncached > 0 ? [`  - 无缓存：${formatTokenCount(uncached)}`] : []),
    ...(usage.inputTokens > 0 && usage.cachedInputTokens !== null && usage.cachedInputTokens > 0
      ? [`  - 缓存命中率：${formatCacheHitRate(usage.inputTokens, usage.cachedInputTokens)}`] : []),
    ...(usage.outputTokens > 0 ? [`  - 输出：${formatTokenCount(usage.outputTokens)}`] : []),
    ...(usage.reasoningOutputTokens > 0 ? [`  - 其中推理输出：${formatTokenCount(usage.reasoningOutputTokens)}`] : []),
  ];
}

function formatReviewUsage(usage: { requestCount: number; inputTokens: number; outputTokens: number } | undefined): string[] {
  if (!usage) return [];
  const parts = [
    ...(usage.requestCount > 0 ? [`${formatRequestCount(usage.requestCount)} 次请求`] : []),
    ...(usage.inputTokens + usage.outputTokens > 0 ? [`${formatObservedTotal(usage)} Token`] : []),
  ];
  return parts.length > 0 ? [`  - 其中自动审查：${parts.join(" · ")}`] : [];
}

export function formatCompactMetricsValue(
  compact: {
    usageCoverage?: { inputMissingRequestCount: number; outputMissingRequestCount: number };
    model: string | null;
    hasMixedModels: boolean;
    requestCount: number;
    unsuccessfulRequestCount: number;
    requestOutcomes?: RequestOutcomeCounts;
    inputTokens: number;
    outputTokens: number;
  },
  options: { concise?: boolean; currentModel?: string | undefined } = {},
): string {
  if (compact.requestCount === 0 && compact.inputTokens + compact.outputTokens === 0) return "";
  const model = compact.hasMixedModels
    ? "混合模型"
    : compact.model === null ? "模型未知" : compact.model;
  if (options.concise) {
    const parts = compact.requestCount > 0 ? [`${formatRequestCount(compact.requestCount)} 次`] : [];
    if (compact.hasMixedModels || !compact.model || compact.model !== options.currentModel) {
      parts.push(model);
    }
    if (compact.inputTokens + compact.outputTokens > 0) parts.push(`${formatObservedTotal(compact)} Token`);
    if (compact.requestOutcomes) {
      for (const [label, count] of [
        ["客户端中断", compact.requestOutcomes.interrupted],
        ["其他失败", compact.requestOutcomes.failed],
        ["未完整观测", compact.requestOutcomes.incomplete],
      ] as const) {
        if (count > 0) parts.push(`${label} ${formatRequestCount(count)}`);
      }
    } else if (compact.unsuccessfulRequestCount > 0) {
      parts.push(`未完成 ${formatRequestCount(compact.unsuccessfulRequestCount)} 次（结果分类未提供）`);
    }
    return parts.join(" · ");
  }
  const outcomes = compact.requestOutcomes
    ? formatRequestOutcomes(compact.requestOutcomes)
    : compact.unsuccessfulRequestCount > 0
      ? `未完成 ${formatRequestCount(compact.unsuccessfulRequestCount)} 次（结果分类未提供）`
      : "";
  return [
    ...(compact.requestCount > 0 ? [`${formatRequestCount(compact.requestCount)} 次`] : []),
    model,
    ...(compact.inputTokens + compact.outputTokens > 0 ? [`${formatObservedTotal(compact)} Token`] : []),
    ...nonemptyLine(outcomes),
  ].join(" · ");
}

function formatRequestOutcomes(outcomes: RequestOutcomeCounts): string {
  return ([["完成", outcomes.completed], ["客户端中断", outcomes.interrupted], ["其他失败", outcomes.failed], ["未完整观测", outcomes.incomplete]] as const)
    .filter(([, count]) => count > 0).map(([label, count]) => `${label}：${formatRequestCount(count)}`).join(" · ");
}

function formatInterruptionSummary(summary: RequestInterruptionSummary): string[] {
  if (summary.followedByCompletion + summary.noObservedCompletion === 0) return [];
  const observations = [
    ...(summary.followedByCompletion > 0 ? [`同一 Turn 后续有完成 ${formatRequestCount(summary.followedByCompletion)} 次`] : []),
    ...(summary.noObservedCompletion > 0 ? [`未观测到后续完成 ${formatRequestCount(summary.noObservedCompletion)} 次`] : []),
  ];
  return [
    `客户端中断后：${observations.join(" · ")}`,
    "后续完成仅表示时间顺序，不代表重试或恢复因果。",
  ];
}

function formatMetricsRange(range: RequestMetricsTimeRange): string {
  return {
    "24h": "最近 24 小时",
    "7d": "最近 7 天",
    "30d": "最近 30 天",
    "90d": "最近 90 天",
    all: "全部历史",
  }[range];
}

function formatRequestStatus(
  status: "completed" | "failed" | "incomplete" | "unknown",
): string {
  switch (status) {
    case "completed": return "已完成";
    case "failed": return "其他失败";
    case "incomplete": return "未完整观测";
    case "unknown": return "未完整观测";
  }
}
