import {
  isFastServiceTier,
  type ConversationStatus,
  type DisplayPriceCurrency,
  type ExchangeRateSnapshot,
} from "../application/index.js";
import type {
  OutputEvent,
  ThreadGoal,
} from "../conversation-core/index.js";
import { usesOpenAiAccount } from "../conversation-core/index.js";

import {
  formatOpenAiErrorMessage,
  formatPercent,
  formatRemainingRateLimitWindow,
} from "./account-format.js";
import { toStructuredMarkdownList } from "./conversation-command-format.js";
import {
  formatElapsedDuration,
  formatTokensPerSecond,
} from "./elapsed-duration.js";
import { formatCodexProviderLabel } from "./provider-format.js";
import {
  formatCurrencyNanos,
  formatCnyEquivalent,
  formatReferenceCostTotal,
  toDisplayReferenceCost,
} from "./reference-cost-format.js";
import {
  formatCompactMetricsValue,
  formatDeepseekAveragePriceValue,
} from "./metrics-format.js";
import {
  formatCacheHitRate,
  formatTokenCount,
} from "./token-format.js";

export interface LifecyclePresentation {
  title: string;
  fields: readonly LifecyclePresentationField[];
  sections?: readonly LifecyclePresentationSection[];
}

export interface LifecyclePresentationLeafField {
  label: string;
  value: string;
  subfields?: readonly LifecyclePresentationLeafField[];
}

export type LifecyclePresentationField =
  | LifecyclePresentationLeafField
  | {
      title: string;
      value?: string;
      fields: readonly LifecyclePresentationField[];
    };

export interface LifecyclePresentationSection {
  title: string;
  fields: readonly LifecyclePresentationField[];
}

export interface StartupRuntimeInfo {
  platform: NodeJS.Platform;
  architecture: string;
  gatewayVersion: string;
  nodeVersion: string;
  transport: string;
  codexUpstreamUserAgent: string | null;
  debugEnabled?: boolean;
}

type StartupStatus = Pick<
  ConversationStatus,
  | "threadId"
  | "workspaceId"
  | "model"
  | "modelProvider"
  | "effort"
  | "serviceTier"
  | "modelPending"
  | "effortPending"
  | "fastModePending"
  | "collaborationMode"
  | "collaborationModePending"
  | "weeklyLimit"
  | "gitBranch"
>;

export function createStartupPresentation(
  workspaces: ReadonlyArray<{ id: string; name: string; cwd: string }>,
  status: StartupStatus,
  runtime: StartupRuntimeInfo,
): LifecyclePresentation {
  const workspace = workspaces.find(({ id }) => id === status.workspaceId);
  if (!workspace) {
    throw new Error(`当前 Workspace 不存在：${status.workspaceId}`);
  }
  return {
    title: "Codex Connect 已上线",
    fields: [{ label: "App Server", value: "已连接" }],
    sections: [
      ...(runtime.debugEnabled === true
        ? [{
            title: "运行环境",
            fields: [
              {
                label: "系统",
                value: `${platformLabel(runtime.platform)} · ${runtime.architecture}`,
              },
              {
                label: "版本",
                value: `Codex Connect ${runtime.gatewayVersion} · Node.js ${runtime.nodeVersion}`,
              },
              { label: "连接", value: runtime.transport },
              {
                label: "App Server UA",
                value: formatUpstreamUserAgent(runtime.codexUpstreamUserAgent),
              },
            ],
          }]
        : []),
      {
        title: "当前会话",
        fields: [
          {
            label: "Workspace",
            value: `${workspace.name} (${workspace.id})`,
          },
          { label: "工作目录", value: workspace.cwd },
          { label: "Thread", value: status.threadId ?? "尚未绑定" },
          {
            label: "Git 分支",
            value: status.gitBranch ?? "未检测到",
          },
          {
            label: "模型",
            value: `${status.model}${pendingSuffix(status.modelPending)}`,
          },
          {
            label: "提供商",
            value: formatCodexProviderLabel(status.modelProvider),
          },
          {
            label: "思考等级",
            value: `${status.effort ?? "模型默认"}${pendingSuffix(status.effortPending)}`,
          },
          ...(usesOpenAiAccount(status.modelProvider)
            ? [{
                label: "Fast 模式",
                value: `${status.threadId
                  ? (isFastServiceTier(status.serviceTier) ? "开启" : "关闭")
                  : "未知"}${pendingSuffix(status.fastModePending)}`,
              }]
            : []),
          {
            label: "协作模式",
            value: `${status.collaborationMode === "plan" ? "Plan" : "Default"}${pendingSuffix(status.collaborationModePending)}`,
          },
        ],
      },
      ...(usesOpenAiAccount(status.modelProvider) && status.weeklyLimit
        ? [{
            title: "账户状态",
            fields: [{
              label: "周限",
              value: formatWeeklyLimit(status.weeklyLimit),
            }],
          }]
        : []),
    ],
  };
}

