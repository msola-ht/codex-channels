import {
  isFastServiceTier,
  lunaReserveModel,
  type ConversationStatus,
} from "../application/index.js";
import type {
  OutputEvent,
  ResponseUsageSummary,
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
  formatRemainingRateLimitWindow,
} from "./account-format.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import { isAutoApprovalReviewer } from "./conversation-workspace-status-command-format.js";
import {
  formatElapsedDuration,
} from "./elapsed-duration.js";
import {
  formatCodexProviderLabel,
  supportsFastMode,
} from "./provider-format.js";
import {
  formatCompactMetricsValue,
} from "./metrics-format.js";
import { missingFinalResponseText } from "./output-copy.js";
import {
  formatCacheHitRate,
  formatRequestCount,
  formatTokenCount,
} from "./token-format.js";
import gatewayMetadata from "../version.json" with { type: "json" };

export interface LifecyclePresentation {
  title: string;
  fields: readonly LifecyclePresentationField[];
  sections?: readonly LifecyclePresentationSection[];
  footer?: { label: string; value: string };
}

export function isHiddenAutoApprovalReview(event: OutputEvent): boolean {
  return event.type === "autoApprovalReview.updated"
    && (event.phase !== "completed" || event.status === "inProgress");
}

export function createAutoApprovalReviewPresentation(
  event: Extract<OutputEvent, { type: "autoApprovalReview.updated" }>,
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
  debugEnabled?: boolean;
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
  | "threadName"
  | "workspaceId"
  | "model"
  | "modelProvider"
  | "effort"
  | "serviceTier"
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
  return {
    title: "Codex Connect 已上线",
    fields: [
      { label: "App Server", value: "已连接" },
      {
        label: "系统",
        value: `${platformLabel(runtime.platform)} · ${runtime.architecture}`,
      },
      {
        label: "App Server 时区",
        value: runtime.appServerTimezone === undefined
          ? "跟随系统（未配置）"
          : `${runtime.appServerTimezone}（配置）`,
      },
      {
        label: "网关时区",
        value: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      {
        label: "版本",
        value: `Codex Connect ${gatewayMetadata.version} · Codex ${runtime.gatewayVersion}`,
      },
      ...openAiConnectivityFields(runtime.openAiConnectivity),
      ...(runtime.officialOpenAiAuthenticated === false
        ? [{
            label: "OpenAI 官方",
            value: "未登录；请运行 codex login，或发送 /model 选择第三方提供商",
          }]
        : []),
    ],
    sections: [
      ...(runtime.debugEnabled === true
        ? [{
            title: "运行环境",
            fields: [
              {
                label: "Node.js",
                value: runtime.nodeVersion,
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
          {
            label: "Session",
            value: status.threadId ? status.threadName ?? "未命名" : "尚未绑定",
          },
          { label: "Session ID", value: status.threadId ?? "尚未绑定" },
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
          ...(supportsFastMode(status.modelProvider)
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
          ...(isAutoApprovalReviewer(status.approvalsReviewer)
            ? [{ label: "审批方式", value: "自动审批" }]
            : []),
        ],
      },
      ...(usesOpenAiAccount(status.modelProvider) && status.weeklyLimit
        ? [{
            title: "账户状态",
            fields: [{ label: "周限", value: formatWeeklyLimit(status.weeklyLimit) }],
          }]
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
): LifecyclePresentation {
  return {
    title: `子代理开始 · ${subagentTaskName(event.agentPath)}`,
    fields: [
      { label: "提供商", value: event.modelProvider ? formatCodexProviderLabel(event.modelProvider) : "未提供" },
      { label: "模型设置", value: event.model ?? "未提供" },
      { label: "思考强度", value: event.reasoningEffort ?? "未提供" },
    ],
  };
}

export function createSubagentContactedPresentation(
  event: Extract<OutputEvent, { type: "subagent.contacted" }>,
): LifecyclePresentation {
  return {
    title: `子代理继续 · ${subagentTaskName(event.agentPath)}`,
    fields: [
      { label: "提供商", value: event.modelProvider ? formatCodexProviderLabel(event.modelProvider) : "未提供" },
      { label: "模型设置", value: event.model ?? "未提供" },
      { label: "思考强度", value: event.reasoningEffort ?? "未提供" },
    ],
  };
}

export function createSubagentCompletedPresentation(
  event: Extract<OutputEvent, { type: "subagent.completed" }>,
  debug = false,
): LifecyclePresentation {
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
    fields.push({ label: "思考等级", value: event.reasoningEffort });
  }
  if (event.metricsStatus === "unavailable") {
    fields.push({ label: "统计", value: "暂不可用" });
    return {
      title: `${subagentStatusLabel(event.status)} · ${subagentTaskName(event.agentPath)}`,
      fields,
    };
  }
  fields.push({ label: "模型请求", value: `${formatRequestCount(event.requestCount)} 次` });
  const cachedInputTokens = event.cachedInputTokens;
  fields.push({
    title: "Token",
    value: formatTokenCount(event.inputTokens + event.outputTokens),
    fields: debug ? [
      ...(cachedInputTokens === null
        ? [{ label: "输入", value: formatTokenCount(event.inputTokens) }]
        : [
            {
              label: "缓存",
              value: formatTokenCount(cachedInputTokens),
            },
            {
              label: "无缓存",
              value: formatTokenCount(Math.max(0, event.inputTokens - cachedInputTokens)),
            },
          ]),
      { label: "输出", value: formatTokenCount(event.outputTokens) },
      ...(event.reasoningOutputTokens > 0
        ? [{
            label: "其中推理输出",
            value: formatTokenCount(event.reasoningOutputTokens),
          }]
        : []),
      ...(cachedInputTokens === null
        ? []
        : [{
            label: "缓存命中率",
            value: formatCacheHitRate(event.inputTokens, cachedInputTokens),
          }]),
    ] : cachedInputTokens === null ? [] : [{
      label: "缓存命中率",
      value: formatCacheHitRate(event.inputTokens, cachedInputTokens),
    }],
  });
  return {
    title: `${subagentStatusLabel(event.status)} · ${subagentTaskName(event.agentPath)}`,
    fields,
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

export function createTurnCompletedPresentation(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
  debug = false,
  autoCompactPercent?: (
    provider: string | null | undefined,
    model: string | null | undefined,
  ) => number | null,
): LifecyclePresentation {
  const sessionFields: LifecyclePresentationField[] = [
    ...(event.workspaceId
      ? [{
          label: "当前工作区",
          value: event.workspaceName
            ? `${event.workspaceName} (${event.workspaceId})`
            : event.workspaceId,
        }]
      : []),
    { label: "Session", value: event.sessionName ?? "未命名" },
    { label: "Session ID", value: event.threadId },
    ...(isAutoApprovalReviewer(event.approvalsReviewer)
      ? [{ label: "审批方式", value: "自动审批" }]
      : []),
  ];
  const runFields: LifecyclePresentationField[] = [];
  const accountFields: LifecyclePresentationField[] = [];
  let fallbackCacheField: LifecyclePresentationField | undefined;
  if (event.error) {
    runFields.push({
      label: "错误",
      value: formatTurnErrorMessage(
        event.error,
        event.errorCode,
        event.modelProvider,
        event.model,
      ),
    });
  }
  if (event.missingFinalResponse) {
    runFields.push({
      label: "结果",
      value: missingFinalResponseText,
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
      value: supportsFastMode(event.modelProvider)
        ? `${event.model} · ${event.effort ?? "模型默认"} · Fast ${isFastServiceTier(event.serviceTier ?? null) ? "开启" : "关闭"}`
        : `${event.model} · ${event.effort ?? "模型默认"}`,
    });
    runFields.push({
      label: "提供商",
      value: formatCodexProviderLabel(event.modelProvider),
    });
    const autoCompact = autoCompactPercent?.(event.modelProvider, event.model);
    if (autoCompact !== null && autoCompact !== undefined) {
      sessionFields.push({
        label: "自动压缩",
        value: `${autoCompact}%`,
      });
    }
  }
  if (event.contextCompactionCount !== undefined) {
    sessionFields.push({
      label: "上下文压缩",
      value: `${event.contextCompactionCount} 次`,
    });
  }
  let accountHasResetTime = false;
  if (
    usesOpenAiAccount(event.modelProvider)
    && event.weeklyLimit
  ) {
    accountFields.push({
      label: "周限",
      value: formatWeeklyLimit(event.weeklyLimit),
    });
    accountHasResetTime = event.weeklyLimit.resetsAt !== null;
  }
  if (!usesOpenAiAccount(event.modelProvider) && event.accountStatus && event.accountStatus.provider === event.modelProvider) {
    for (const balance of event.accountStatus.balances) {
      accountFields.push({ label: "余额", value: `${balance.currency === "CNY" ? "¥" : "$"}${balance.remaining}` });
    }
    if (event.accountStatus.credits !== undefined) {
      accountFields.push({ label: "剩余额度", value: `$${event.accountStatus.credits}` });
    }
    for (const window of event.accountStatus.windows) {
      accountFields.push({ label: window.label, value: formatRemainingRateLimitWindow({ ...window, windowDurationMins: null }) });
      accountHasResetTime ||= window.resetsAt !== null;
    }
  }
  if (accountHasResetTime) {
    accountFields.unshift({ label: "时区", value: Intl.DateTimeFormat().resolvedOptions().timeZone });
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
  if (event.timing?.reasoningRequestCount !== undefined) {
    runFields.push({
      label: "思考次数",
      value: `${formatRequestCount(event.timing.reasoningRequestCount)} 次`,
    });
  }
  if (fallbackCacheField) {
    runFields.push(fallbackCacheField);
  }
  if (
    event.timing?.requestInputTokens !== undefined
  ) {
    const inputTokens = event.timing.requestInputTokens;
    const cachedInputTokens = event.timing.requestCachedInputTokens;
    const reasoningOutputTokens = event.timing.reasoningTokens ?? 0;
    const outputTokens = event.timing.requestOutputTokens
      ?? (event.timing.nonReasoningOutputTokens ?? 0) + reasoningOutputTokens;
    runFields.push({
      title: "Token",
      value: formatTokenCount(inputTokens + outputTokens),
      fields: debug ? [
        ...(cachedInputTokens === undefined
          ? [{ label: "输入", value: formatTokenCount(inputTokens) }]
          : [
              {
                label: "缓存",
                value: formatTokenCount(cachedInputTokens),
              },
              {
                label: "无缓存",
                value: formatTokenCount(Math.max(0, inputTokens - cachedInputTokens)),
              },
            ]),
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
        ...(cachedInputTokens === undefined
          ? []
          : [{
              label: "缓存命中率",
              value: formatCacheHitRate(inputTokens, cachedInputTokens),
            }]),
      ] : cachedInputTokens === undefined ? [] : [{
        label: "缓存命中率",
        value: formatCacheHitRate(inputTokens, cachedInputTokens),
      }],
    });
  }
  if (event.timing?.responseUsage?.amount != null) {
    runFields.push({ label: "OpenAI Credits", value: formatResponseUsage(event.timing?.responseUsage) });
  }
  if (event.timing?.compact) {
    runFields.push({
      label: "上下文压缩",
      value: formatCompactMetricsValue(
        event.timing.compact,
        { concise: !debug, currentModel: event.model },
      ),
    });
  }
  runFields.push({
    title: "本轮耗时",
    value: event.durationMs === undefined ? "未提供" : formatElapsedDuration(event.durationMs),
    fields: performanceFields(event.timing?.performance),
  });
  if (isAutoApprovalReviewer(event.approvalsReviewer) && event.autoApprovalReview) {
    runFields.push(autoApprovalReviewField(event.autoApprovalReview));
  }
  if (isAutoApprovalReviewer(event.approvalsReviewer) && event.sessionAutoApprovalReview) {
    sessionFields.push(autoApprovalReviewField(event.sessionAutoApprovalReview));
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
        value: formatTokenCount(task.inputTokens + task.outputTokens),
        fields: debug ? [
          ...(task.cachedInputTokens === null
            ? [{ label: "输入", value: formatTokenCount(task.inputTokens) }]
            : [
                {
                  label: "缓存",
                  value: formatTokenCount(task.cachedInputTokens),
                },
                {
                  label: "无缓存",
                  value: formatTokenCount(
                    Math.max(0, task.inputTokens - task.cachedInputTokens),
                  ),
                },
              ]),
          { label: "输出", value: formatTokenCount(task.outputTokens) },
          ...(task.reasoningOutputTokens > 0
            ? [{
                label: "其中推理输出",
                value: formatTokenCount(task.reasoningOutputTokens),
              }]
            : []),
          ...(task.cachedInputTokens === null
            ? []
            : [{
                label: "缓存命中率",
                value: formatCacheHitRate(task.inputTokens, task.cachedInputTokens),
              }]),
        ] : task.cachedInputTokens === null ? [] : [{
          label: "缓存命中率",
          value: formatCacheHitRate(task.inputTokens, task.cachedInputTokens),
        }],
      },
    ];
    if (task.responseUsage?.amount != null) taskFields.push({ label: "OpenAI Credits", value: formatResponseUsage(task.responseUsage) });
    runFields.push({ title: "任务合计（含子代理）", fields: taskFields });
  }
  if (Object.hasOwn(event, "gitBranch")) {
    sessionFields.push({
      label: "Git 分支",
      value: event.gitBranch ?? "未检测到",
    });
  }
  if (event.sessionAggregate) {
    const session = event.sessionAggregate;
    sessionFields.push({
      label: "模型请求",
      value: `${formatRequestCount(session.requestCount)} 次`,
    });
    sessionFields.push(...requestOutcomeFields(session));
    sessionFields.push({
      title: "Token",
      value: formatTokenCount(session.inputTokens + session.outputTokens),
      fields: [
        ...(session.cachedInputTokens === null ? [] : [{
            label: "缓存命中率",
            value: formatCacheHitRate(session.inputTokens, session.cachedInputTokens),
          }]),
      ],
    });
  }
  if (event.sessionAggregate?.responseUsage?.amount != null) {
    sessionFields.push({ label: "OpenAI Credits", value: formatResponseUsage(event.sessionAggregate?.responseUsage) });
  }
  if (event.sessionAggregate?.compact) {
    sessionFields.push({
      label: "压缩请求",
      value: formatCompactMetricsValue(event.sessionAggregate.compact, { concise: !debug, currentModel: event.model }),
    });
  }
  sessionFields.push({
    title: "总耗时",
    value: formatSessionExecutionTiming(event),
    fields: event.sessionAggregate ? performanceFields(event.sessionAggregate.performance) : [],
  });
  const sections = [
    ...(sessionFields.length > 0
      ? [{ title: "当前会话", fields: sessionFields }]
      : []),
    ...(accountFields.length > 0
      ? [{ title: "账户状态", fields: accountFields }]
      : []),
  ];
  return {
    title: `${event.background ? "后台任务" : "本次运行"} · ${event.missingFinalResponse ? "无最终回复" : turnStatusLabel(event.status)}`,
    fields: runFields,
    ...(sections.length > 0 ? { sections } : {}),
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
    value: review.coverage === "complete"
      ? `${review.total} 次（含子代理）`
      : review.coverage === "partial"
        ? `已记录 ${review.total} 次（含子代理）`
        : review.total > 0
          ? `至少 ${review.total} 次（含子代理）`
          : "未知（含子代理）",
    subfields: outcomes.filter(([, count]) => count > 0).map(([label, count]) => ({ label, value: `${count} 次` })),
  };
}

export function renderStructuredLifecyclePresentation(
  presentation: LifecyclePresentation,
  escapeLiterals = true,
): string {
  return toStructuredMarkdownList([
    presentation.title,
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

function escapeLifecycleLiteral(value: string): string {
  return value.replace(/[\\`*_~[\]()<>#+\-.!|{}]/gu, "\\$&");
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

function performanceFields(
  performance: TurnTaskMetricsSummary["performance"],
): LifecyclePresentationField[] {
  return [
    { label: "首 Token", value: performance?.averageFirstTokenMs == null ? "—"
      : formatElapsedDuration(performance.averageFirstTokenMs) },
    { label: "速度", value: performance?.generationTokensPerSecond == null ? "—"
      : `${performance.generationTokensPerSecond.toFixed(1)} /s` },
  ];
}

function requestOutcomeFields(summary: TurnTaskMetricsSummary): LifecyclePresentationField[] {
  const { completed, interrupted, failed, incomplete } = summary.requestOutcomes;
  return [{
    label: "请求结果",
    value: `完成 ${formatRequestCount(completed)} · 中断 ${formatRequestCount(interrupted)} · 失败 ${formatRequestCount(failed)} · 不完整 ${formatRequestCount(incomplete)}`,
  }];
}

function formatResponseUsage(usage: ResponseUsageSummary | null | undefined): string {
  if (!usage || usage.amount === null) return "未提供";
  if (usage.missingRequestCount > 0) return `${usage.amount}（部分，${usage.missingRequestCount} 次请求未提供）`;
  return usage.amount;
}

function formatSessionExecutionTiming(event: Extract<OutputEvent, { type: "turn.completed" }>): string {
  const timing = event.sessionTiming;
  if (!timing) return event.sessionDurationMs === undefined ? "未提供" : formatElapsedDuration(event.sessionDurationMs);
  const incomplete = !timing.historyComplete || timing.missingTurnCount > 0;
  const value = timing.knownDurationMs === null ? "未提供"
    : `${incomplete ? "已知累计 " : ""}${formatElapsedDuration(timing.knownDurationMs)}`;
  const notes = [
    ...(timing.missingTurnCount > 0 ? [`${timing.missingTurnCount} 轮耗时缺失`] : []),
    ...(!timing.historyComplete ? ["历史未补齐"] : []),
  ];
  return notes.length === 0 ? value : `${value}（${notes.join("；")}）`;
}
