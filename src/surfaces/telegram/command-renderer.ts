import type { Context } from "grammy";

import type {
  ConversationCommandResult,
} from "../../application/index.js";
import {
  formatConversationArtifacts,
  formatConversationCollaborationMode,
  formatConversationCommandOutcome,
  formatConversationGoal,
  formatConversationLimits,
  formatConversationMcp,
  formatConversationModels,
  formatConversationPermissions,
  formatConversationPlugins,
  formatConversationProjectRules,
  formatConversationSkills,
  formatConversationUsage,
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
): Promise<void> {
  switch (result.kind) {
    case "outcome": {
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
    case "mcp":
      await replyTelegramPanel(context, formatConversationMcp(result));
      return;
    case "plugins":
      await replyTelegramPanel(context, formatConversationPlugins(result));
      return;
    case "usage":
      await replyTelegramPanel(context, formatConversationUsage(result));
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

export async function replyTelegramPanel(context: Context, text: string): Promise<void> {
  for (const [index, chunk] of formatTelegramPanelChunks(text).entries()) {
    await context.reply(chunk, {
      parse_mode: "HTML",
      ...(index === 0 ? {} : { disable_notification: true }),
    });
  }
}
