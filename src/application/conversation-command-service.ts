import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import {
  defaultSessionListView,
  parseAgentInvocation,
  parseMcpOperation,
  parseMetricsCommand,
  parsePluginOperation,
  parseReviewTarget,
  parseSessionListView,
  parseSkillInvocation,
  parseThreadRevertOperation,
  parseThreadQueueOperation,
  parseThreadSectionOperation,
  parseWorkspacePermissionCommand,
  toSessionQuery,
  type McpDetailView,
  type PluginListView,
  type SessionListView,
} from "./conversation-command-parser.js";
import type { ConversationUseCases } from "./conversation-service.js";
import type { ThreadGoal } from "./turn-port.js";
import type { ThreadOccupancyReleaseResult } from "./thread-occupancy-port.js";
import type { SurfaceAccessPolicy } from "../policy/index.js";
import {
  parseScheduledTaskOperation,
} from "./scheduled-task-command.js";
import type { ScheduledTaskUseCases } from "./scheduled-task-service.js";

export {
  archivedSessionCommandUsageText,
  mcpCommandUsageText,
  pluginCommandUsageText,
  sessionCommandUsageText,
  threadQueueCommandUsageText,
  threadRevertCommandUsageText,
  threadSectionCommandUsageText,
  type McpDetailView,
  type PluginListView,
  type SessionListView,
} from "./conversation-command-parser.js";
export { scheduledTaskCommandUsageText } from "./scheduled-task-command.js";

export const conversationCommandNames = [
  "resume",
  "sessions",
  "archived",
  "new",
  "archive",
  "unarchive",
  "pin",
  "unpin",
  "section",
  "status",
  "workspace",
  "workspaceperm",
  "stop",
  "queue",
  "revert",
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
  "release",
  "schedule",
] as const;

