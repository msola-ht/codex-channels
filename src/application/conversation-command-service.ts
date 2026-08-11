import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { ConversationUseCases } from "./conversation-service.js";
import type {
  RequestMetricsCommandQuery,
  RequestMetricsTimeRange,
} from "./request-metrics-port.js";
import type { ReviewTarget, ThreadGoal } from "./turn-port.js";
import type { WorkspacePermissionUpdate } from "./workspace-permission-port.js";

export const conversationCommandNames = [
  "resume",
  "sessions",
  "archived",
  "new",
  "archive",
  "unarchive",
  "pin",
  "unpin",
  "status",
  "workspace",
  "workspaceperm",
  "stop",
  "queue",
  "rename",
  "compact",
  "fork",
  "review",
  "model",
  "effort",
  "fast",
  "skill",
  "mcp",
  "plugin",
  "usage",
  "metrics",
  "limits",
  "permissions",
  "rules",
  "diff",
  "plan",
  "goal",
  "agents",
] as const;

export type ConversationCommandName = typeof conversationCommandNames[number];
const conversationCommandNameSet = new Set<string>(conversationCommandNames);
export const mcpCommandUsageText = "用法：/mcp [health | reload | 名称或序号 [tools|resources|templates [页码] [search <关键词>]] | login <名称或序号> | resource <名称或序号> <URI>]";

export interface McpDetailView {
  section: "tools" | "resources" | "templates";
  page: number;
  searchTerm: string | null;
}

export function isConversationCommandName(value: string): value is ConversationCommandName {
  return conversationCommandNameSet.has(value);
}

export type ConversationCommandResult =
  | { kind: "outcome"; outcome: ConversationCommandOutcome }
  | {
      kind: "sessions";
      sessions: Awaited<ReturnType<ConversationUseCases["listSessions"]>>;
      currentThreadId?: string;
      backgroundThreadIds?: string[];
      archived: boolean;
      searchTerm?: string;
    }
  | { kind: "status"; status: ReturnType<ConversationUseCases["status"]> }
  | {
      kind: "workspaces";
      workspaces: ReturnType<ConversationUseCases["listWorkspaces"]>;
      currentWorkspaceId: string;
    }
  | {
      kind: "workspace-permissions";
      workspace: ReturnType<ConversationUseCases["listWorkspaces"]>[number];
    }
  | {
      kind: "models";
      view: "model" | "effort" | "fast";
      state: Awaited<ReturnType<ConversationUseCases["modelState"]>>;
    }
  | {
      kind: "collaboration-mode";
      state: Awaited<ReturnType<ConversationUseCases["togglePlanMode"]>>;
    }
  | { kind: "skills"; entries: Awaited<ReturnType<ConversationUseCases["listSkills"]>> }
  | { kind: "mcp"; servers: Awaited<ReturnType<ConversationUseCases["listMcpServers"]>> }
  | { kind: "mcp-health"; report: Awaited<ReturnType<ConversationUseCases["mcpHealth"]>> }
  | { kind: "mcp-reload" }
  | {
      kind: "mcp-detail";
      selector: string;
      server: Awaited<ReturnType<ConversationUseCases["mcpServerDetail"]>>;
      view?: McpDetailView;
    }
  | { kind: "mcp-login"; login: Awaited<ReturnType<ConversationUseCases["loginMcpServer"]>> }
  | { kind: "mcp-resource"; resource: Awaited<ReturnType<ConversationUseCases["readMcpResource"]>> }
  | {
      kind: "plugins";
      plugins: Awaited<ReturnType<ConversationUseCases["listPlugins"]>>["plugins"];
      loadErrorCount: number;
    }
  | { kind: "usage"; result: Awaited<ReturnType<ConversationUseCases["providerAccountUsage"]>> }
  | { kind: "metrics"; summary: ReturnType<ConversationUseCases["requestMetrics"]> }
  | { kind: "limits"; result: Awaited<ReturnType<ConversationUseCases["providerAccountLimits"]>> }
  | {
      kind: "permissions";
      profiles: Awaited<ReturnType<ConversationUseCases["listPermissionProfiles"]>>;
    }
  | {
      kind: "project-rules";
      action: "initialized" | "checked";
      projectRoot: string;
      rulesPath: string;
    }
  | {
      kind: "artifacts";
      view: "diff";
      artifacts: ReturnType<ConversationUseCases["artifacts"]>;
    }
  | { kind: "goal"; goal: ThreadGoal | null }
  | { kind: "agents"; roles: Awaited<ReturnType<ConversationUseCases["listAgentRoles"]>> };

