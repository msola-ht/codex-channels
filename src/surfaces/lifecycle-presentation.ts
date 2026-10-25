import {
  lunaReserveModel,
  type ConversationStatus,
} from "../application/index.js";
import type {
  OutputEvent,
  ThreadGoal,
  ThreadApprovalsReviewer,
  TurnErrorCode,
  TurnStartIdentity,
  TurnTaskMetricsSummary,
} from "../conversation-core/index.js";
import { usesOpenAiAccount } from "../conversation-core/index.js";

import {
  formatOpenAiErrorMessage,
  formatPercent,
} from "./account-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import { isAutoApprovalReviewer, formatThreadApprovalsReviewer } from "./conversation-workspace-status-command-format.js";
import {
  formatElapsedDuration,
} from "./elapsed-duration.js";
import {
  formatCodexProviderLabel,
  formatServiceTier,
  formatServiceTierSetting,
} from "./provider-format.js";
import { missingFinalResponseText } from "./output-copy.js";
import { compactOperationDetail } from "./operation-presentation.js";
import { formatReasoningEffort, reasoningEffortSettingName } from "./reasoning-effort-format.js";
import {
  formatCacheHitRate,
  formatObservedTotal,
  formatRequestCount,
  formatTokenCount,
} from "./token-format.js";
import gatewayMetadata from "../version.json" with { type: "json" };

export interface LifecyclePresentation {
  title: string;
  titleStyle?: "emphasis";
  titleDetail?: string;
  fields: readonly LifecyclePresentationField[];
  sections?: readonly LifecyclePresentationSection[];
  footer?: { label: string; value: string };
}

export function isHiddenAutoApprovalReview(event: OutputEvent): boolean {
  return event.type === "autoApprovalReview.updated"
    && (event.phase !== "completed" || event.status === "inProgress");
}

export function createHookCompletedPresentation(
  event: Extract<OutputEvent, { type: "hook.completed" }>,
): LifecyclePresentation {
  const status = { completed: "已完成", failed: "执行失败", blocked: "已阻断", stopped: "已停止" }[event.hook.status];
  return {
    title: `Codex Hook · ${status}`,
    fields: [
      { label: "触发事件", value: event.hook.eventName, literal: true },
      ...(event.background ? [{ label: "任务", value: `后台任务 · ${event.threadId.slice(0, 12)}` }] : []),
    ],
  };
}

export function createAutoApprovalReviewPresentation(
  event: Extract<OutputEvent, { type: "autoApprovalReview.updated" }>,
  detailed = true,
): LifecyclePresentation | null {
  if (isHiddenAutoApprovalReview(event)) return null;
  const status = {
    inProgress: "审查中",
    approved: "已通过",
    denied: "已拒绝",
    timedOut: "已超时",
    aborted: "已中止",
  }[event.status];
  const details = event.details;
  const action = details?.action;
  const actionLabels = {
    command: "执行命令",
    execve: "启动程序",
    writeStdin: "向运行中的命令输入内容",
    applyPatch: "修改文件",
    networkAccess: "访问网络",
    mcpToolCall: "调用 MCP 工具",
    requestPermissions: "申请额外权限",
  } as const;
  if (event.status === "approved") {
    return {
      title: `自动审批 · ${status}`,
      fields: [
        ...(action ? [{ label: "审查内容", value: actionLabels[action.kind] }] : []),
        ...(detailed && details?.operation ? [{ label: "操作摘要", value: compactOperationDetail(details.operation), literal: true }] : []),
        ...(detailed && details?.rationale ? [{ label: "审查理由摘要", value: compactOperationDetail(details.rationale), literal: true }] : []),
        ...(event.sourceThreadId !== event.threadId ? [{ label: "来源", value: "子代理" }] : []),
        ...(event.background ? [{ label: "任务", value: `后台任务 · ${event.threadId.slice(0, 12)}` }] : []),
      ],
    };
  }
  return {
    title: "自动审批完成",
    fields: [
      { label: "状态", value: status },
      ...(action ? [{ label: "审查内容", value: actionLabels[action.kind] }] : []),
      ...(action?.kind === "applyPatch" && action.fileCount !== undefined
        ? [{ label: "涉及文件", value: `${action.fileCount} 个` }]
        : []),
      ...(action?.kind === "networkAccess" && action.protocol
        ? [{ label: "网络协议", value: { http: "HTTP", https: "HTTPS", socks5Tcp: "SOCKS5 TCP", socks5Udp: "SOCKS5 UDP" }[action.protocol] }]
        : []),
      ...(action?.kind === "networkAccess" && action.port !== undefined
        ? [{ label: "目标端口", value: String(action.port) }]
        : []),
      ...(details?.operation ? [{ label: "操作详情", value: details.operation, literal: true }] : []),
      ...(details?.cwd ? [{ label: "工作目录", value: details.cwd, literal: true }] : []),
      ...(details?.rationale ? [{ label: "审查理由", value: details.rationale, literal: true }] : []),
      ...(details?.durationMs !== undefined ? [{ label: "审查耗时", value: formatElapsedDuration(details.durationMs) }] : []),
      ...(event.sourceThreadId !== event.threadId ? [{ label: "来源", value: "子代理" }] : []),
      ...(event.background ? [{ label: "任务", value: `后台任务 · ${event.threadId.slice(0, 12)}` }] : []),
    ],
  };
}

