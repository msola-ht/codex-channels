import type { Context } from "grammy";

import type {
  ConversationCommandResult,
} from "../../application/index.js";
import { formatConversationCommandOutcome } from "../conversation-command-format.js";
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
    case "project-rules":
      await replyTelegramPanel(
        context,
        [
          result.action === "initialized"
            ? "项目规则已生成并检查通过"
            : "项目规则检查通过",
          `Workspace：${result.projectRoot}`,
          `规则文件：${result.rulesPath}`,
          ...(result.action === "initialized"
            ? ["重启 Codex/App Server 后生效；Gateway 无需重启。"]
            : []),
        ].join("\n"),
      );
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
    case "goal":
      await replyTelegramPanel(
        context,
        result.goal
          ? `当前 Goal：${result.goal.objective}\n状态：${result.goal.status}\nTokens：${result.goal.tokensUsed}${result.goal.tokenBudget === null ? "" : ` / ${result.goal.tokenBudget}`}`
          : "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。",
      );
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
