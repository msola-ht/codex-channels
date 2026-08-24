import { createHash } from "node:crypto";

import type { Context } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";

import type {
  ConversationCommandResult,
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
} from "../../application/index.js";
import {
  formatConversationAgents,
  formatConversationArtifacts,
  formatConversationCollaborationMode,
  formatConversationCommandOutcome,
  formatConversationOccupancy,
  isTurnLifecycleAcknowledgedOutcome,
  formatConversationGoal,
  formatConversationLimits,
  formatConversationMetrics,
  formatConversationMcp,
  formatConversationMcpDetail,
  formatConversationMcpHealth,
  formatConversationMcpLogin,
  formatConversationMcpReload,
  formatConversationMcpResource,
  formatConversationPluginDetail,
  formatConversationPluginHealth,
  formatConversationPlugins,
  formatConversationModels,
  formatConversationPermissions,
  formatConversationProjectRules,
  formatConversationSessions,
  formatConversationScheduledConfirmation,
  formatConversationScheduledRuns,
  formatConversationScheduledTasks,
  formatConversationSkills,
  formatConversationThreadSectionDeletePreview,
  formatConversationThreadQueue,
  formatConversationThreadRevert,
  formatConversationThreadRevertPreview,
  formatConversationThreadSections,
  formatThreadQueueInputTypeLabel,
  formatConversationUsage,
  formatConversationWorkspacePermissions,
  formatConversationWorkspaces,
} from "../conversation-command-format.js";
import { formatStatus } from "./format.js";
import { formatTelegramDiffChunks, formatTelegramPanelChunks } from "./html-format.js";

export async function renderTelegramCommandResult(
  context: Context,
  result: ConversationCommandResult,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): Promise<void> {
  switch (result.kind) {
    case "outcome": {
      if (isTurnLifecycleAcknowledgedOutcome(result.outcome)) {
        return;
      }
      const rendered = renderOutcome(result.outcome);
      if (rendered.expanded) {
        await replyTelegramPanel(context, rendered.text);
      } else {
        await context.reply(rendered.text);
      }
      return;
    }
    case "sessions":
      await replyTelegramPanel(context, formatConversationSessions(result));
      return;
    case "thread-sections":
      await replyTelegramPanel(
        context,
        formatConversationThreadSections(result),
        threadSectionKeyboard(result),
      );
      return;
    case "thread-section-delete-preview":
      await replyTelegramPanel(
        context,
        formatConversationThreadSectionDeletePreview(result),
      );
      return;
    case "thread-queue":
      await replyTelegramPanel(
        context,
        [
          formatConversationThreadQueue(result),
          "",
          "按钮支持分页、刷新和进入条目后启动/删除；新增、更新、排序请继续使用 /queue 文本命令。",
        ].join("\n"),
        threadQueueKeyboard(result),
      );
      return;
    case "thread-revert":
      await replyTelegramPanel(context, formatConversationThreadRevert(result));
      return;
    case "thread-revert-preview":
      await replyTelegramPanel(context, formatConversationThreadRevertPreview(result));
      return;
    case "scheduled-tasks":
      await replyTelegramPanel(context, formatConversationScheduledTasks(result));
      return;
    case "scheduled-runs":
      await replyTelegramPanel(context, formatConversationScheduledRuns(result));
      return;
    case "scheduled-confirmation":
      await replyTelegramPanel(
        context,
        formatConversationScheduledConfirmation(result),
        scheduledTaskConfirmationKeyboard(result),
      );
      return;
    case "status":
      await replyTelegramPanel(context, formatStatus(result.status));
      return;
    case "workspaces":
      await replyTelegramPanel(
        context,
        formatConversationWorkspaces(result),
      );
      return;
    case "workspace-permissions":
      await replyTelegramPanel(
        context,
        formatConversationWorkspacePermissions(result),
        workspacePermissionKeyboard(),
      );
      return;
    case "models":
      await replyTelegramPanel(context, formatConversationModels(result));
      return;
    case "collaboration-mode":
      await replyTelegramPanel(
        context,
        formatConversationCollaborationMode(result),
      );
      return;
    case "skills":
      await replyTelegramPanel(context, formatConversationSkills(result));
      return;
    case "agents":
      await replyTelegramPanel(context, formatConversationAgents(result));
      return;
    case "mcp":
      await replyTelegramPanel(context, formatConversationMcp(result));
      return;
    case "mcp-health":
      await replyTelegramPanel(context, formatConversationMcpHealth(result));
      return;
    case "mcp-reload":
      await replyTelegramPanel(context, formatConversationMcpReload(result));
      return;
    case "mcp-detail":
      await replyTelegramPanel(context, formatConversationMcpDetail(result));
      return;
    case "mcp-login":
      await replyTelegramPanel(context, formatConversationMcpLogin(result));
      return;
    case "mcp-resource":
      await replyTelegramPanel(context, formatConversationMcpResource(result));
      return;
    case "plugins":
      await replyTelegramPanel(
        context,
        formatConversationPlugins(result),
        pluginKeyboard(result),
      );
      return;
    case "plugin-health":
      await replyTelegramPanel(context, formatConversationPluginHealth(result));
      return;
    case "plugin-detail":
      await replyTelegramPanel(context, formatConversationPluginDetail(result));
      return;
    case "usage":
      await replyTelegramPanel(context, formatConversationUsage(result));
      return;
    case "metrics":
      await replyTelegramPanel(
        context,
        formatConversationMetrics(result, priceCurrency, exchangeRate),
      );
      return;
    case "limits":
      await replyTelegramPanel(context, formatConversationLimits(result));
      return;
    case "permissions":
      await replyTelegramPanel(context, formatConversationPermissions(result));
      return;
    case "project-rules":
      await replyTelegramPanel(
        context,
        formatConversationProjectRules(result),
      );
      return;
    case "artifacts":
      for (const [index, chunk] of formatTelegramDiffChunks(
        formatConversationArtifacts(result),
      ).entries()) {
        await context.reply(chunk, {
          parse_mode: "HTML",
          ...(index === 0 ? {} : { disable_notification: true }),
        });
      }
      return;
    case "goal":
      await replyTelegramPanel(context, formatConversationGoal(result));
      return;
    case "occupancy":
      await replyTelegramPanel(context, formatConversationOccupancy(result));
      return;
  }
}

