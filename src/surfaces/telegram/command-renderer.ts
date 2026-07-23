import type { Context } from "grammy";

import type {
  ConversationCommandOutcome,
  ConversationCommandResult,
} from "../../application/index.js";
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
  outcome: ConversationCommandOutcome,
): { text: string; expanded: boolean } {
  switch (outcome.type) {
    case "thread.resumed":
      return {
        text: `已恢复 Codex Thread\nThread：${outcome.threadId}`,
        expanded: true,
      };
    case "session.new":
      return {
        text: "已退出当前会话，下一条普通消息将创建新的 Codex Thread。",
        expanded: false,
      };
    case "thread.archived":
      return {
        text: `已归档 Codex Thread\nThread：${outcome.threadId}\n下一条普通消息将创建新会话。`,
        expanded: true,
      };
    case "thread.unarchived":
      return {
        text: `已取消归档并切换会话\nThread：${outcome.threadId}`,
        expanded: true,
      };
    case "workspace.selected":
      return {
        text: `已切换 Workspace\nWorkspace：${outcome.workspace.name}\n工作目录：${outcome.workspace.cwd}`,
        expanded: true,
      };
    case "turn.stop-requested":
      return {
        text: outcome.stopped ? "已请求停止当前任务。" : "当前没有运行中的任务。",
        expanded: false,
      };
    case "turn.follow-up-queued":
      return {
        text: `已排到下一 Turn，当前第 ${outcome.position} 条。队列仅保存在内存，Gateway 重启会清空。`,
        expanded: false,
      };
    case "thread.renamed":
      return {
        text: `会话已重命名\n名称：${outcome.name}`,
        expanded: true,
      };
    case "thread.compaction-requested":
      return {
        text: "已请求压缩当前 Codex Thread。进度将通过标准事件返回。",
        expanded: false,
      };
    case "thread.forked":
      return {
        text: `已分叉并切换到新会话\nThread：${outcome.threadId}`,
        expanded: true,
      };
    case "review.started":
      return {
        text: `已启动 Codex Review\nTurn：${outcome.turnId}`,
        expanded: true,
      };
    case "goal.cleared":
      return {
        text: "已清除当前 Thread Goal。",
        expanded: false,
      };
    case "goal.updated":
      return {
        text: `Goal 已设置\n目标：${outcome.goal.objective}`,
        expanded: true,
      };
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