export function createTurnStartedPresentation(
  backgroundThreadId?: string,
): LifecyclePresentation {
  return {
    title: backgroundThreadId ? "后台任务继续处理中。" : "已开始处理。",
    fields: backgroundThreadId
      ? [{ label: "Thread", value: backgroundThreadId }]
      : [],
  };
}

export function createTurnCompletedPresentation(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
  debug = false,
): LifecyclePresentation {
  const currency = priceCurrency?.(event.modelProvider) ?? "usd";
  const sessionFields: LifecyclePresentationField[] = event.background
    ? [{ label: "Thread", value: event.threadId }]
    : [];
  const runFields: LifecyclePresentationField[] = [];
  const accountFields: LifecyclePresentationField[] = [];
  let fallbackCacheField: LifecyclePresentationField | undefined;
  if (event.error) {
    runFields.push({
      label: "错误",
      value: formatOpenAiErrorMessage(event.error),
    });
  }
  if (event.tokenUsage) {
    const current = event.tokenUsage.last.totalTokens;
    const capacity = event.tokenUsage.modelContextWindow;
    sessionFields.push(
      {
        label: "上下文",
        value: capacity === null || capacity <= 0
          ? formatTokenCount(current)
          : `${formatTokenCount(current)} / ${formatTokenCount(capacity)}（${formatPercent(Math.max(0, current / capacity * 100))}）`,
      },
    );
    if (
      event.timing?.requestInputTokens === undefined
      || event.timing.requestCachedInputTokens === undefined
    ) {
      fallbackCacheField = {
        label: "最近请求缓存命中率",
        value: formatCacheHitRate(
          event.tokenUsage.last.inputTokens,
          event.tokenUsage.last.cachedInputTokens,
        ),
      };
    }
  }
  if (event.model) {
    runFields.push({
      label: "模型",
      value: usesOpenAiAccount(event.modelProvider)
        ? `${event.model} · ${event.effort ?? "模型默认"} · Fast ${isFastServiceTier(event.serviceTier ?? null) ? "开启" : "关闭"}`
        : `${event.model} · ${event.effort ?? "模型默认"}`,
    });
    runFields.push({
      label: "提供商",
      value: formatCodexProviderLabel(event.modelProvider),
    });
  }
  if (event.contextCompactionCount !== undefined) {
    sessionFields.push({
      label: "上下文压缩",
      value: `${event.contextCompactionCount} 次`,
    });
  }
  if (usesOpenAiAccount(event.modelProvider) && event.weeklyLimit) {
    accountFields.push({
      label: "周限",
      value: formatWeeklyLimit(event.weeklyLimit),
    });
  }
  if (event.goal) {
    sessionFields.push({
      label: "Goal",
      value: `${goalStatusLabel(event.goal.status)} · ${formatGoalTokens(event.goal)}`,
    });
  }
  if (event.timing?.modelRequestCount !== undefined) {
    const recoveredFailureCount = event.status === "completed"
      && (event.timing.completedModelRequestCount ?? 0) > 0
      ? event.timing.retryableFailureModelRequestCount ?? 0
      : 0;
    const unrecoveredFailureCount = Math.max(
      0,
      (event.timing.failedModelRequestCount ?? 0) - recoveredFailureCount,
    );
    const details = [
      ["完成", event.timing.completedModelRequestCount],
      ["中断", event.timing.interruptedModelRequestCount],
      ["未完整观测", event.timing.incompleteModelRequestCount],
      [
        "自动重试",
        recoveredFailureCount,
      ],
      ["失败", unrecoveredFailureCount],
    ]
      .filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && entry[1] > 0
      )
      .map(([label, count]) => `${label} ${count}`)
      .join(" · ");
    runFields.push({
      label: "模型请求",
      value: `${event.timing.modelRequestCount} 次${details ? `（${details}${recoveredFailureCount > 0 ? "，最终成功" : ""}）` : ""}`,
    });
  }
  if (event.timing?.reasoningRequestCount !== undefined) {
    runFields.push({
      label: "思考次数",
      value: `${event.timing.reasoningRequestCount} 次`,
    });
  }
  if (event.timing?.modelRequestDurationMs !== undefined) {
    runFields.push({
      label: "模型请求聚合耗时",
      value: formatElapsedDuration(event.timing.modelRequestDurationMs),
    });
  }
  if (fallbackCacheField) {
    runFields.push(fallbackCacheField);
  }
  if (
    event.timing?.requestInputTokens !== undefined
    && event.timing.requestCachedInputTokens !== undefined
  ) {
    const inputTokens = event.timing.requestInputTokens;
    const cachedInputTokens = event.timing.requestCachedInputTokens;
    const reasoningOutputTokens = event.timing.reasoningTokens ?? 0;
    const outputTokens = (event.timing.nonReasoningOutputTokens ?? 0)
      + reasoningOutputTokens;
    runFields.push({
      title: "Token",
      value: formatTokenCount(inputTokens + outputTokens),
      fields: [
        {
          label: "输入命中缓存",
          value: formatTokenCount(cachedInputTokens),
        },
        {
          label: "输入未命中缓存",
          value: formatTokenCount(Math.max(0, inputTokens - cachedInputTokens)),
        },
        {
          label: "输出",
          value: formatTokenCount(outputTokens),
        },
        ...(reasoningOutputTokens > 0
          ? [{
              label: "其中推理输出",
              value: formatTokenCount(reasoningOutputTokens),
            }]
          : []),
        {
          label: "缓存命中率",
          value: formatCacheHitRate(inputTokens, cachedInputTokens),
        },
      ],
    });
  }
  if (event.timing?.referenceCost) {
    const successfulRequestCount = event.timing.completedModelRequestCount;
    const displayCost = toDisplayReferenceCost(
      event.timing.referenceCost,
      currency,
      exchangeRate ?? null,
    );
    runFields.push({
      title: "费用",
      value: successfulRequestCount !== undefined && successfulRequestCount > 0
        ? formatReferenceCostTotal({
            ...displayCost,
            requestCount: successfulRequestCount,
          }, exchangeRate ?? null)
        : formatReferenceCostTotal(displayCost, exchangeRate ?? null),
      fields: displayCost.currency === null
        ? []
        : ([
            ["输入价格", displayCost.inputCostNanos],
            ["缓存价格", displayCost.cachedInputCostNanos],
            ["输出价格", displayCost.outputCostNanos],
          ] as const).flatMap(([label, costNanos]) =>
            costNanos === null
              ? []
              : [{
                  label,
                  value: formatCostFieldValue(displayCost, costNanos, exchangeRate),
                }],
          ),
    });
  }
  if (
    event.modelProvider === "deepseek"
    && event.timing?.referenceCost
    && event.timing.requestInputTokens !== undefined
  ) {
    const averagePrice = formatDeepseekAveragePriceValue({
      pricingCurrency: event.timing.referenceCost.currency,
      totalCostNanos: event.timing.referenceCost.totalCostNanos,
      pricedRequestCount: event.timing.referenceCost.pricedRequestCount,
      requestCount: event.timing.referenceCost.requestCount,
      inputTokens: event.timing.requestInputTokens,
      outputTokens: (event.timing.nonReasoningOutputTokens ?? 0)
        + (event.timing.reasoningTokens ?? 0),
    }, currency, exchangeRate);
    if (averagePrice !== null) {
      runFields.push({
        label: "均价",
        value: averagePrice,
      });
    }
  }
  if (event.timing?.compact) {
    runFields.push({
      label: "上下文压缩",
      value: formatCompactMetricsValue(
        event.timing.compact,
        currency,
        exchangeRate,
      ),
    });
  }
  const performanceFields: LifecyclePresentationField[] = [];
  if (debug && event.timing?.ttftMs !== undefined) {
    performanceFields.push({
      label: "最后请求首事件延迟",
      value: formatElapsedDuration(event.timing.ttftMs),
    });
  }
  if (event.timing?.firstResponseLatencyMs !== undefined) {
    performanceFields.push({
      label: "首段回复延迟",
      value: formatElapsedDuration(event.timing.firstResponseLatencyMs),
    });
  }
  if (event.timing?.outputTokensPerSecond !== undefined) {
    const speedCoverage = formatSpeedCoverage(
      event.timing.outputSpeedTimedCount,
      event.timing.outputSpeedSampleCount,
    );
    performanceFields.push({
      label: event.timing.modelRequestCount === undefined
        ? "输出速度"
        : "综合输出速度",
      value: `${formatTokensPerSecond(event.timing.outputTokensPerSecond)}（不含推理${speedCoverage}）`,
    });
  }
  if (event.timing?.thinkingTokensPerSecond !== undefined) {
    const speedCoverage = formatSpeedCoverage(
      event.timing.thinkingSpeedTimedCount,
      event.timing.thinkingSpeedSampleCount,
    );
    performanceFields.push({
      label: event.timing.modelRequestCount === undefined
        ? "思考速度"
        : "综合思考速度",
      value: `${formatTokensPerSecond(event.timing.thinkingTokensPerSecond)}（推理${speedCoverage}）`,
    });
  }
  if (event.timing?.generationTokensPerSecond !== undefined) {
    const speedCoverage = formatSpeedCoverage(
      event.timing.generationSpeedTimedCount,
      event.timing.generationSpeedSampleCount,
    );
    performanceFields.push({
      label: event.timing.modelRequestCount === undefined
        ? "生成速度"
        : "综合生成速度",
      value: `${formatTokensPerSecond(event.timing.generationTokensPerSecond)}（含推理${speedCoverage}）`,
    });
  }
  if (event.durationMs !== undefined) {
    performanceFields.push({
      label: "总耗时",
      value: formatElapsedDuration(event.durationMs),
    });
  }
  if (performanceFields.length > 0) {
    runFields.push({ title: "性能", fields: performanceFields });
  }
  if (Object.hasOwn(event, "gitBranch")) {
    sessionFields.push({
      label: "Git 分支",
      value: event.gitBranch ?? "未检测到",
    });
  }
  if (event.sessionReferenceCost) {
    sessionFields.push({
      label: "总价",
      value: formatReferenceCostTotal(
        toDisplayReferenceCost(
          event.sessionReferenceCost,
          currency,
          exchangeRate ?? null,
        ),
        exchangeRate ?? null,
      ),
    });
  }
  if (
    event.modelProvider === "deepseek"
    && event.sessionReferenceCost
    && event.sessionReferenceCost.inputTokens !== undefined
    && event.sessionReferenceCost.outputTokens !== undefined
  ) {
    const averagePrice = formatDeepseekAveragePriceValue({
      pricingCurrency: event.sessionReferenceCost.currency,
      totalCostNanos: event.sessionReferenceCost.totalCostNanos,
      pricedRequestCount: event.sessionReferenceCost.pricedRequestCount,
      requestCount: event.sessionReferenceCost.requestCount,
      inputTokens: event.sessionReferenceCost.inputTokens,
      outputTokens: event.sessionReferenceCost.outputTokens,
    }, currency, exchangeRate);
    if (averagePrice !== null) {
      sessionFields.push({
        label: "均价",
        value: averagePrice,
      });
    }
  }
  const sections = [
    ...(runFields.length > 0
      ? [{ title: "本次运行", fields: runFields }]
      : []),
    ...(sessionFields.length > 0
      ? [{ title: "当前会话累计", fields: sessionFields }]
      : []),
    ...(accountFields.length > 0
      ? [{ title: "账户状态", fields: accountFields }]
      : []),
  ];
  return {
    title: `${event.background ? "后台任务" : "本次运行"} · ${turnStatusLabel(event.status)}`,
    fields: sections.length === 1 ? sections[0]!.fields : [],
    ...(sections.length > 1 ? { sections } : {}),
  };
}

