import type { ReviewTarget } from "../codex-protocol/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { ConversationService } from "./conversation-service.js";

export const conversationCommandNames = [
  "resume",
  "sessions",
  "archived",
  "new",
  "archive",
  "unarchive",
  "status",
  "workspace",
  "stop",
  "rename",
  "compact",
  "fork",
  "review",
  "model",
  "effort",
  "fast",
  "skills",
  "mcp",
  "plugins",
  "usage",
  "limits",
  "permissions",
  "diff",
  "plan",
  "goal",
] as const;

export type ConversationCommandName = typeof conversationCommandNames[number];
const conversationCommandNameSet = new Set<string>(conversationCommandNames);

export function isConversationCommandName(value: string): value is ConversationCommandName {
  return conversationCommandNameSet.has(value);
}

export type ConversationCommandResult =
  | { kind: "outcome"; outcome: ConversationCommandOutcome }
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
    }
  | { kind: "goal"; goal: Awaited<ReturnType<ConversationService["getGoal"]>> };

export type ConversationCommandOutcome =
  | { type: "thread.resumed"; threadId: string }
  | { type: "session.new" }
  | { type: "thread.archived"; threadId: string }
  | { type: "thread.unarchived"; threadId: string }
  | {
      type: "workspace.selected";
      workspace: Awaited<ReturnType<ConversationService["selectWorkspace"]>>;
    }
  | { type: "turn.stop-requested"; stopped: boolean }
  | { type: "thread.renamed"; name: string }
  | { type: "thread.compaction-requested" }
  | { type: "thread.forked"; threadId: string }
  | { type: "review.started"; turnId: string }
  | { type: "goal.cleared" }
  | {
      type: "goal.updated";
      goal: Awaited<ReturnType<ConversationService["setGoal"]>>;
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
            kind: "outcome",
            outcome: { type: "thread.resumed", threadId },
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
          kind: "outcome",
          outcome: { type: "session.new" },
        };
      case "archive": {
        const threadId = await this.conversations.archive(target);
        return {
          kind: "outcome",
          outcome: { type: "thread.archived", threadId },
        };
      }
      case "unarchive": {
        const threadId = await this.conversations.unarchive(target, argumentsText);
        return {
          kind: "outcome",
          outcome: { type: "thread.unarchived", threadId },
        };
      }
      case "status":
        return { kind: "status", status: this.conversations.status(target) };
      case "workspace": {
        if (argumentsText) {
          const workspace = await this.conversations.selectWorkspace(target, argumentsText);
          return {
            kind: "outcome",
            outcome: { type: "workspace.selected", workspace },
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
          kind: "outcome",
          outcome: { type: "turn.stop-requested", stopped },
        };
      }
      case "rename":
        await this.conversations.rename(target, argumentsText);
        return {
          kind: "outcome",
          outcome: { type: "thread.renamed", name: argumentsText },
        };
      case "compact":
        await this.conversations.compact(target);
        return {
          kind: "outcome",
          outcome: { type: "thread.compaction-requested" },
        };
      case "fork": {
        const threadId = await this.conversations.fork(target);
        return {
          kind: "outcome",
          outcome: { type: "thread.forked", threadId },
        };
      }
      case "review": {
        const submission = await this.conversations.review(
          target,
          parseReviewTarget(argumentsText),
        );
        return {
          kind: "outcome",
          outcome: { type: "review.started", turnId: submission.turnId },
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
    throw new UserFacingError(
      "command.unsupported",
      `不支持的会话命令：${String(command)}`,
      { command: String(command) },
    );
  }

  private async goal(
    target: ConversationTarget,
    input: string,
  ): Promise<ConversationCommandResult> {
    if (input === "clear") {
      await this.conversations.clearGoal(target);
      return {
        kind: "outcome",
        outcome: { type: "goal.cleared" },
      };
    }
    if (input.startsWith("set ")) {
      const goal = await this.conversations.setGoal(target, input.slice(4));
      return {
        kind: "outcome",
        outcome: { type: "goal.updated", goal },
      };
    }
    if (input) {
      throw new UserFacingError(
        "goal.usage",
        "Goal 参数无效",
      );
    }
    const goal = await this.conversations.getGoal(target);
    return { kind: "goal", goal };
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
  throw new UserFacingError(
    "review.usage",
    "Review 参数无效",
  );
}