export function workspacePermissionKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "沙箱", callback_data: "wp:sandbox" },
      { text: "审批", callback_data: "wp:approval" },
      { text: "权限 Profile", callback_data: "wp:profile" },
    ]],
  };
}

export function scheduledTaskConfirmationKeyboard(
  result: Extract<ConversationCommandResult, { kind: "scheduled-confirmation" }>,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      {
        text: "确认",
        callback_data: `schedule:confirm:${result.preview.token}`,
      },
      { text: "取消", callback_data: "schedule:cancel" },
    ]],
  };
}

export function pluginKeyboard(
  result: Extract<ConversationCommandResult, { kind: "plugins" }>,
): InlineKeyboardMarkup | undefined {
  const pluginRows = result.plugins.flatMap((plugin, index) => {
    const selector = result.selectors[index];
    return plugin.enabled && plugin.available && selector
      ? [[{
          text: boundedButtonLabel(plugin.displayName),
          callback_data: `plugin:select:${telegramPluginSelectionToken(plugin.id)}`,
        }]]
      : [];
  });
  const pageButtons = result.searchTerm === null
    ? [
        ...(result.page > 1
          ? [{ text: "上一页", callback_data: `plugin:page:${result.page - 1}` }]
          : []),
        ...(result.page < result.pageCount
          ? [{ text: "下一页", callback_data: `plugin:page:${result.page + 1}` }]
          : []),
      ]
    : [];
  const inlineKeyboard = [
    ...pluginRows,
    ...(pageButtons.length > 0 ? [pageButtons] : []),
  ];
  return inlineKeyboard.length > 0
    ? { inline_keyboard: inlineKeyboard }
    : undefined;
}

export function telegramPluginSelectionToken(pluginId: string): string {
  return createHash("sha256").update(pluginId).digest("base64url");
}

export function threadSectionKeyboard(
  result: Extract<ConversationCommandResult, { kind: "thread-sections" }>,
): InlineKeyboardMarkup | undefined {
  if (result.page > result.pageCount) return undefined;
  const rows = result.sections.flatMap((section) => {
    if (section.builtIn === "pinned") {
      return [[{
        text: boundedButtonLabel(`${section.name} · 固定`),
        callback_data: "section:pin",
      }]];
    }
    return result.canManageCustomSections
      ? [[{
          text: boundedButtonLabel(section.name),
          callback_data: `section:move:${telegramThreadSectionToken(section.id)}`,
        }]]
      : [];
  });
  const pages = [
    ...(result.page > 1
      ? [{ text: "上一页", callback_data: `section:page:${result.page - 1}` }]
      : []),
    ...(result.page < result.pageCount
      ? [{ text: "下一页", callback_data: `section:page:${result.page + 1}` }]
      : []),
  ];
  const inlineKeyboard = [...rows, ...(pages.length > 0 ? [pages] : [])];
  return inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined;
}