export function renderPlainLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  return [
    presentation.title,
    ...(presentation.fields.length > 0
      ? ["", ...presentation.fields.map(formatField)]
      : []),
    ...(presentation.sections ?? []).flatMap((section) => [
      "",
      `${section.title}：`,
      ...section.fields.map(formatField),
    ]),
  ].join("\n");
}

export function renderStructuredLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  return toStructuredMarkdownList([
    presentation.title,
    ...(presentation.fields.length > 0
      ? ["", ...presentation.fields.map(formatStructuredField)]
      : []),
    ...(presentation.sections ?? []).flatMap((section) => [
      "",
      `${section.title}：`,
      ...section.fields.map(formatStructuredField),
    ]),
  ].join("\n"));
}

function formatStructuredField(field: LifecyclePresentationField): string {
  if ("title" in field) {
    return [
      `- **${field.title}**${field.value === undefined ? "" : `：${field.value}`}`,
      ...field.fields.flatMap((subfield) =>
        formatStructuredField(subfield).split("\n").map((line) => `  ${line}`)),
    ].join("\n");
  }
  return [
    `- ${field.label}：${field.value}`,
    ...(field.subfields ?? []).map((subfield) =>
      `  - ${subfield.label}：${subfield.value}`),
  ].join("\n");
}