export type ConversationCommandName = typeof conversationCommandNames[number];
const conversationCommandNameSet = new Set<string>(conversationCommandNames);
const maximumSessionListEntries = 20;
const maximumThreadSectionListEntries = 8;
const maximumPluginListEntries = 8;

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
      page: number;
      pageCount: number;
      matchedSessionCount: number;
      view: SessionListView;
    }
  | {
      kind: "thread-sections";
      sections: Awaited<ReturnType<ConversationUseCases["listThreadSections"]>>;
      selectors: string[];
      page: number;
      pageCount: number;
      totalSectionCount: number;
      canManageCustomSections: boolean;
    }
  | {
      kind: "thread-section-delete-preview";
      preview: Awaited<ReturnType<ConversationUseCases["previewThreadSectionDelete"]>>;
    }
  | {
      kind: "thread-queue";
      result: Awaited<ReturnType<ConversationUseCases["queueList"]>>;
    }
  | {
      kind: "thread-revert";
      result: Awaited<ReturnType<ConversationUseCases["revertList"]>>;
    }
  | {
      kind: "thread-revert-preview";
      preview: Awaited<ReturnType<ConversationUseCases["revertPreview"]>>;
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
      selectors: string[];
      loadErrorCount: number;
      totalPluginCount: number;
      matchedPluginCount: number;
      page: number;
      pageCount: number;
      searchTerm: string | null;
    }
  | { kind: "plugin-health"; report: Awaited<ReturnType<ConversationUseCases["pluginHealth"]>> }
  | {
      kind: "plugin-detail";
      plugin: Awaited<ReturnType<ConversationUseCases["pluginDetail"]>>;
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
  | { kind: "agents"; roles: Awaited<ReturnType<ConversationUseCases["listAgentRoles"]>> }
  | {
      kind: "occupancy";
      result: ThreadOccupancyReleaseResult;
    }
  | {
      kind: "scheduled-tasks";
      result: ReturnType<ScheduledTaskUseCases["list"]>;
    }
  | {
      kind: "scheduled-runs";
      result: ReturnType<ScheduledTaskUseCases["runs"]>;
    }
  | {
      kind: "scheduled-confirmation";
      preview:
        | ReturnType<ScheduledTaskUseCases["previewCreate"]>
        | ReturnType<ScheduledTaskUseCases["previewDelete"]>;
    };

export interface ConversationModelSummary {
  model: string;
  modelProvider?: string;
}

export type ConversationCommandOutcome =
  | {
      type: "thread.resumed";
      threadId: string;
      backgroundedThreadId?: string;
      transferredFrom?: string;
      queuePending?: boolean;
      model: ConversationModelSummary;
    }
  | {
      type: "session.new";
      backgroundedThreadId?: string;
      nextModel: ConversationModelSummary;
    }
  | { type: "thread.archived"; threadId: string }
  | { type: "thread.unarchived"; threadId: string }
  | { type: "thread.pin-updated"; pinned: boolean; changed: boolean }
  | { type: "thread-section.created"; sectionId: string; name: string }
  | { type: "thread-section.renamed"; sectionId: string; name: string }
  | { type: "thread-section.moved"; sectionId: string; name: string; pinned: boolean; ordered: boolean }
  | { type: "thread-section.removed" }
  | { type: "thread-section.deleted"; sectionId: string; name: string }
  | {
      type: "workspace.selected";
      workspace: Awaited<ReturnType<ConversationUseCases["selectWorkspace"]>>;
      nextModel: ConversationModelSummary;
    }
  | {
      type: "workspace.permissions-updated";
      workspace: Awaited<ReturnType<ConversationUseCases["updateWorkspacePermissions"]>>;
    }
  | { type: "turn.stop-requested"; stopped: boolean }
  | {
      type: "thread-queue.added";
      item: Awaited<ReturnType<ConversationUseCases["queueAdd"]>>;
    }
  | {
      type: "thread-queue.updated";
      item: Awaited<ReturnType<ConversationUseCases["queueUpdate"]>>;
    }
  | {
      type: "thread-queue.deleted";
      deleted: boolean;
    }
  | {
      type: "thread-queue.reordered";
      itemId: string;
      position: number;
      totalItemCount: number;
    }
  | { type: "thread-queue.started"; turnId: string }
  | { type: "thread.reverted"; threadId: string; beforeTurnId: string }
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
    }
  | {
      type:
        | "scheduled-task.created"
        | "scheduled-task.deleted"
        | "scheduled-task.renamed"
        | "scheduled-task.paused"
        | "scheduled-task.resumed";
      task: ReturnType<ScheduledTaskUseCases["rename"]>;
    }
  | {
      type: "scheduled-task.run-requested" | "scheduled-task.retry-requested";
      run: Awaited<ReturnType<ScheduledTaskUseCases["run"]>>;
    };

export class ConversationCommandService {
  constructor(
    private readonly conversations: ConversationUseCases,
    private readonly threadSectionAccess?: SurfaceAccessPolicy,
    private readonly scheduledTasks?: ScheduledTaskUseCases,
  ) {}

