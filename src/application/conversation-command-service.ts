import type { ReviewTarget } from "../codex-protocol/index.js";
import type { ConversationTarget } from "../conversation-core/index.js";
import type { ConversationService } from "./conversation-service.js";

export const conversationCommands = [
  { name: "resume", description: "列出或恢复 Codex 会话" },
  { name: "sessions", description: "搜索可恢复会话" },
  { name: "archived", description: "搜索已归档会话" },
  { name: "new", description: "下一条消息创建新会话" },
  { name: "archive", description: "归档当前会话" },
  { name: "unarchive", description: "恢复已归档会话" },
  { name: "status", description: "查看当前状态" },
  { name: "workspace", description: "列出或切换 Workspace" },
  { name: "stop", description: "停止当前任务" },
  { name: "rename", description: "命名当前会话" },
  { name: "compact", description: "压缩当前上下文" },
  { name: "fork", description: "分叉当前会话" },
  { name: "review", description: "启动代码审查" },
  { name: "model", description: "查看或切换模型" },
  { name: "effort", description: "查看或切换思考强度" },
  { name: "fast", description: "查看或切换 Fast 模式" },
  { name: "skills", description: "列出 Skills" },
  { name: "mcp", description: "列出 MCP Servers" },
  { name: "plugins", description: "列出 Plugins" },
  { name: "usage", description: "查看账号用量" },
  { name: "limits", description: "查看套餐与额度" },
  { name: "permissions", description: "查看权限配置" },
  { name: "diff", description: "查看当前 Turn Diff" },
  { name: "plan", description: "查看当前 Turn 计划" },
  { name: "goal", description: "查看或管理 Goal" },
] as const;

export type ConversationCommandName = typeof conversationCommands[number]["name"];

export const conversationCommandNames: readonly ConversationCommandName[] =
  conversationCommands.map(({ name }) => name);
const conversationCommandNameSet = new Set<string>(conversationCommandNames);

export function isConversationCommandName(value: string): value is ConversationCommandName {
  return conversationCommandNameSet.has(value);
}

export type ConversationCommandResult =
  | { kind: "notice"; text: string; detail: "brief" | "expanded" }
  | {
      kind: "sessions";
      sessions: Awaited<ReturnType<ConversationService["listSessions"]>>;
      currentThreadId?: string;
      archived: boolean;
      searchTerm?: string;
    }
  | { kind: "status"; status: ReturnType<ConversationService["status"]> }
  | {
      kind: "workspaces";
      workspaces: ReturnType<ConversationService["listWorkspaces"]>;
      currentWorkspaceId: string;
    }
  | {
      kind: "models";
      view: "model" | "effort" | "fast";
      state: Awaited<ReturnType<ConversationService["modelState"]>>;
    }
  | { kind: "skills"; entries: Awaited<ReturnType<ConversationService["listSkills"]>> }
  | { kind: "mcp"; servers: Awaited<ReturnType<ConversationService["listMcpServers"]>> }
  | { kind: "plugins"; result: Awaited<ReturnType<ConversationService["listPlugins"]>> }
  | { kind: "usage"; result: Awaited<ReturnType<ConversationService["accountUsage"]>> }
  | { kind: "limits"; result: Awaited<ReturnType<ConversationService["accountRateLimits"]>> }
  | {
      kind: "permissions";
      profiles: Awaited<ReturnType<ConversationService["listPermissionProfiles"]>>;
    }
  | {
      kind: "artifacts";
      view: "diff" | "plan";
      artifacts: ReturnType<ConversationService["artifacts"]>;
    };

export class ConversationCommandService {
  constructor(private readonly conversations: ConversationService) {}

