import type {
  ConversationCommandResult,
  RequestMetricsTimeRange,
} from "../application/index.js";

import {
  formatPercent,
} from "./account-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import {
  formatCodexProviderLabel,
  formatProviderLabel,
} from "./provider-format.js";
import {
  formatCacheHitRate,
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
    `Session ID：${formatThreadId(summary.threadId)}`,
  ];
  if (summary.latestTurn) {
    const turn = summary.latestTurn;
    lines.push(
      "",
      "### 最近运行聚合",
      `模型请求：${turn.requestCount} 次${turn.unsuccessfulRequestCount > 0 ? `（异常 ${turn.unsuccessfulRequestCount} 次）` : ""}`,
      `- **Token**：${formatTokenCount(turn.inputTokens + turn.outputTokens)}`,
      ...(turn.cachedInputTokens === null
        ? ["  - 缓存：上游未提供完整数据"]
        : [
            `  - 输入命中缓存：${formatTokenCount(turn.cachedInputTokens)}`,
            `  - 输入未命中缓存：${formatTokenCount(Math.max(0, turn.inputTokens - turn.cachedInputTokens))}`,
            `  - 缓存命中率：${formatCacheHitRate(turn.inputTokens, turn.cachedInputTokens)}`,
          ]),
      `  - 输出：${formatTokenCount(turn.outputTokens)}`,
      ...(turn.reasoningOutputTokens > 0
        ? [`  - 其中推理输出：${formatTokenCount(turn.reasoningOutputTokens)}`]
        : []),
      ...(turn.compact
        ? [formatCompactMetrics(turn.compact)]
        : []),
    );
  } else {
    lines.push("", "### 最近运行聚合", "暂无已记录请求");
  }
  if (summary.threadAggregate) {
    const aggregate = summary.threadAggregate;
    lines.push(
      "",
      "### 当前会话指标累计",
      `Turn：${aggregate.turnCount} 次`,
      `模型请求：${aggregate.requestCount} 次${aggregate.unsuccessfulRequestCount > 0 ? `（异常 ${aggregate.unsuccessfulRequestCount} 次）` : ""}`,
      `- **Token**：${formatTokenCount(aggregate.inputTokens + aggregate.outputTokens)}`,
      ...(aggregate.cachedInputTokens === null
        ? ["  - 缓存：上游未提供完整数据"]
        : [
            `  - 输入命中缓存：${formatTokenCount(aggregate.cachedInputTokens)}`,
            `  - 输入未命中缓存：${formatTokenCount(Math.max(0, aggregate.inputTokens - aggregate.cachedInputTokens))}`,
            `  - 缓存命中率：${formatCacheHitRate(aggregate.inputTokens, aggregate.cachedInputTokens)}`,
          ]),
      `  - 输出：${formatTokenCount(aggregate.outputTokens)}`,
      ...(aggregate.reasoningOutputTokens > 0
        ? [`  - 其中推理输出：${formatTokenCount(aggregate.reasoningOutputTokens)}`]
        : []),
      ...(aggregate.compact
        ? [formatCompactMetrics(aggregate.compact)]
        : []),
    );
  }
  if (summary.latestDirectApi) {
    const direct = summary.latestDirectApi;
    lines.push(
      "",
      "### 最近直接 API",
      `API 提供商：${formatProviderLabel(direct.providerName ?? direct.provider)}`,
      `调用模型：${direct.model ?? "未知"}`,
      `状态：${formatRequestStatus(direct.status)}${direct.httpStatus === null ? "" : ` · HTTP ${direct.httpStatus}`}`,
      ...(direct.inputTokens === null && direct.outputTokens === null
        ? []
        : [
            `- **Token**：${formatTokenCount(
              direct.totalTokens ?? (direct.inputTokens ?? 0) + (direct.outputTokens ?? 0),
            )}`,
            ...(direct.cachedInputTokens === null
              ? direct.inputTokens === null
                ? []
                : [`  - 输入：${formatTokenCount(direct.inputTokens)}`]
              : [
                  `  - 输入命中缓存：${formatTokenCount(direct.cachedInputTokens)}`,
                  `  - 输入未命中缓存：${formatTokenCount(Math.max(0, (direct.inputTokens ?? 0) - direct.cachedInputTokens))}`,
                ]),
            ...(direct.outputTokens === null
              ? []
              : [`  - 输出：${formatTokenCount(direct.outputTokens)}`]),
            ...(direct.reasoningOutputTokens === null || direct.reasoningOutputTokens === 0
              ? []
              : [`  - 其中推理输出：${formatTokenCount(direct.reasoningOutputTokens)}`]),
          ]),
    );
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
    : report.unsuccessfulRequestCount / report.requestCount * 100;
  const lines = [
    "## 请求指标 · 异常请求",
    `范围：${formatMetricsRange(report.range)}`,
    "",
    `模型请求：${report.requestCount} 次`,
    `异常请求：${report.unsuccessfulRequestCount} 次`,
    `异常率：${formatPercent(failureRate)}`,
  ];
  if (report.groups.length === 0) {
    lines.push("", "本时间范围未记录异常请求。");
    return toStructuredMarkdownList(lines.join("\n"));
  }
  lines.push(
    "",
    "### 异常明细",
    ...report.groups.map((group, index) => {
      const provider = group.providerName
        ? formatProviderLabel(group.providerName)
        : formatCodexProviderLabel(group.provider);
      const status = formatRequestStatus(group.status);
      const httpStatus = group.httpStatus === null
        ? ""
        : ` · HTTP ${group.httpStatus}`;
      return `${index + 1}. ${provider} / ${group.model ?? "未知模型"} · ${formatMetricsErrorType(group.errorType)} · ${status}${httpStatus} · ${group.requestCount} 次 · 最近发生：${formatMetricOccurredAt(group.lastOccurredAtMs)}`;
    }),
  );
  const hidden = report.totalGroupCount - report.groups.length;
  if (hidden > 0) {
    lines.push(`仅显示出现次数最高的 ${report.groups.length} 项，另有 ${hidden} 项。`);
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

function formatThreadId(threadId: string): string {
  return threadId.length > 12
    ? `${threadId.slice(0, 12)}…`
    : threadId;
}

function formatMetricsErrorType(value: string | null): string {
  if (value === null) return "未提供错误类型";
  const knownLabel = {
    websocket_closed: "WebSocket 提前关闭",
    upstream_handshake_error: "上游握手失败",
    upstream_request_error: "上游请求失败",
    upstream_response_error: "上游响应失败",
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
  lines.push(
    "",
    "### 本时间范围累计",
    ...formatMetricsAggregate(report.aggregate),
  );
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
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestDurationMs: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  outputTokensPerSecond: number | null;
  outputSpeedSampleCount: number;
  outputSpeedTimedCount: number;
  ttftAverageMs: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  ttftSampleCount: number;
  compact?: Parameters<typeof formatCompactMetricsValue>[0] | null;
  },
): string[] {
  return [
    `模型请求：${aggregate.requestCount} 次${aggregate.unsuccessfulRequestCount > 0 ? `（异常 ${aggregate.unsuccessfulRequestCount} 次）` : ""}`,
    `- **Token**：${formatTokenCount(aggregate.inputTokens + aggregate.outputTokens)}`,
    ...(aggregate.cachedInputTokens === null
      ? ["  - 缓存：上游未提供完整数据"]
      : [
          `  - 输入命中缓存：${formatTokenCount(aggregate.cachedInputTokens)}`,
          `  - 输入未命中缓存：${formatTokenCount(Math.max(0, aggregate.inputTokens - aggregate.cachedInputTokens))}`,
          `  - 缓存命中率：${formatCacheHitRate(aggregate.inputTokens, aggregate.cachedInputTokens)}`,
        ]),
    `  - 输出：${formatTokenCount(aggregate.outputTokens)}`,
    ...(aggregate.reasoningOutputTokens > 0
      ? [`  - 其中推理输出：${formatTokenCount(aggregate.reasoningOutputTokens)}`]
      : []),
    ...(aggregate.compact
      ? [formatCompactMetrics(aggregate.compact)]
      : []),
  ];
}

function formatMetricsGroup(
  group: {
    provider: string | null;
    providerName?: string;
    model: string | null;
    aggregate: Parameters<typeof formatMetricsAggregate>[0];
  },
  index: number,
  view: "providers" | "models",
): string {
  const provider = group.providerName
    ? formatProviderLabel(group.providerName)
    : group.provider === null
      ? "未知提供商"
      : formatCodexProviderLabel(group.provider);
  const label = view === "models"
    ? `${provider} / ${group.model ?? "未知模型"}`
    : provider;
  const aggregate = group.aggregate;
  const reasoning = aggregate.reasoningOutputTokens > 0
    ? `  - 其中推理输出：${formatTokenCount(aggregate.reasoningOutputTokens)}`
    : "";
  return [
    `${index + 1}. ${label}`,
    `  - 请求：${aggregate.requestCount} 次${aggregate.unsuccessfulRequestCount > 0 ? `（异常 ${aggregate.unsuccessfulRequestCount} 次）` : ""}`,
    ...(aggregate.cachedInputTokens === null
      ? []
      : [
          `  - 输入命中缓存：${formatTokenCount(aggregate.cachedInputTokens)}`,
          `  - 输入未命中缓存：${formatTokenCount(Math.max(0, aggregate.inputTokens - aggregate.cachedInputTokens))}`,
          `  - 缓存命中率：${formatCacheHitRate(aggregate.inputTokens, aggregate.cachedInputTokens)}`,
        ]),
    `  - 输出：${formatTokenCount(aggregate.outputTokens)}`,
    ...(reasoning === "" ? [] : [reasoning]),
    `  - 合计：${formatTokenCount(aggregate.inputTokens + aggregate.outputTokens)}`,
    ...(aggregate.compact
      ? [`  - ${formatCompactMetrics(aggregate.compact)}`]
      : []),
  ].join("\n");
}

function formatCompactMetrics(
  compact: Parameters<typeof formatCompactMetricsValue>[0],
): string {
  return `上下文压缩：${formatCompactMetricsValue(compact)}`;
}

export function formatCompactMetricsValue(
  compact: {
    model: string | null;
    hasMixedModels: boolean;
    requestCount: number;
    unsuccessfulRequestCount: number;
    inputTokens: number;
    outputTokens: number;
  },
): string {
  const model = compact.hasMixedModels
    ? "混合模型"
    : compact.model ?? "模型未知";
  const failures = compact.unsuccessfulRequestCount === 0
    ? ""
    : `（异常 ${compact.unsuccessfulRequestCount} 次）`;
  return `${compact.requestCount} 次${failures} · ${model} · ${formatTokenCount(compact.inputTokens + compact.outputTokens)} Token`;
}

function formatMetricsRange(range: RequestMetricsTimeRange): string {
  return {
    today: "今天",
    yesterday: "昨天",
    "this-week": "本周",
    "last-week": "上周",
    "this-month": "本月",
    "last-month": "上月",
    "24h": "最近 24 小时",
    "7d": "最近 7 天",
    "30d": "最近 30 天",
    "90d": "最近 90 天",
    "365d": "最近 365 天",
    all: "全部历史",
  }[range];
}

function formatRequestStatus(
  status: "completed" | "failed" | "incomplete" | "unknown",
): string {
  switch (status) {
    case "completed": return "已完成";
    case "failed": return "失败";
    case "incomplete": return "未完成";
    case "unknown": return "未知";
  }
}