function formatField(field: LifecyclePresentationField): string {
  if ("title" in field) {
    return [
      `${field.title}${field.value === undefined ? "" : `：${field.value}`}`,
      ...field.fields.flatMap((subfield) =>
        formatField(subfield).split("\n").map((line) => `  ${line}`)),
    ].join("\n");
  }
  return [
    `${field.label}：${field.value}`,
    ...(field.subfields ?? []).map((subfield) =>
      `  ${subfield.label}：${subfield.value}`),
  ].join("\n");
}

function formatSpeedCoverage(
  timedCount: number | undefined,
  sampleCount: number | undefined,
): string {
  return timedCount === undefined || sampleCount === undefined
    ? ""
    : ` · 覆盖 ${timedCount}/${sampleCount} 次请求`;
}

function pendingSuffix(pending: boolean): string {
  return pending ? "（下一次 Turn 生效）" : "";
}

function platformLabel(platform: NodeJS.Platform): string {
  const labels: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  };
  return labels[platform] ?? platform;
}

function formatUpstreamUserAgent(userAgent: string | null): string {
  if (!userAgent) {
    return "App Server 未返回";
  }
  return userAgent.replace(
    /(\([^)]*\))\s+\S+\s+(\([^)]*\))$/u,
    "$1 $2",
  );
}