  async execute(
    target: ConversationTarget,
    command: ConversationCommandName,
    input = "",
    actorId?: string,
  ): Promise<ConversationCommandResult> {
    const argumentsText = input.trim();
    switch (command) {
      case "resume": {
        if (argumentsText) {
          const resumed = await this.conversations.resume(target, argumentsText);
          const model = toConversationModelSummary(this.conversations.status(target));
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
              ...(resumed.queuePending ? { queuePending: true } : {}),
              model,
            },
          };
        }
        const view = defaultSessionListView();
        const sessions = await this.conversations.listSessions(target);
        const currentThreadId = this.conversations.status(target).threadId;
        const backgroundThreadIds = this.conversations.backgroundThreadIds?.(target) ?? [];
        return sessionListResult(sessions, view, {
          archived: false,
          ...(currentThreadId ? { currentThreadId } : {}),
          ...(backgroundThreadIds.length > 0 ? { backgroundThreadIds } : {}),
        });
      }
      case "sessions": {
        const view = parseSessionListView(argumentsText, false);
        const sessions = await this.conversations.listSessions(target, toSessionQuery(view));
        const currentThreadId = this.conversations.status(target).threadId;
        const backgroundThreadIds = this.conversations.backgroundThreadIds?.(target) ?? [];
        return sessionListResult(sessions, view, {
          archived: false,
          ...(currentThreadId ? { currentThreadId } : {}),
          ...(backgroundThreadIds.length > 0 ? { backgroundThreadIds } : {}),
        });
      }
      case "archived": {
        const view = parseSessionListView(argumentsText, true);
        const sessions = await this.conversations.listSessions(target, {
          archived: true,
          ...toSessionQuery(view),
        });
        return sessionListResult(sessions, view, { archived: true });
      }
      case "new": {
        const backgroundedThreadId = await this.conversations.newSession(target);
        const nextModel = toConversationModelSummary(this.conversations.status(target));
        return {
          kind: "outcome",
          outcome: {
            type: "session.new",
            ...(backgroundedThreadId ? { backgroundedThreadId } : {}),
            nextModel,
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
        {
          const changed = await this.conversations.setPinned(target, true);
          return {
            kind: "outcome",
            outcome: { type: "thread.pin-updated", pinned: true, changed },
          };
        }
      case "unpin":
        {
          const changed = await this.conversations.setPinned(target, false);
          return {
            kind: "outcome",
            outcome: { type: "thread.pin-updated", pinned: false, changed },
          };
        }
      case "section": {
        const operation = parseThreadSectionOperation(argumentsText);
        const canManageCustomSections = Boolean(
          actorId
          && this.threadSectionAccess?.isAllowed({ target, actorId }),
        );
        if (operation.type === "list") {
          const sections = await this.conversations.listThreadSections(target);
          const pageCount = Math.max(
            1,
            Math.ceil(sections.length / maximumThreadSectionListEntries),
          );
          const start = (operation.page - 1) * maximumThreadSectionListEntries;
          const entries = sections.map((section, index) => ({
            section,
            selector: String(index + 1),
          }));
          const pageEntries = operation.page <= pageCount
            ? entries.slice(start, start + maximumThreadSectionListEntries)
            : [];
          return {
            kind: "thread-sections",
            sections: pageEntries.map(({ section }) => section),
            selectors: pageEntries.map(({ selector }) => selector),
            page: operation.page,
            pageCount,
            totalSectionCount: sections.length,
            canManageCustomSections,
          };
        }
        if (!canManageCustomSections) {
          throw new UserFacingError(
            "thread-section.admin-required",
            "只有配置的 Thread 分区管理员可以修改全局分区",
          );
        }
        if (operation.type === "create") {
          const section = await this.conversations.createThreadSection(target, operation.name);
          return {
            kind: "outcome",
            outcome: { type: "thread-section.created", sectionId: section.id, name: section.name },
          };
        }
        if (operation.type === "rename") {
          const section = await this.conversations.renameThreadSection(
            target,
            operation.selector,
            operation.name,
          );
          return {
            kind: "outcome",
            outcome: { type: "thread-section.renamed", sectionId: section.id, name: section.name },
          };
        }
        if (operation.type === "move") {
          const section = await this.conversations.moveCurrentThreadToSection(
            target,
            operation.selector,
            operation.beforeThreadSelector ?? undefined,
          );
          return {
            kind: "outcome",
            outcome: {
              type: "thread-section.moved",
              sectionId: section.id,
              name: section.name,
              pinned: section.builtIn === "pinned",
              ordered: operation.beforeThreadSelector !== null,
            },
          };
        }
        if (operation.type === "remove") {
          await this.conversations.removeCurrentThreadSection(target);
          return { kind: "outcome", outcome: { type: "thread-section.removed" } };
        }
        if (!operation.confirmed) {
          return {
            kind: "thread-section-delete-preview",
            preview: await this.conversations.previewThreadSectionDelete(
              target,
              operation.selector,
            ),
          };
        }
        const section = await this.conversations.deleteThreadSection(
          target,
          operation.selector,
        );
        return {
          kind: "outcome",
          outcome: { type: "thread-section.deleted", sectionId: section.id, name: section.name },
        };
      }
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
            outcome: {
              type: "workspace.selected",
              workspace,
              nextModel: toConversationModelSummary(this.conversations.status(target)),
            },
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
        const operation = parseThreadQueueOperation(argumentsText);
        if (operation.type === "list") {
          return {
            kind: "thread-queue",
            result: await this.conversations.queueList(target, operation.page),
          };
        }
        if (operation.type === "add") {
          return {
            kind: "outcome",
            outcome: {
              type: "thread-queue.added",
              item: await this.conversations.queueAdd(target, operation.text),
            },
          };
        }
        if (operation.type === "update") {
          return {
            kind: "outcome",
            outcome: {
              type: "thread-queue.updated",
              item: await this.conversations.queueUpdate(
                target,
                operation.selector,
                operation.text,
              ),
            },
          };
        }
        if (operation.type === "delete") {
          const result = await this.conversations.queueDelete(target, operation.selector);
          return {
            kind: "outcome",
            outcome: { type: "thread-queue.deleted", deleted: result.deleted },
          };
        }
        if (operation.type === "reorder") {
          const result = await this.conversations.queueReorder(
            target,
            operation.selector,
            operation.position,
          );
          return {
            kind: "outcome",
            outcome: {
              type: "thread-queue.reordered",
              itemId: result.itemId,
              position: result.position,
              totalItemCount: result.totalItemCount,
            },
          };
        }
        const result = await this.conversations.queueStart(target, operation.selector);
        return {
          kind: "outcome",
          outcome: { type: "thread-queue.started", turnId: result.turnId },
        };
      }
      case "revert": {
        const operation = parseThreadRevertOperation(argumentsText);
        if (operation.type === "list") {
          return {
            kind: "thread-revert",
            result: await this.conversations.revertList(target, operation.page),
          };
        }
        if (operation.type === "preview") {
          return {
            kind: "thread-revert-preview",
            preview: await this.conversations.revertPreview(
              target,
              operation.selector,
              actorId,
            ),
          };
        }
        const result = await this.conversations.revertConfirm(target, operation.token, actorId);
        return {
          kind: "outcome",
          outcome: {
            type: "thread.reverted",
            threadId: result.threadId,
            beforeTurnId: result.beforeTurnId,
          },
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
          state: argumentsText === "clear"
            ? await this.conversations.clearModelSelection(target)
            : argumentsText
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
        const operation = parsePluginOperation(argumentsText);
        if (operation.type === "list") {
          const catalog = await this.conversations.listPlugins(target);
          return pluginListResult(catalog, operation.view);
        }
        if (operation.type === "health") {
          return {
            kind: "plugin-health",
            report: await this.conversations.pluginHealth(target),
          };
        }
        if (operation.type === "detail") {
          return {
            kind: "plugin-detail",
            plugin: await this.conversations.pluginDetail(target, operation.selector),
          };
        }
        const submission = await this.conversations.invokePlugin(
          target,
          operation.selector,
          operation.task,
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
      case "release": {
        const force = argumentsText === "force";
        if (argumentsText !== "" && !force) {
          throw new UserFacingError(
            "release.usage",
            "Release 参数无效，用法：/release 或 /release force",
          );
        }
        return {
          kind: "occupancy",
          result: await this.conversations.releaseThread(target, force),
        };
      }
      case "schedule": {
        const scheduled = this.scheduledTasks;
        if (!scheduled) {
          throw new UserFacingError(
            "scheduled-task.state.invalid",
            "Gateway 计划任务功能未启用",
          );
        }
        if (!actorId) {
          throw new UserFacingError(
            "scheduled-task.forbidden",
            "无法确认当前渠道用户身份",
          );
        }
        const operation = parseScheduledTaskOperation(argumentsText);
        switch (operation.type) {
          case "create":
            return {
              kind: "scheduled-confirmation",
              preview: scheduled.previewCreate(target, actorId, operation.request),
            };
          case "list":
            return { kind: "scheduled-tasks", result: scheduled.list(target, actorId, operation.page) };
          case "runs":
            return {
              kind: "scheduled-runs",
              result: scheduled.runs(target, actorId, operation.selector, operation.page),
            };
          case "rename":
            return {
              kind: "outcome",
              outcome: {
                type: "scheduled-task.renamed",
                task: scheduled.rename(target, actorId, operation.selector, operation.name),
              },
            };
          case "pause":
          case "resume": {
            const task = scheduled[operation.type](target, actorId, operation.selector);
            return {
              kind: "outcome",
              outcome: {
                type: operation.type === "pause"
                  ? "scheduled-task.paused"
                  : "scheduled-task.resumed",
                task,
              },
            };
          }
          case "run":
          case "retry": {
            const run = await scheduled[operation.type](target, actorId, operation.selector);
            return {
              kind: "outcome",
              outcome: {
                type: operation.type === "run"
                  ? "scheduled-task.run-requested"
                  : "scheduled-task.retry-requested",
                run,
              },
            };
          }
          case "delete":
            return {
              kind: "scheduled-confirmation",
              preview: scheduled.previewDelete(target, actorId, operation.selector),
            };
          case "confirm": {
            const confirmed = scheduled.confirm(target, actorId, operation.token);
            return {
              kind: "outcome",
              outcome: {
                type: confirmed.action === "created"
                  ? "scheduled-task.created"
                  : "scheduled-task.deleted",
                task: confirmed.task,
              },
            };
          }
        }
      }
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

function toConversationModelSummary(
  status: ReturnType<ConversationUseCases["status"]>,
): ConversationModelSummary {
  return {
    model: status.model,
    ...(status.modelProvider ? { modelProvider: status.modelProvider } : {}),
  };
}

function sessionListResult(
  sessions: Awaited<ReturnType<ConversationUseCases["listSessions"]>>,
  view: SessionListView,
  metadata: {
    archived: boolean;
    currentThreadId?: string;
    backgroundThreadIds?: string[];
  },
): Extract<ConversationCommandResult, { kind: "sessions" }> {
  const pageCount = Math.max(1, Math.ceil(sessions.length / maximumSessionListEntries));
  const start = (view.page - 1) * maximumSessionListEntries;
  return {
    kind: "sessions",
    sessions: view.page <= pageCount
      ? sessions.slice(start, start + maximumSessionListEntries)
      : [],
    archived: metadata.archived,
    page: view.page,
    pageCount,
    matchedSessionCount: sessions.length,
    view,
    ...(metadata.currentThreadId ? { currentThreadId: metadata.currentThreadId } : {}),
    ...(metadata.backgroundThreadIds?.length
      ? { backgroundThreadIds: metadata.backgroundThreadIds }
      : {}),
  };
}

function pluginListResult(
  catalog: Awaited<ReturnType<ConversationUseCases["listPlugins"]>>,
  view: PluginListView,
): Extract<ConversationCommandResult, { kind: "plugins" }> {
  const normalizedSearch = view.searchTerm?.toLowerCase() ?? null;
  const indexed = catalog.plugins.map((plugin, index) => ({
    plugin,
    selector: String(index + 1),
  }));
  const matches = normalizedSearch
    ? indexed.filter(({ plugin }) => [
        plugin.id,
        plugin.name,
        plugin.displayName,
        plugin.marketplaceName,
        plugin.description,
        plugin.developerName,
        plugin.category,
        ...plugin.capabilities,
      ].some((value) => value?.toLowerCase().includes(normalizedSearch)))
    : indexed;
  const pageCount = Math.max(1, Math.ceil(matches.length / maximumPluginListEntries));
  const pageStart = (view.page - 1) * maximumPluginListEntries;
  const pageEntries = view.page <= pageCount
    ? matches.slice(pageStart, pageStart + maximumPluginListEntries)
    : [];
  return {
    kind: "plugins",
    plugins: pageEntries.map(({ plugin }) => plugin),
    selectors: pageEntries.map(({ selector }) => selector),
    loadErrorCount: catalog.loadErrorCount,
    totalPluginCount: catalog.plugins.length,
    matchedPluginCount: matches.length,
    page: view.page,
    pageCount,
    searchTerm: view.searchTerm,
  };
}
