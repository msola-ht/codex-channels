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
  formatConversationSkills,
  formatConversationUsage,
  formatConversationWorkspacePermissions,
  formatConversationWorkspaces,
} from "../conversation-command-format.js";
import {
  formatSessions,
  formatStatus,
} from "./format.js";
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
      await replyTelegramPanel(
        context,
        formatSessions(result.sessions, result.currentThreadId, {
          archived: result.archived,
          ...(result.searchTerm ? { searchTerm: result.searchTerm } : {}),
        }),
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
      await replyTelegramPanel(context, formatConversationPlugins(result));
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
    ].includes(outcome.type),
  };
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