export type ConversationCommandOutcome =
  | { type: "thread.resumed"; threadId: string; backgroundedThreadId?: string; transferredFrom?: string }
  | { type: "session.new"; backgroundedThreadId?: string }
  | { type: "thread.archived"; threadId: string }
  | { type: "thread.unarchived"; threadId: string }
  | { type: "thread.pin-updated"; pinned: boolean }
  | {
      type: "workspace.selected";
      workspace: Awaited<ReturnType<ConversationUseCases["selectWorkspace"]>>;
    }
  | {
      type: "workspace.permissions-updated";
      workspace: Awaited<ReturnType<ConversationUseCases["updateWorkspacePermissions"]>>;
    }
  | { type: "turn.stop-requested"; stopped: boolean }
  | { type: "turn.follow-up-queued"; position: number }
  | { type: "thread.renamed"; name: string }
  | { type: "thread.compaction-requested" }
  | { type: "thread.forked"; threadId: string }
  | { type: "review.started"; turnId: string }
  | { type: "plan.started"; turnId: string }
  | {
      type: "skill.started";
      skillName: string;
      turnId: string;
      steered: boolean;
    }
  | {
      type: "plugin.started";
      pluginName: string;
      turnId: string;
      steered: boolean;
    }
  | {
      type: "agents.started";
      roleName: string;
      turnId: string;
      steered: boolean;
    }
  | { type: "goal.cleared" }
  | {
      type: "goal.updated";
      goal: ThreadGoal;
    };

export class ConversationCommandService {
  constructor(private readonly conversations: ConversationUseCases) {}