function formatWeeklyLimit(
  window: NonNullable<StartupStatus["weeklyLimit"]>,
): string {
  return formatRemainingRateLimitWindow(window, { includeDuration: false });
}

function goalStatusLabel(status: ThreadGoal["status"]): string {
  const labels = {
    active: "进行中",
    paused: "已暂停",
    blocked: "已阻塞",
    usageLimited: "用量受限",
    budgetLimited: "预算已用尽",
    complete: "已完成",
  } as const;
  return labels[status];
}

function formatGoalTokens(goal: ThreadGoal): string {
  return goal.tokenBudget === null
    ? formatTokenCount(goal.tokensUsed)
    : `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)}`;
}

function turnStatusLabel(
  status: Extract<OutputEvent, { type: "turn.completed" }>["status"],
): string {
  const labels = {
    completed: "已完成",
    interrupted: "已停止",
    failed: "失败",
    inProgress: "运行中",
  } as const;
  return labels[status];
}

function formatCostFieldValue(
  displayCost: { currency: string | null },
  costNanos: number,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  const formatted = formatCurrencyNanos(displayCost.currency!, costNanos);
  const equivalent = displayCost.currency === "USD" && exchangeRate
    ? formatCnyEquivalent(costNanos, exchangeRate)
    : null;
  return equivalent === null ? formatted : `${formatted}（${equivalent}）`;
}