export interface LifecyclePresentationLeafField {
  label: string;
  value: string;
  /** Preserve text in plain output; escape formatting only for Markdown surfaces. */
  literal?: boolean;
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
  appServerTimezone?: string;
  gatewayVersion: string;
  nodeVersion: string;
  transport: string;
  codexUpstreamUserAgent: string | null;
  presentationDetail?: "basic" | "detailed";
  displayPreset?: "concise" | "standard" | "detailed" | "custom";
  /** 官方主路由是否已有 Codex 鉴权；`undefined` 表示当前未使用官方主路由。 */
  officialOpenAiAuthenticated?: boolean;
  openAiConnectivity?:
    | "recovering"
    | "reachable"
    | "route-warning"
    | "temporarily-unavailable"
    | "invalid-base-url"
    | "indeterminate"
    | "unreachable"
    | "not-applicable";
}

type StartupStatus = Pick<
  ConversationStatus,
  | "threadId"
  | "sessionRestoring"
  | "threadName"
  | "workspaceId"
  | "model"
  | "modelProvider"
  | "effort"
  | "serviceTier"
  | "serviceTierKnown"
  | "effectiveServiceTier"
  | "approvalsReviewer"
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
  const detailed = runtime.presentationDetail === "detailed";
  return {
    title: "Codex Connect 已上线",
    titleStyle: "emphasis",
    fields: [
      { label: "App Server", value: "已连接" },
      { label: "版本", value: `Codex Connect ${gatewayMetadata.version} · Codex ${runtime.gatewayVersion}` },
      ...(detailed || runtime.displayPreset === "standard" ? [
        { label: "工作区", value: workspace.name, literal: true },
        ...(detailed ? [{ label: "工作目录", value: workspace.cwd, literal: true }] : []),
        { label: "会话", value: status.threadId ? status.threadName ?? "未命名" : "当前未绑定会话", literal: true },
        ...(detailed && status.threadId ? [{ label: "Session ID", value: status.threadId, literal: true }] : []),
        ...(status.threadId && !status.sessionRestoring ? [
          { label: "模型", value: `${status.model}${pendingSuffix(status.modelPending)} · ${formatCodexProviderLabel(status.modelProvider)}`, literal: true },
          { label: "思考", value: `${formatReasoningEffort(status.effort)}${pendingSuffix(status.effortPending)} · 速度：${formatServiceTierSetting(status)}`, literal: true },
          { label: "审批", value: formatThreadApprovalsReviewer(status.approvalsReviewer) },
          ...(detailed ? [{ label: "协作模式", value: `${status.collaborationMode === "plan" ? "Plan" : "Default"}${pendingSuffix(status.collaborationModePending)}` }] : []),
        ] : status.sessionRestoring ? [{ label: "会话状态", value: "尚未恢复" }] : []),
        ...(runtime.displayPreset === "standard" ? [{ label: "显示", value: "紧凑模式" }]
          : runtime.displayPreset === "detailed" ? [{ label: "显示", value: "详细模式" }]
          : runtime.displayPreset === "custom" ? [{ label: "显示", value: "自定义模式" }] : []),
      ].map(field => ({ ...field, value: field.value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ") })) : []),
      ...openAiConnectivityFields(runtime.openAiConnectivity),
      ...(runtime.officialOpenAiAuthenticated === false
        ? [{ label: "OpenAI 官方", value: "未登录；请运行 codex login，或发送 /model 选择第三方提供商" }]
        : []),
    ],
  };
}

function openAiConnectivityFields(
  status: StartupRuntimeInfo["openAiConnectivity"],
): LifecyclePresentationLeafField[] {
  switch (status) {
    case "recovering":
      return [{ label: "OpenAI 网络", value: "暂不可达；正在后台复检" }];
    case "unreachable":
      return [{ label: "OpenAI 网络", value: "暂不可达；请检查网络或代理状态" }];
    case "invalid-base-url":
      return [{ label: "OpenAI 网络", value: "Base URL 路径无效；请检查配置" }];
    case "route-warning":
      return [{ label: "OpenAI 网络", value: "线路响应异常；请检查 Gateway 日志与 OpenAI Base URL" }];
    case "temporarily-unavailable":
      return [{ label: "OpenAI 网络", value: "线路暂时不可用；请稍后重试" }];
    case "indeterminate":
      return [{ label: "OpenAI 网络", value: "检测失败；请检查 App Server 连接与 Gateway 日志" }];
    case "reachable":
    case "not-applicable":
    case undefined:
      return [];
  }
}

export function createTurnStartedPresentation(
  backgroundThreadId?: string,
  identity?: TurnStartIdentity,
  approvalsReviewer?: ThreadApprovalsReviewer | null,
): LifecyclePresentation {
  return {
    title: identity
      ? turnStartIdentityTitle(identity)
      : backgroundThreadId
        ? "后台任务继续处理中。"
        : "已开始处理。",
    fields: [
      ...(backgroundThreadId ? [{ label: "Session ID", value: backgroundThreadId }] : []),
      ...(isAutoApprovalReviewer(approvalsReviewer)
        ? [{ label: "审批方式", value: "自动审批" }]
        : []),
    ],
  };
}

export function createTurnReasoningPresentation(
  backgroundThreadId?: string,
  elapsedMs?: number,
  completed = false,
): LifecyclePresentation {
  return {
    title: completed ? "思考完成" : "思考中…",
    fields: backgroundThreadId
      ? [{ label: "Session ID", value: backgroundThreadId }]
      : [],
    ...(elapsedMs === undefined || (elapsedMs < 1_000 && !completed)
      ? {}
      : { footer: { label: "耗时", value: formatElapsedDuration(elapsedMs) } }),
  };
}

function turnStartIdentityTitle(identity: TurnStartIdentity): string {
  return `已使用 ${formatTurnStartIdentityLabel(identity)} 开始处理。`;
}

export function formatTurnStartIdentityLabel(
  identity: TurnStartIdentity,
): string {
  switch (identity.kind) {
    case "skill":
      return `${identity.name} Skill`;
    case "plugin":
      return `${identity.name} Plugin`;
    case "agent":
      return `${identity.name} 子代理`;
  }
}

export function createSubagentStartedPresentation(
  event: Extract<OutputEvent, { type: "subagent.spawned" }>,
  detailed = true,
): LifecyclePresentation {
  return {
    title: detailed ? `子代理开始 · ${subagentTaskName(event.agentPath)}` : "子代理开始",
    ...(!detailed ? { titleDetail: subagentTaskName(event.agentPath) } : {}),
    fields: detailed ? [
      { label: "提供商", value: event.modelProvider ? formatCodexProviderLabel(event.modelProvider) : "未提供" },
      { label: "模型设置", value: event.model || "未提供" },
      { label: reasoningEffortSettingName(event.reasoningEffort), value: formatReasoningEffort(event.reasoningEffort, "未提供") },
    ] : [],
  };
}

export function createSubagentContactedPresentation(
  event: Extract<OutputEvent, { type: "subagent.contacted" }>,
  detailed = true,
): LifecyclePresentation {
  return {
    title: detailed ? `子代理继续 · ${subagentTaskName(event.agentPath)}` : "子代理继续",
    ...(!detailed ? { titleDetail: subagentTaskName(event.agentPath) } : {}),
    fields: detailed ? [
      { label: "提供商", value: event.modelProvider ? formatCodexProviderLabel(event.modelProvider) : "未提供" },
      { label: "模型设置", value: event.model || "未提供" },
      { label: reasoningEffortSettingName(event.reasoningEffort), value: formatReasoningEffort(event.reasoningEffort, "未提供") },
    ] : [],
  };
}

export function createSubagentCompletedPresentation(
  event: Extract<OutputEvent, { type: "subagent.completed" }>,
  detailed = false,
): LifecyclePresentation {
  if (!detailed) {
    return { title: subagentStatusLabel(event.status), titleDetail: subagentTaskName(event.agentPath), fields: [] };
  }
  const fields: LifecyclePresentationField[] = [];
  if (event.model) {
    fields.push({ label: "模型", value: event.model });
  }
  if (event.modelProvider) {
    fields.push({
      label: "提供商",
      value: formatCodexProviderLabel(event.modelProvider),
    });
  }
  if (event.reasoningEffort) {
    fields.push({ label: reasoningEffortSettingName(event.reasoningEffort), value: formatReasoningEffort(event.reasoningEffort) });
  }
  fields.push({ label: "模型请求", value: `${formatRequestCount(event.requestCount)} 次` });
  const cachedInputTokens = event.cachedInputTokens;
  fields.push({
    title: "Token",
    value: formatObservedTotal(event),
    fields: cachedInputTokens === null ? [] : [{
      label: "缓存命中率",
      value: formatCacheHitRate(event.inputTokens, cachedInputTokens),
    }],
  });
  return {
    title: `${subagentStatusLabel(event.status)} · ${subagentTaskName(event.agentPath)}`,
    fields: visibleCompletionStatistics(fields),
  };
}

function subagentStatusLabel(
  status: Extract<OutputEvent, { type: "subagent.completed" }>["status"],
): string {
  switch (status) {
    case "completed": return "子代理完成";
    case "errored": return "子代理失败";
    case "interrupted": return "子代理中断";
    case "shutdown": return "子代理已关闭";
    case "notFound": return "子代理未找到";
  }
}

function subagentTaskName(agentPath: string): string {
  const normalized = agentPath.replace(/\/+$/u, "");
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return separator >= 0 ? normalized.slice(separator + 1) : normalized;
}

function formatTurnErrorMessage(
  value: string,
  errorCode?: TurnErrorCode,
  modelProvider?: string,
  model?: string,
): string {
  if (errorCode === "misalignmentPolicyViolation") {
    return "请求因安全策略不一致而终止，请调整请求内容或目标后重试。";
  }
  if (errorCode === "usageLimitExceeded" && usesOpenAiAccount(modelProvider)) {
    if (model === lunaReserveModel) {
      return "Luna Reserve 用量已用尽。";
    }
    return "OpenAI 普通用量已用尽。";
  }
  if (errorCode === "unauthorized") {
    return usesOpenAiAccount(modelProvider)
      ? "OpenAI 官方登录已失效，请运行 codex login；或发送 /model 选择第三方提供商后重试。"
      : "当前提供商凭据已失效，请通过 codexc setup 更新对应 Provider 的密钥或账户后重试。";
  }
  return formatOpenAiErrorMessage(value);
}

function formatCompletedServiceTier(event: Extract<OutputEvent, { type: "turn.completed" }>): string {
  // Request tier is the display contract. A priority request may return default;
  // never use response service_tier to replace or fill missing request evidence.
  const summary = event.timing?.serviceTierSummary;
  // Retained events may have a confirmed snapshot but predate tier metrics.
  if (!summary || summary.requested.observedCount === 0) {
    return event.serviceTier === undefined
      ? "未知（请求档位未观测）"
      : `${formatServiceTier(event.serviceTier)}（设置快照）`;
  }
  const { requestCount, requested } = summary;
  // Once observations exist, never fill partial/mixed evidence with the snapshot.
  if (requested.distinctCount > 1) return "多档位（请求档位）";
  if (requestCount > 0 && requested.observedCount === requestCount && requested.value !== null) {
    return formatServiceTier(requested.value);
  }
  return "未知（请求档位未完整观测）";
}

/** Only an ordinary successful completion may suppress its separate notification. */
export function shouldHideTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
  display: "off" | "brief" | "detailed",
): boolean {
  return display === "off" && event.status === "completed" && !event.error
    && !event.errorCode && !event.missingFinalResponse;
}

export function createTurnCompletedPresentation(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
  detailed = false,
  mode: "brief" | "detailed" = "detailed",
): LifecyclePresentation {
  const literal = (value: string): string => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
  const usage = event.tokenUsage;
  const capacity = usage?.modelContextWindow;
  const contextUsage = usage
    ? capacity == null || capacity <= 0
      ? formatTokenCount(usage.last.totalTokens)
      : `${formatTokenCount(usage.last.totalTokens)} / ${formatTokenCount(capacity)}（${formatPercent(Math.max(0, usage.last.totalTokens / capacity * 100))}）`
    : "暂不可用";
  if (mode === "brief" || !detailed) {
    return {
      title: `${event.background ? "后台任务" : "本次运行"} · ${turnStatusLabel(event.status)}`,
      titleStyle: "emphasis",
      fields: [
        { label: "上下文", value: usage && (capacity == null || capacity <= 0)
          ? `${contextUsage}（窗口上限未知）` : contextUsage },
        ...(mode !== "brief" && event.durationMs !== undefined
          ? [{ label: "耗时", value: formatElapsedDuration(event.durationMs) }] : []),
        ...(event.background ? [{ label: "任务", value: literal(event.threadId), literal: true }] : []),
        ...(event.error ? [{ label: "错误", value: literal(formatTurnErrorMessage(event.error, event.errorCode, event.modelProvider, event.model)), literal: true }] : []),
        ...(!event.error && event.errorCode ? [{ label: "错误码", value: event.errorCode, literal: true }] : []),
        ...(event.missingFinalResponse ? [{ label: "结果", value: missingFinalResponseText }] : []),
        ...((event.runningSubagentCount ?? 0) > 0 ? [{ label: "后台子代理", value: `${event.runningSubagentCount} 个尚未结束` }] : []),
      ],
    };
  }
  const runFields: LifecyclePresentationField[] = [];
  if (event.background) runFields.push({ label: "任务", value: literal(event.threadId), literal: true });
  if (event.error) {
    runFields.push({
      label: "错误",
      value: literal(formatTurnErrorMessage(
        event.error,
        event.errorCode,
        event.modelProvider,
        event.model,
      )),
      literal: true,
    });
  }
  if (!event.error && event.errorCode) {
    runFields.push({ label: "错误码", value: event.errorCode, literal: true });
  }
  if (event.missingFinalResponse) {
    runFields.push({
      label: "结果",
      value: missingFinalResponseText,
    });
  }
  if (event.model) {
    runFields.push({
      label: "模型",
      value: literal(`${event.model} · ${formatCodexProviderLabel(event.modelProvider)}`),
      literal: true,
    });
    runFields.push(
      { label: reasoningEffortSettingName(event.effort), value: formatReasoningEffort(event.effort) },
      { label: "速度档位", value: formatCompletedServiceTier(event) },
    );
  }
  runFields.push({ label: "上下文", value: usage && (capacity == null || capacity <= 0)
    ? `${contextUsage}（窗口上限未知）` : contextUsage });
  if ((event.contextCompactionCount ?? 0) > 0) runFields.push({ label: "上下文压缩", value: `${event.contextCompactionCount} 次` });
  if (event.goal) {
    runFields.push({
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
      ["不完整", event.timing.incompleteModelRequestCount],
      [
        "自动重试",
        recoveredFailureCount,
      ],
      ["失败", unrecoveredFailureCount],
    ]
      .filter((entry): entry is [string, number] =>
        typeof entry[1] === "number" && entry[1] > 0
      )
      .map(([label, count]) => `${label} ${formatRequestCount(count)}`)
      .join(" · ");
    runFields.push({
      label: "模型请求",
      value: `${formatRequestCount(event.timing.modelRequestCount)} 次${details ? `（${details}${recoveredFailureCount > 0 ? "，最终成功" : ""}）` : ""}`,
    });
  }
  if (
    event.timing?.modelRequestCount !== undefined
    && event.timing.requestInputTokens !== undefined
    && event.timing.requestOutputTokens !== undefined
  ) {
    const inputTokens = event.timing.requestInputTokens;
    const cachedInputTokens = event.timing.requestCachedInputTokens;
    const outputTokens = event.timing.requestOutputTokens;
    runFields.push({
      title: "Token",
      value: formatObservedTotal({ inputTokens, outputTokens }),
      fields: cachedInputTokens === undefined ? [] : [{
        label: "缓存命中率",
        value: formatCacheHitRate(inputTokens, cachedInputTokens),
      }],
    });
  }
  runFields.push({
    label: "本轮耗时",
    value: event.durationMs === undefined ? "未提供" : formatElapsedDuration(event.durationMs),
  });
  if (event.runningSubagentCount !== undefined && event.runningSubagentCount > 0) {
    runFields.push({ label: "后台子代理", value: `${event.runningSubagentCount} 个尚未结束` });
  }
  const hasRunReviews = isAutoApprovalReviewer(event.approvalsReviewer) && (event.autoApprovalReview?.total ?? 0) > 0;
  if (hasRunReviews && event.autoApprovalReview) {
    runFields.push(autoApprovalReviewField(event.autoApprovalReview));
  }
  if (event.taskAggregate) {
    const task = event.taskAggregate;
    const taskFields: LifecyclePresentationField[] = [
      {
        label: "模型请求",
        value: `${formatRequestCount(task.requestCount)} 次`,
      },
      ...requestOutcomeFields(task),
      {
        title: "Token",
        value: formatObservedTotal(task),
        fields: task.cachedInputTokens === null ? [] : [{
          label: "缓存命中率",
          value: formatCacheHitRate(task.inputTokens, task.cachedInputTokens),
        }],
      },
    ];
    runFields.push({ title: "任务合计（含子代理）", fields: taskFields });
  }
  return {
    title: `${event.background ? "后台任务" : "本次运行"} · ${event.missingFinalResponse ? "无最终回复" : turnStatusLabel(event.status)}`,
    titleStyle: "emphasis",
    fields: visibleCompletionStatistics(runFields),
  };
}

/** Only completion statistics are optional; identity, configuration and error fields retain their semantics. */
function visibleCompletionStatistics(fields: readonly LifecyclePresentationField[]): LifecyclePresentationField[] {
  const statistics = new Set([
    "Token", "输入", "输出", "缓存", "无缓存", "其中推理输出", "模型请求", "推理次数",
    "缓存命中率", "最近请求缓存命中率", "本轮耗时", "总耗时", "首 Token", "速度",
    "OpenAI Credits", "压缩请求", "上下文压缩",
  ]);
  const hasValue = (label: string, value: string | undefined): boolean => !statistics.has(label)
    || (value !== undefined && !["", "—", "未知", "未提供", "统计查询超时", "统计查询失败", "统计暂未就绪"].includes(value)
      && Number.parseFloat(value) !== 0);
  const leaf = (field: LifecyclePresentationLeafField): LifecyclePresentationLeafField[] => hasValue(field.label, field.value)
    ? [{ ...field, ...(field.subfields ? { subfields: field.subfields.flatMap(leaf) } : {}) }] : [];
  return fields.flatMap((field): LifecyclePresentationField[] => {
    if (!("title" in field)) return leaf(field);
    const children = visibleCompletionStatistics(field.fields);
    if (!hasValue(field.title, field.value)) return children;
    if (field.value === undefined && children.length === 0) return [];
    return [{ ...field, fields: children }];
  });
}

export function renderPlainLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  return [
    presentation.titleDetail === undefined ? presentation.title : `${presentation.title} · ${presentation.titleDetail}`,
    ...(presentation.fields.length > 0
      ? ["", ...presentation.fields.map(formatField)]
      : []),
    ...(presentation.sections ?? []).flatMap((section) => [
      "",
      `${section.title}：`,
      ...section.fields.map(formatField),
    ]),
    ...(presentation.footer
      ? ["", `${presentation.footer.label}：${presentation.footer.value}`]
      : []),
  ].join("\n");
}

function autoApprovalReviewField(
  review: NonNullable<Extract<OutputEvent, { type: "turn.completed" }>["autoApprovalReview"]>,
): LifecyclePresentationField {
  const outcomes = [
    ["通过", review.approved], ["拒绝", review.denied], ["超时", review.timedOut],
    ["中止", review.aborted], ["进行中", review.inProgress], ["结果未知", review.unknown],
  ] as const;
  return {
    label: "自动审批",
    value: [`请求 ${review.total}`, ...outcomes.filter(([, count]) => count > 0)
      .map(([label, count]) => `${label} ${count}`)].join(" · "),
    subfields: [
      ...(review.usage === undefined ? [] : [{
        label: "Token",
        value: formatTokenCount((review.usage.inputTokens ?? 0) + (review.usage.outputTokens ?? 0)),
      }]),
    ],
  };
}

export function renderStructuredLifecyclePresentation(
  presentation: LifecyclePresentation,
  escapeLiterals = true,
): string {
  return toStructuredMarkdownList([
    presentation.titleDetail === undefined ? (presentation.titleStyle === "emphasis" ? `**${presentation.title}**` : presentation.title)
      : `**${presentation.title}** · ${escapeLiterals ? escapeLifecycleLiteral(presentation.titleDetail) : presentation.titleDetail}`,
    ...(presentation.fields.length > 0
      ? ["", ...presentation.fields.map((field) => formatStructuredField(field, escapeLiterals))]
      : []),
    ...(presentation.sections ?? []).flatMap((section) => [
      "",
      `${section.title}：`,
      ...section.fields.map((field) => formatStructuredField(field, escapeLiterals)),
    ]),
  ].join("\n"));
}

function formatStructuredField(field: LifecyclePresentationField, escapeLiterals: boolean): string {
  if ("title" in field) {
    return [
      `- **${field.title}**${field.value === undefined ? "" : `：${field.value}`}`,
      ...field.fields.flatMap((subfield) =>
        formatStructuredField(subfield, escapeLiterals).split("\n").map((line) => `  ${line}`)),
    ].join("\n");
  }
  return [
    `- ${field.label}：${field.literal && escapeLiterals ? escapeLifecycleLiteral(field.value) : field.value}`,
    ...(field.subfields ?? []).map((subfield) =>
      `  - ${subfield.label}：${subfield.value}`),
  ].join("\n");
}

export function escapeLifecycleLiteral(value: string): string {
  // Parentheses are literal without an unescaped link label. Escaping them
  // creates \(…\) math delimiters in Markdown clients such as QQ.
  return value.replace(/[\\`*_~[\]<>#+\-.!|{}]/gu, "\\$&");
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

function pendingSuffix(pending: boolean): string {
  return pending ? "（下一次 Turn 生效）" : "";
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

function requestOutcomeFields(summary: TurnTaskMetricsSummary): LifecyclePresentationField[] {
  const { completed, interrupted, failed, incomplete } = summary.requestOutcomes;
  const value = ([["完成", completed], ["中断", interrupted], ["失败", failed], ["不完整", incomplete]] as const)
    .filter(([, count]) => count > 0).map(([label, count]) => `${label} ${formatRequestCount(count)}`).join(" · ");
  return value ? [{ label: "请求结果", value }] : [];
}