  async execute(
    target: ConversationTarget,
    command: ConversationCommandName,
    input = "",
  ): Promise<ConversationCommandResult> {
    const argumentsText = input.trim();
    switch (command) {
      case "resume": {
        if (argumentsText) {
          const resumed = await this.conversations.resume(target, argumentsText);
          return {
            kind: "outcome",
            outcome: {
              type: "thread.resumed",
              threadId: resumed.threadId,
              ...(resumed.backgroundedThreadId
                ? { backgroundedThreadId: resumed.backgroundedThreadId }
                : {}),
              ...(resumed.transferredFrom
                ? { transferredFrom: resumed.transferredFrom }
                : {}),
            },
          };
        }
        const sessions = await this.conversations.listSessions(target);
        const currentThreadId = this.conversations.status(target).threadId;
        const backgroundThreadIds = this.conversations.backgroundThreadIds?.(target) ?? [];
        return {
          kind: "sessions",
          sessions,
          archived: false,
          ...(currentThreadId ? { currentThreadId } : {}),
          ...(backgroundThreadIds.length > 0 ? { backgroundThreadIds } : {}),
        };
      }
      case "sessions": {
        const sessions = await this.conversations.listSessions(target, {
          ...(argumentsText ? { searchTerm: argumentsText } : {}),
        });
        const currentThreadId = this.conversations.status(target).threadId;
        const backgroundThreadIds = this.conversations.backgroundThreadIds?.(target) ?? [];
        return {
          kind: "sessions",
          sessions,
          archived: false,
          ...(currentThreadId ? { currentThreadId } : {}),
          ...(backgroundThreadIds.length > 0 ? { backgroundThreadIds } : {}),
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
      case "new": {
        const backgroundedThreadId = await this.conversations.newSession(target);
        return {
          kind: "outcome",
          outcome: {
            type: "session.new",
            ...(backgroundedThreadId ? { backgroundedThreadId } : {}),
          },
        };
      }
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
      case "pin":
        await this.conversations.setPinned(target, true);
        return {
          kind: "outcome",
          outcome: { type: "thread.pin-updated", pinned: true },
        };
      case "unpin":
        await this.conversations.setPinned(target, false);
        return {
          kind: "outcome",
          outcome: { type: "thread.pin-updated", pinned: false },
        };
      case "status":
        return {
          kind: "status",
          status: this.conversations.status(target, {
            includeGitBranch: true,
          }),
        };
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
      case "workspaceperm": {
        const current = this.conversations.status(target).workspaceId;
        const workspace = this.conversations.listWorkspaces().find(
          (entry) => entry.id === current,
        )!;
        const update = parseWorkspacePermissionCommand(argumentsText);
        if (update === null) {
          return { kind: "workspace-permissions", workspace };
        }
        const updated = await this.conversations.updateWorkspacePermissions(
          target,
          update,
        );
        return {
          kind: "outcome",
          outcome: { type: "workspace.permissions-updated", workspace: updated },
        };
      }
      case "stop": {
        const stopped = await this.conversations.stop(target);
        return {
          kind: "outcome",
          outcome: { type: "turn.stop-requested", stopped },
        };
      }
      case "queue": {
        if (!argumentsText) {
          throw new UserFacingError("queue.usage", "Queue 参数无效");
        }
        const queued = await this.conversations.queueFollowUp(target, argumentsText);
        return {
          kind: "outcome",
          outcome: { type: "turn.follow-up-queued", position: queued.position },
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
      case "skill": {
        if (!argumentsText) {
          return {
            kind: "skills",
            entries: await this.conversations.listSkills(target),
          };
        }
        const invocation = parseSkillInvocation(argumentsText);
        const submission = await this.conversations.invokeSkill(
          target,
          invocation.selector,
          invocation.task,
        );
        return {
          kind: "outcome",
          outcome: {
            type: "skill.started",
            skillName: submission.skillName,
            turnId: submission.turnId,
            steered: submission.steered,
          },
        };
      }
      case "agents": {
        if (!argumentsText) {
          return {
            kind: "agents",
            roles: this.conversations.listAgentRoles(),
          };
        }
        const invocation = parseAgentInvocation(argumentsText);
        const submission = await this.conversations.invokeAgent(
          target,
          invocation.selector,
          invocation.task,
        );
        return {
          kind: "outcome",
          outcome: {
            type: "agents.started",
            roleName: submission.roleName,
            turnId: submission.turnId,
            steered: submission.steered,
          },
        };
      }
      case "mcp": {
        if (!argumentsText) {
          return {
            kind: "mcp",
            servers: await this.conversations.listMcpServers(target),
          };
        }
        const operation = parseMcpOperation(argumentsText);
        if (operation.type === "health") {
          return {
            kind: "mcp-health",
            report: await this.conversations.mcpHealth(target),
          };
        }
        if (operation.type === "reload") {
          await this.conversations.reloadMcpServers(target);
          return { kind: "mcp-reload" };
        }
        if (operation.type === "detail") {
          return {
            kind: "mcp-detail",
            selector: operation.selector,
            server: await this.conversations.mcpServerDetail(target, operation.selector),
            ...(operation.view ? { view: operation.view } : {}),
          };
        }
        if (operation.type === "login") {
          return {
            kind: "mcp-login",
            login: await this.conversations.loginMcpServer(target, operation.selector),
          };
        }
        return {
          kind: "mcp-resource",
          resource: await this.conversations.readMcpResource(
            target,
            operation.selector,
            operation.uri,
          ),
        };
      }
      case "plugin": {
        if (!argumentsText) {
          const catalog = await this.conversations.listPlugins(target);
          return {
            kind: "plugins",
            plugins: catalog.plugins,
            loadErrorCount: catalog.loadErrorCount,
          };
        }
        const invocation = parsePluginInvocation(argumentsText);
        const submission = await this.conversations.invokePlugin(
          target,
          invocation.selector,
          invocation.task,
        );
        return {
          kind: "outcome",
          outcome: {
            type: "plugin.started",
            pluginName: submission.pluginName,
            turnId: submission.turnId,
            steered: submission.steered,
          },
        };
      }
      case "usage":
        return {
          kind: "usage",
          result: await this.conversations.providerAccountUsage(target),
        };
      case "metrics":
        return {
          kind: "metrics",
          summary: this.conversations.requestMetrics(
            target,
            parseMetricsCommand(argumentsText),
          ),
        };
      case "limits":
        return {
          kind: "limits",
          result: await this.conversations.providerAccountLimits(target),
        };
      case "permissions":
        return {
          kind: "permissions",
          profiles: await this.conversations.listPermissionProfiles(target),
        };
      case "rules": {
        if (argumentsText === "init") {
          const result = await this.conversations.initializeProjectRules(target);
          return { kind: "project-rules", action: "initialized", ...result };
        }
        if (argumentsText === "check") {
          const result = await this.conversations.checkProjectRules(target);
          return { kind: "project-rules", action: "checked", ...result };
        }
        throw new UserFacingError("rules.usage", "Rules 参数无效");
      }
      case "diff":
        return {
          kind: "artifacts",
          view: "diff",
          artifacts: this.conversations.artifacts(target),
        };
      case "plan":
        if (argumentsText) {
          const submission = await this.conversations.startPlan(target, argumentsText);
          return {
            kind: "outcome",
            outcome: { type: "plan.started", turnId: submission.turnId },
          };
        }
        return {
          kind: "collaboration-mode",
          state: await this.conversations.togglePlanMode(target),
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

const requestMetricsTimeRanges = new Set<RequestMetricsTimeRange>([
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "this-month",
  "last-month",
  "24h",
  "7d",
  "30d",
  "90d",
  "365d",
  "all",
]);

function parseMetricsCommand(input: string): RequestMetricsCommandQuery {
  if (!input) return { view: "session" };
  const parts = input.split(/\s+/u);
  if (parts.length === 1 && parts[0] === "session") {
    return { view: "session" };
  }
  const [view, range = "24h"] = parts;
  if (
    parts.length > 2
    || !(["global", "providers", "models", "errors"] as const).includes(
      view as "global" | "providers" | "models" | "errors",
    )
    || !requestMetricsTimeRanges.has(range as RequestMetricsTimeRange)
  ) {
    throw new UserFacingError(
      "metrics.usage",
      "Metrics 参数无效；范围支持 today、yesterday、this-week、last-week、this-month、last-month、24h、7d、30d、90d、365d、all",
    );
  }
  return {
    view: view as "global" | "providers" | "models" | "errors",
    range: range as RequestMetricsTimeRange,
  };
}

function parseSkillInvocation(input: string): {
  selector: string;
  task: string;
} {
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(input.trim());
  if (!match?.[1] || !match[2]?.trim()) {
    throw new UserFacingError(
      "skill.usage",
      "用法：/skill <名称或序号> <任务>",
    );
  }
  return {
    selector: match[1],
    task: match[2].trim(),
  };
}

function parsePluginInvocation(input: string): {
  selector: string;
  task: string;
} {
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(input.trim());
  if (!match?.[1] || !match[2]?.trim()) {
    throw new UserFacingError(
      "plugin.usage",
      "用法：/plugin <名称、完整 ID 或序号> <任务>",
    );
  }
  return {
    selector: match[1],
    task: match[2].trim(),
  };
}

function parseMcpOperation(input: string):
  | { type: "health" }
  | { type: "reload" }
  | { type: "detail"; selector: string; view?: McpDetailView }
  | { type: "login"; selector: string }
  | { type: "resource"; selector: string; uri: string } {
  const parts = input.trim().split(/\s+/u);
  if (parts[0] === "health" && parts.length === 1) {
    return { type: "health" };
  }
  if (parts[0] === "reload" && parts.length === 1) {
    return { type: "reload" };
  }
  if (parts[0] === "login" && parts.length === 2) {
    return { type: "login", selector: parts[1]! };
  }
  if (parts[0] === "resource" && parts.length === 3) {
    return { type: "resource", selector: parts[1]!, uri: parts[2]! };
  }
  if (
    parts[0] === "health"
    || parts[0] === "reload"
    || parts[0] === "login"
    || parts[0] === "resource"
  ) {
    throw new UserFacingError(
      "mcp.usage",
      mcpCommandUsageText,
    );
  }
  if (parts.length === 1 && parts[0]) {
    return { type: "detail", selector: parts[0] };
  }
  const [selector, section, ...options] = parts;
  if (
    selector
    && (section === "tools" || section === "resources" || section === "templates")
  ) {
    let page = 1;
    let optionIndex = 0;
    if (options[0] && /^[1-9]\d*$/u.test(options[0])) {
      page = Number(options[0]);
      optionIndex = 1;
      if (!Number.isSafeInteger(page) || page > 10_000) {
        throw new UserFacingError("mcp.usage", mcpCommandUsageText);
      }
    }
    let searchTerm: string | null = null;
    if (options[optionIndex] === "search") {
      searchTerm = options.slice(optionIndex + 1).join(" ").trim();
      if (!searchTerm || searchTerm.length > 128) {
        throw new UserFacingError("mcp.usage", mcpCommandUsageText);
      }
      optionIndex = options.length;
    }
    if (optionIndex !== options.length) {
      throw new UserFacingError("mcp.usage", mcpCommandUsageText);
    }
    return {
      type: "detail",
      selector,
      view: { section, page, searchTerm },
    };
  }
  throw new UserFacingError(
    "mcp.usage",
    mcpCommandUsageText,
  );
}

function parseAgentInvocation(input: string): {
  selector: string;
  task: string;
} {
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(input.trim());
  if (!match?.[1] || !match[2]?.trim()) {
    throw new UserFacingError(
      "agents.usage",
      "用法：/agents <角色名称或序号> <任务>",
    );
  }
  return {
    selector: match[1],
    task: match[2].trim(),
  };
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

function parseWorkspacePermissionCommand(
  input: string,
): WorkspacePermissionUpdate | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const [field, ...rest] = trimmed.split(/\s+/u);
  const value = rest.join(" ").trim();
  if (field === "sandbox") {
    if (value === "clear") {
      return { kind: "sandbox", value: null };
    }
    if (
      value === "read-only"
      || value === "workspace-write"
      || value === "danger-full-access"
    ) {
      return { kind: "sandbox", value };
    }
  }
  if (field === "approval") {
    if (value === "clear") {
      return { kind: "approval", value: null };
    }
    if (value === "untrusted" || value === "on-request" || value === "never") {
      return { kind: "approval", value };
    }
  }
  if (field === "profile") {
    if (value === "clear") {
      return { kind: "permissions", value: null };
    }
    if (value.length > 0 && value.length <= 128) {
      return { kind: "permissions", value };
    }
  }
  throw new UserFacingError(
    "workspace.permission.usage",
    "用法：/workspaceperm [sandbox <read-only|workspace-write|danger-full-access|clear>|approval <untrusted|on-request|never|clear>|profile <Profile ID|clear>]",
  );
}