export function threadQueueKeyboard(
  result: Extract<ConversationCommandResult, { kind: "thread-queue" }>,
): InlineKeyboardMarkup | undefined {
  if (
    result.result.page > result.result.pageCount
    || result.result.items.length === 0
  ) {
    return result.result.totalItemCount === 0
      ? {
          inline_keyboard: [[{
            text: "刷新",
            callback_data: `queue:refresh:${result.result.page}`,
          }]],
        }
      : undefined;
  }
  const rows = result.result.items.flatMap((item) => {
    const callbackData = `queue:item:${result.result.page}:${item.id}`;
    return callbackData.length <= 64
      ? [[{
          text: boundedButtonLabel(queueItemButtonLabel(item)),
          callback_data: callbackData,
        }]]
      : [];
  });
  const pageButtons = [
    ...(result.result.page > 1
      ? [{
          text: "上一页",
          callback_data: `queue:page:${result.result.page - 1}`,
        }]
      : []),
    {
      text: "刷新",
      callback_data: `queue:refresh:${result.result.page}`,
    },
    ...(result.result.page < result.result.pageCount
      ? [{
          text: "下一页",
          callback_data: `queue:page:${result.result.page + 1}`,
        }]
      : []),
  ];
  return pageButtons.length > 0
    ? { inline_keyboard: [...rows, pageButtons] }
    : undefined;
}

export function threadQueueItemKeyboard(
  page: number,
  itemId: string,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: "启动",
          callback_data: `queue:start:${page}:${itemId}`,
        },
        {
          text: "删除",
          callback_data: `queue:delete-confirm:${page}:${itemId}`,
        },
      ],
      [{
        text: "返回 Queue 列表",
        callback_data: `queue:refresh:${page}`,
      }],
    ],
  };
}

export function threadQueueDeleteConfirmationKeyboard(
  page: number,
  itemId: string,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      {
        text: "确认删除",
        callback_data: `queue:delete:${page}:${itemId}`,
      },
      {
        text: "取消",
        callback_data: `queue:item:${page}:${itemId}`,
      },
    ]],
  };
}

export function formatTelegramThreadQueueItemAction(
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): string {
  return [
    "Queue 条目",
    `ID：${item.id}`,
    `类型：${formatThreadQueueInputTypeLabel(item.inputType)}${item.editable ? " · 可更新" : " · 只读摘要"}`,
    `安全预览：${item.textPreview || "（无文本预览）"}`,
    "",
    "请选择操作：",
  ].join("\n");
}

export function formatTelegramThreadQueueDeleteConfirmation(
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): string {
  return [
    "确认删除 Queue 条目？",
    `ID：${item.id}`,
    `安全预览：${item.textPreview || "（无文本预览）"}`,
    "删除后无法通过 Gateway 恢复。",
  ].join("\n");
}

export function telegramThreadSectionToken(sectionId: string): string {
  return createHash("sha256").update(sectionId).digest("base64url");
}

export function workspacePermissionFieldKeyboard(
  field: "sandbox" | "approval",
): InlineKeyboardMarkup {
  const options: ReadonlyArray<readonly [string, string]> = field === "sandbox"
    ? [
        ["只读", "read-only"],
        ["工作区可写", "workspace-write"],
        ["完全访问", "danger-full-access"],
        ["清除（使用全局）", "clear"],
      ]
    : [
        ["不信任", "untrusted"],
        ["按需审批", "on-request"],
        ["免审批", "never"],
        ["清除（使用默认）", "clear"],
      ];
  return {
    inline_keyboard: options.map(([label, value]) => [{
      text: label,
      callback_data: `wp:${field}:${value}`,
    }]),
  };
}

export function workspacePermissionPrompt(
  field: "sandbox" | "approval",
): string {
  return field === "sandbox"
    ? "选择沙箱模式："
    : "选择审批策略：";
}

function renderOutcome(
  outcome: Extract<
    ConversationCommandResult,
    { kind: "outcome" }
  >["outcome"],
): { text: string; expanded: boolean } {
  return {
    text: formatConversationCommandOutcome(outcome),
    expanded: [
      "thread.resumed",
      "thread.archived",
      "thread.unarchived",
      "workspace.selected",
      "thread.renamed",
      "thread.forked",
      "review.started",
      "goal.updated",
      "scheduled-task.created",
      "scheduled-task.deleted",
      "scheduled-task.renamed",
      "scheduled-task.paused",
      "scheduled-task.resumed",
      "scheduled-task.run-requested",
      "scheduled-task.retry-requested",
    ].includes(outcome.type),
  };
}

function queueItemButtonLabel(
  item: Extract<ConversationCommandResult, { kind: "thread-queue" }>["result"]["items"][number],
): string {
  return item.textPreview
    ? item.textPreview
    : `${formatThreadQueueInputTypeLabel(item.inputType)} Queue 条目`;
}

export async function replyTelegramPanel(
  context: Context,
  text: string,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  for (const [index, chunk] of formatTelegramPanelChunks(text).entries()) {
    await context.reply(chunk, {
      parse_mode: "HTML",
      ...(index === 0 && replyMarkup
        ? { reply_markup: replyMarkup }
        : {}),
      ...(index === 0 ? {} : { disable_notification: true }),
    });
  }
}

function boundedButtonLabel(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 47)}…`;
}