  async execute(
    target: ConversationTarget,
    command: ConversationCommandName,
    input = "",
  ): Promise<ConversationCommandResult> {
    const argumentsText = input.trim();
    switch (command) {
      case "resume": {
        if (argumentsText) {
          const threadId = await this.conversations.resume(target, argumentsText);
          return {
            kind: "notice",
            text: `已恢复 Codex Thread\nThread：${threadId}`,
            detail: "expanded",
          };
        }
        const sessions = await this.conversations.listSessions(target);
        const currentThreadId = this.conversations.status(target).threadId;
        return {
          kind: "sessions",
          sessions,
          archived: false,
          ...(currentThreadId ? { currentThreadId } : {}),
        };
      }
      case "sessions": {
        const sessions = await this.conversations.listSessions(target, {
          ...(argumentsText ? { searchTerm: argumentsText } : {}),
        });
        const currentThreadId = this.conversations.status(target).threadId;
        return {
          kind: "sessions",
          sessions,
          archived: false,
          ...(currentThreadId ? { currentThreadId } : {}),
          ...(argumentsText ? { searchTerm: argumentsText } : {}),
        };
      }
      case "archived": {
        const sessions = await this.conversations.listSessions(target, {
          archived: true,
          ...(argumentsText ? { searchTerm: argumentsText } : {}),
        });
        return {
          kind: "sessions",
          sessions,
          archived: true,
          ...(argumentsText ? { searchTerm: argumentsText } : {}),
        };
      }
      case "new":
        await this.conversations.newSession(target);
        return {
          kind: "notice",
          text: "已退出当前会话，下一条普通消息将创建新的 Codex Thread。",
          detail: "brief",
        };
      case "archive": {
        const threadId = await this.conversations.archive(target);
        return {
          kind: "notice",
          text: `已归档 Codex Thread\nThread：${threadId}\n下一条普通消息将创建新会话。`,
          detail: "expanded",
        };
      }
      case "unarchive": {
        const threadId = await this.conversations.unarchive(target, argumentsText);
        return {
          kind: "notice",
          text: `已取消归档并切换会话\nThread：${threadId}`,
          detail: "expanded",
        };
      }
      case "status":
        return { kind: "status", status: this.conversations.status(target) };
      case "workspace": {
        if (argumentsText) {
          const workspace = await this.conversations.selectWorkspace(target, argumentsText);
          return {
            kind: "notice",
            text: `已切换 Workspace\nWorkspace：${workspace.name}\n工作目录：${workspace.cwd}`,
            detail: "expanded",
          };
        }
        return {
          kind: "workspaces",
          workspaces: this.conversations.listWorkspaces(),
          currentWorkspaceId: this.conversations.status(target).workspaceId,
        };
      }
      case "stop": {
        const stopped = await this.conversations.stop(target);
        return {
          kind: "notice",
          text: stopped ? "已请求停止当前任务。" : "当前没有运行中的任务。",
          detail: "brief",
        };
      }
      case "rename":
        await this.conversations.rename(target, argumentsText);
        return {
          kind: "notice",
          text: `会话已重命名\n名称：${argumentsText}`,
          detail: "expanded",
        };
      case "compact":
        await this.conversations.compact(target);
        return {
          kind: "notice",
          text: "已请求压缩当前 Codex Thread。进度将通过标准事件返回。",
          detail: "brief",
        };
      case "fork": {
        const threadId = await this.conversations.fork(target);
        return {
          kind: "notice",
          text: `已分叉并切换到新会话\nThread：${threadId}`,
          detail: "expanded",
        };
      }
      case "review": {
        const submission = await this.conversations.review(
          target,
          parseReviewTarget(argumentsText),
        );
        return {
          kind: "notice",
          text: `已启动 Codex Review\nTurn：${submission.turnId}`,
          detail: "expanded",
        };
      }
      case "model":
        return {
          kind: "models",
          view: "model",
          state: argumentsText
            ? await this.conversations.selectModel(target, argumentsText)
            : await this.conversations.modelState(target),
        };
      case "effort":
        return {
          kind: "models",
          view: "effort",
          state: argumentsText
            ? await this.conversations.selectEffort(target, argumentsText)
            : await this.conversations.modelState(target),
        };
      case "fast":
        return {
          kind: "models",
          view: "fast",
          state: await this.conversations.selectFastMode(target, argumentsText),
        };
      case "skills":
        return {
          kind: "skills",
          entries: await this.conversations.listSkills(target),
        };
      case "mcp":
        return {
          kind: "mcp",
          servers: await this.conversations.listMcpServers(target),
        };
      case "plugins":
        return {
          kind: "plugins",
          result: await this.conversations.listPlugins(target),
        };
      case "usage":
        return {
          kind: "usage",
          result: await this.conversations.accountUsage(),
        };
      case "limits":
        return {
          kind: "limits",
          result: await this.conversations.accountRateLimits(),
        };
      case "permissions":
        return {
          kind: "permissions",
          profiles: await this.conversations.listPermissionProfiles(target),
        };
      case "diff":
      case "plan":
        return {
          kind: "artifacts",
          view: command,
          artifacts: this.conversations.artifacts(target),
        };
      case "goal":
        return this.goal(target, argumentsText);
    }
    throw new Error(`不支持的会话命令：${String(command)}`);
  }

  private async goal(
    target: ConversationTarget,
    input: string,
  ): Promise<ConversationCommandResult> {
    if (input === "clear") {
      await this.conversations.clearGoal(target);
      return {
        kind: "notice",
        text: "已清除当前 Thread Goal。",
        detail: "brief",
      };
    }
    if (input.startsWith("set ")) {
      const goal = await this.conversations.setGoal(target, input.slice(4));
      return {
        kind: "notice",
        text: `Goal 已设置\n目标：${goal.objective}`,
        detail: "expanded",
      };
    }
    const goal = await this.conversations.getGoal(target);
    return {
      kind: "notice",
      text: goal
        ? `当前 Goal：${goal.objective}\n状态：${goal.status}\nTokens：${goal.tokensUsed}${goal.tokenBudget === null ? "" : ` / ${goal.tokenBudget}`}`
        : "当前 Thread 没有 Goal。使用 /goal set <目标> 设置。",
      detail: "expanded",
    };
  }
}

function parseReviewTarget(input: string): ReviewTarget {
  if (!input) {
    return { type: "uncommittedChanges" };
  }
  const [kind, ...rest] = input.split(/\s+/);
  const value = rest.join(" ").trim();
  if (kind === "branch" && value) {
    return { type: "baseBranch", branch: value };
  }
  if (kind === "commit" && value) {
    return { type: "commit", sha: value, title: null };
  }
  if (kind === "custom" && value) {
    return { type: "custom", instructions: value };
  }
  throw new Error("用法：/review [branch <分支>|commit <SHA>|custom <说明>]");
}
