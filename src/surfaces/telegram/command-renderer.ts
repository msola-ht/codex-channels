import type { Context } from "grammy";

import type { ConversationCommandResult } from "../../application/index.js";
import {
  formatDiff,
  formatFastModeState,
  formatLimits,
  formatMcpServers,
  formatModels,
  formatPermissions,
  formatPlan,
  formatPlugins,
  formatReasoningEfforts,
  formatSessions,
  formatSkills,
  formatStatus,
  formatUsage,
  formatWorkspaces,
} from "./format.js";
import { formatTelegramDiffChunks, formatTelegramPanelChunks } from "./html-format.js";

export async function renderTelegramCommandResult(
  context: Context,
  result: ConversationCommandResult,
): Promise<void> {
  switch (result.kind) {
    case "notice":
      if (result.detail === "expanded") {
        await replyTelegramPanel(context, result.text);
      } else {
        await context.reply(result.text);
      }
      return;
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
        formatWorkspaces(result.workspaces, result.currentWorkspaceId),
      );
      return;
    case "models":
      await replyTelegramPanel(
        context,
        result.view === "model"
          ? formatModels(result.state)
          : result.view === "effort"
            ? formatReasoningEfforts(result.state)
            : formatFastModeState(result.state),
      );
      return;
    case "skills":
      await replyTelegramPanel(context, formatSkills(result.entries));
      return;
    case "mcp":
      await replyTelegramPanel(context, formatMcpServers(result.servers));
      return;
    case "plugins":
      await replyTelegramPanel(context, formatPlugins(result.result));
      return;
    case "usage":
      await replyTelegramPanel(context, formatUsage(result.result));
      return;
    case "limits":
      await replyTelegramPanel(context, formatLimits(result.result));
      return;
    case "permissions":
      await replyTelegramPanel(context, formatPermissions(result.profiles));
      return;
    case "artifacts":
      if (result.view === "plan") {
        await replyTelegramPanel(context, formatPlan(result.artifacts));
        return;
      }
      for (const [index, chunk] of formatTelegramDiffChunks(
        formatDiff(result.artifacts),
      ).entries()) {
        await context.reply(chunk, {
          parse_mode: "HTML",
          ...(index === 0 ? {} : { disable_notification: true }),
        });
      }
      return;
  }
}

export async function replyTelegramPanel(context: Context, text: string): Promise<void> {
  for (const [index, chunk] of formatTelegramPanelChunks(text).entries()) {
    await context.reply(chunk, {
      parse_mode: "HTML",
      ...(index === 0 ? {} : { disable_notification: true }),
    });
  }
}
