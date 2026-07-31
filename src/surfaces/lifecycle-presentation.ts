import {
  isFastServiceTier,
  type ConversationStatus,
} from "../application/index.js";
import type {
  OutputEvent,
  ThreadGoal,
} from "../conversation-core/index.js";
import { usesOpenAiAccount } from "../conversation-core/index.js";

import {
  formatPercent,
  formatRemainingRateLimitWindow,
} from "./account-format.js";
import { formatElapsedDuration } from "./elapsed-duration.js";
import { formatProviderLabel } from "./provider-format.js";

export interface LifecyclePresentation {
  title: string;
  fields: readonly LifecyclePresentationField[];
  sections?: readonly LifecyclePresentationSection[];
}

export interface LifecyclePresentationField {
  label: string;
  value: string;
}

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
      {
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
      },
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
            label: "Provider",
            value: formatProviderLabel(status.modelProvider ?? "openai"),
          },
          {
            label: "思考强度",
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
          ...(usesOpenAiAccount(status.modelProvider) && status.weeklyLimit
            ? [{
                label: "周限",
                value: formatWeeklyLimit(status.weeklyLimit),
              }]
            : []),
        ],
      },
    ],
  };
}

export function createTurnStartedPresentation(): LifecyclePresentation {
  return {
    title: "已开始处理。",
    fields: [],
  };
}

export function createTurnCompletedPresentation(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
): LifecyclePresentation {
  const fields: LifecyclePresentationField[] = [];
  if (event.error) {
    fields.push({
      label: "错误",
      value: event.error.replaceAll("[REDACTED]", "[已隐藏]"),
    });
  }
  if (event.tokenUsage) {
    const current = event.tokenUsage.last.totalTokens;
    const capacity = event.tokenUsage.modelContextWindow;
    fields.push(
      {
        label: "上下文",
        value: capacity === null || capacity <= 0
          ? formatTokenCount(current)
          : `${formatTokenCount(current)} / ${formatTokenCount(capacity)}（${formatPercent(Math.max(0, current / capacity * 100))}）`,
      },
      {
        label: "缓存命中",
        value: formatCacheHitRate(
          event.tokenUsage.last.inputTokens,
          event.tokenUsage.last.cachedInputTokens,
        ),
      },
    );
  }
  if (event.model) {
    fields.push({
      label: "模型",
      value: usesOpenAiAccount(event.modelProvider)
        ? `${event.model} · ${event.effort ?? "模型默认"} · Fast ${isFastServiceTier(event.serviceTier ?? null) ? "开启" : "关闭"}`
        : `${event.model} · ${event.effort ?? "模型默认"}`,
    });
    fields.push({
      label: "Provider",
      value: formatProviderLabel(event.modelProvider ?? "openai"),
    });
  }
  if (event.contextCompactionCount !== undefined) {
    fields.push({
      label: "上下文压缩",
      value: `${event.contextCompactionCount} 次`,
    });
  }
  if (usesOpenAiAccount(event.modelProvider) && event.weeklyLimit) {
    fields.push({
      label: "周限",
      value: formatWeeklyLimit(event.weeklyLimit),
    });
  }
  if (event.goal) {
    fields.push({
      label: "Goal",
      value: `${goalStatusLabel(event.goal.status)} · ${formatGoalTokens(event.goal)}`,
    });
  }
  if (Object.hasOwn(event, "gitBranch")) {
    fields.push({
      label: "Git 分支",
      value: event.gitBranch ?? "未检测到",
    });
  }
  if (event.durationMs !== undefined) {
    fields.push({
      label: "耗时",
      value: formatElapsedDuration(event.durationMs),
    });
  }
  return {
    title: `本次运行 · ${turnStatusLabel(event.status)}`,
    fields,
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

function formatField(field: LifecyclePresentationField): string {
  return `${field.label}：${field.value}`;
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

function formatTokenCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString("zh-CN", {
      maximumFractionDigits: 2,
    })} M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toLocaleString("zh-CN", {
      maximumFractionDigits: 2,
    })} K`;
  }
  return value.toLocaleString("zh-CN");
}

function formatCacheHitRate(
  inputTokens: number,
  cachedInputTokens: number,
): string {
  return inputTokens > 0
    ? formatPercent(Math.max(0, cachedInputTokens / inputTokens * 100))
    : "未知";
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
