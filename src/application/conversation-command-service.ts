import type { ConversationResetCreditService, ConversationResetCreditResult } from "./conversation-reset-credit-service.js";
import type { HookCommandView } from "./hook-port.js";
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
  toSessionQuery,
  type McpDetailView,
  type PluginListView,
  type SessionListView,
} from "./conversation-command-parser.js";
import type {
  ConversationAccountMetricsUseCases,
  ConversationExtensionUseCases,
  ConversationQueueRevertUseCases,
  ConversationSessionUseCases,
  ConversationTurnUseCases,
  Submission,
} from "./conversation-service.js";
import type { ThreadGoal } from "./turn-port.js";
import type { ThreadOccupancyReleaseResult } from "./thread-occupancy-port.js";
import {
  parseScheduledTaskOperation,
} from "./scheduled-task-command.js";
import type { ScheduledTaskUseCases } from "./scheduled-task-service.js";
import type { ScheduledTaskOperationContext } from "../scheduled-tasks/index.js";
import { resolveProvider, type ModelSelectionIdentity, type ModelSelectionRequest, type ModelSelectionState } from "./model-selection-service.js";
import { pageCountFor, pageSlice } from "./pagination.js";

export {
  archivedSessionCommandUsageText,
  mcpCommandUsageText,
  pluginCommandUsageText,
  sessionCommandUsageText,
  threadQueueCommandUsageText,
  threadRevertCommandUsageText,
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
  "status",
  "workspace",
  "autoreview",
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
  "hooks",
  "usage",
  "metrics",
  "limits",
  "permissions",
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
const maximumPluginListEntries = 8;

export type ConversationCommandUseCases =
  & Omit<ConversationTurnUseCases, "submit">
  & Omit<
    ConversationSessionUseCases,
    "invalidateSessionDisplayCache" | "releaseIdle"
  >
  & ConversationQueueRevertUseCases
  & ConversationExtensionUseCases
  & Pick<
    ConversationAccountMetricsUseCases,
    "providerAccountUsage" | "providerAccountLimits" | "requestMetrics"
  >;

export function isConversationCommandName(value: string): value is ConversationCommandName {
  return conversationCommandNameSet.has(value);
}

export type ConversationCommandResult =
  | { kind: "hooks"; view: HookCommandView }
  | { kind: "auto-review"; state: ReturnType<ConversationCommandUseCases["autoReview"]> }
  | { kind: "reset-credit"; result: ConversationResetCreditResult }
  | { kind: "outcome"; outcome: ConversationCommandOutcome }
  | {
      kind: "sessions";
      sessions: Awaited<ReturnType<ConversationCommandUseCases["listSessions"]>>;
      currentThreadId?: string;
      backgroundThreadIds?: string[];
      archived: boolean;
      page: number;
      pageCount: number;
      matchedSessionCount: number;
      view: SessionListView;
    }
  | {
      kind: "thread-queue";
      result: Awaited<ReturnType<ConversationCommandUseCases["queueList"]>>;
    }
  | {
      kind: "thread-revert";
      result: Awaited<ReturnType<ConversationCommandUseCases["revertList"]>>;
    }
  | {
      kind: "thread-revert-preview";
      preview: Awaited<ReturnType<ConversationCommandUseCases["revertPreview"]>>;
    }
  | { kind: "status"; status: ReturnType<ConversationCommandUseCases["status"]> }
  | {
      kind: "workspaces";
      workspaces: ReturnType<ConversationCommandUseCases["listWorkspaces"]>;
      currentWorkspaceId: string;
    }
  | {
      kind: "models";
      view: "model" | "effort" | "fast";
      nextSelection?: "effort";
      state: Awaited<ReturnType<ConversationCommandUseCases["modelState"]>>;
    }
  | {
      kind: "collaboration-mode";
      state: Awaited<ReturnType<ConversationCommandUseCases["togglePlanMode"]>>;
    }
  | { kind: "skills"; entries: Awaited<ReturnType<ConversationCommandUseCases["listSkills"]>> }
  | { kind: "mcp"; servers: Awaited<ReturnType<ConversationCommandUseCases["listMcpServers"]>> }
  | { kind: "mcp-health"; report: Awaited<ReturnType<ConversationCommandUseCases["mcpHealth"]>> }
  | { kind: "mcp-reload" }
  | {
      kind: "mcp-detail";
      selector: string;
      server: Awaited<ReturnType<ConversationCommandUseCases["mcpServerDetail"]>>;
      view?: McpDetailView;
    }
  | { kind: "mcp-login"; login: Awaited<ReturnType<ConversationCommandUseCases["loginMcpServer"]>> }
  | { kind: "mcp-resource"; resource: Awaited<ReturnType<ConversationCommandUseCases["readMcpResource"]>> }
  | {
      kind: "plugins";
      plugins: Awaited<ReturnType<ConversationCommandUseCases["listPlugins"]>>["plugins"];
      selectors: string[];
      loadErrorCount: number;
      totalPluginCount: number;
      matchedPluginCount: number;
      page: number;
      pageCount: number;
      searchTerm: string | null;
    }
  | { kind: "plugin-health"; report: Awaited<ReturnType<ConversationCommandUseCases["pluginHealth"]>> }
  | {
      kind: "plugin-detail";
      plugin: Awaited<ReturnType<ConversationCommandUseCases["pluginDetail"]>>;
    }
  | { kind: "usage"; result: Awaited<ReturnType<ConversationCommandUseCases["providerAccountUsage"]>> }
  | { kind: "metrics"; summary: Awaited<ReturnType<ConversationCommandUseCases["requestMetrics"]>> }
  | { kind: "limits"; result: Awaited<ReturnType<ConversationCommandUseCases["providerAccountLimits"]>> }
  | {
      kind: "permissions";
      profiles: Awaited<ReturnType<ConversationCommandUseCases["listPermissionProfiles"]>>;
      workspace?: Awaited<ReturnType<ConversationCommandUseCases["listWorkspaces"]>>[number];
    }
  | {
      kind: "artifacts";
      view: "diff";
      artifacts: ReturnType<ConversationCommandUseCases["artifacts"]>;
    }
  | { kind: "goal"; goal: ThreadGoal | null }
  | { kind: "agents"; roles: Awaited<ReturnType<ConversationCommandUseCases["listAgentRoles"]>> }
  | {
      kind: "occupancy";
      result: ThreadOccupancyReleaseResult;
    }
  | {
      kind: "scheduled-tasks";
      result: Awaited<ReturnType<ScheduledTaskUseCases["list"]>>;
    }
  | {
      kind: "scheduled-runs";
      result: Awaited<ReturnType<ScheduledTaskUseCases["runs"]>>;
    }
  | {
      kind: "scheduled-confirmation";
      preview:
        | Awaited<ReturnType<ScheduledTaskUseCases["previewCreate"]>>
        | Awaited<ReturnType<ScheduledTaskUseCases["previewDelete"]>>;
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
      previousThreadId?: string;
      backgroundedThreadId?: string;
      nextModel: ConversationModelSummary;
    }
  | { type: "thread.archived"; threadId: string }
  | { type: "sessions.cleaned"; maxTurns: number; archivedCount: number; failedCount: number }
  | { type: "thread.unarchived"; threadId: string }
  | { type: "thread.pin-updated"; pinned: boolean; changed: boolean }
  | {
      type: "workspace.selected";
      workspace: Awaited<ReturnType<ConversationCommandUseCases["selectWorkspace"]>>;
      nextModel: ConversationModelSummary;
    }
  | { type: "turn.stop-requested"; stopped: boolean }
  | {
      type: "thread-queue.added";
      item: Awaited<ReturnType<ConversationCommandUseCases["queueAdd"]>>;
    }
  | {
      type: "thread-queue.updated";
      item: Awaited<ReturnType<ConversationCommandUseCases["queueUpdate"]>>;
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
      task: Awaited<ReturnType<ScheduledTaskUseCases["rename"]>>;
    }
  | {
      type: "scheduled-task.run-requested" | "scheduled-task.retry-requested";
      run: Awaited<ReturnType<ScheduledTaskUseCases["run"]>>;
    };

function modelSelectionResult(state: ModelSelectionState): ConversationCommandResult {
  const selected = state.models.find((model) =>
    model.model === state.model
    && (model.provider ?? "openai") === (state.modelProvider ?? "openai"));
  const shouldSelectEffort = (selected?.supportedReasoningEfforts.length ?? 0) > 1;
  return {
    kind: "models",
    view: shouldSelectEffort ? "effort" : "model",
    ...(shouldSelectEffort ? { nextSelection: "effort" as const } : {}),
    state,
  };
}

export interface ConversationCommandExecutor {
  selectWorkspace(target: ConversationTarget, workspaceId: string, actorId: string): Promise<ConversationCommandResult>;
  selectAutoReview(target: ConversationTarget, selection: { threadId: string; enabled: boolean }, actorId: string): Promise<ConversationCommandResult>;
  selectModel(target: ConversationTarget, selection: ModelSelectionIdentity, actorId: string): Promise<ConversationCommandResult>;
  selectModelSetting(target: ConversationTarget, selection: ModelSelectionRequest, actorId: string, assertInteractionActive?: () => void): Promise<ConversationCommandResult>;
  execute(
    target: ConversationTarget,
    command: ConversationCommandName,
    input: string,
    actorId: string,
    isAllowed?: () => boolean,
    captureReplyAuthorization?: (authorize: () => void) => void,
    captureSubmission?: (submission: Promise<Submission>) => Promise<void>,
  ): Promise<ConversationCommandResult>;
}

export class ConversationCommandService implements ConversationCommandExecutor {
  private readonly scheduledTasks: ScheduledTaskUseCases | undefined;
  constructor(
    private readonly conversations: ConversationCommandUseCases,
    scheduledTasks?: ScheduledTaskUseCases,
    private readonly resetCredits?: ConversationResetCreditService,
    private readonly authorize: (target: ConversationTarget, actorId: string) => void = () => {
      throw new UserFacingError("command.authorization-changed", "命令授权不可用");
    },
  ) {
    this.scheduledTasks = scheduledTasks;
  }

  async selectWorkspace(target: ConversationTarget, workspaceId: string, actorId: string): Promise<ConversationCommandResult> {
    const assertAuthorized = this.commandGuard(target, actorId, true);
    this.conversations.touchActivity?.(target);
    const result = await this.selectWorkspaceResult(target, { id: workspaceId }, assertAuthorized);
    this.authorize(target, actorId);
    return result;
  }

  private async selectWorkspaceResult(target: ConversationTarget, selector: string | { id: string },
    assertAuthorized: () => void): Promise<ConversationCommandResult> {
    const workspace = await this.conversations.selectWorkspace(target, selector, assertAuthorized);
    return { kind: "outcome", outcome: {
      type: "workspace.selected", workspace,
      nextModel: toConversationModelSummary(this.conversations.status(target)),
    } };
  }

  async selectModel(target: ConversationTarget, selection: ModelSelectionIdentity, actorId: string): Promise<ConversationCommandResult> {
    const assertAuthorized = this.commandGuard(target, actorId, false);
    this.conversations.touchActivity?.(target);
    const state = await this.conversations.selectModel(target, selection, assertAuthorized);
    assertAuthorized();
    return modelSelectionResult(state);
  }

  async selectModelSetting(target: ConversationTarget, selection: ModelSelectionRequest, actorId: string, assertInteractionActive?: () => void): Promise<ConversationCommandResult> {
    const authorize = this.commandGuard(target, actorId, false);
    const guard = () => { authorize(); assertInteractionActive?.(); };
    guard();
    this.conversations.touchActivity?.(target);
    const state = await this.conversations.selectModelSetting(target, selection, guard);
    guard();
    return selection.kind === "model"
      ? modelSelectionResult(state)
      : { kind: "models", view: selection.kind === "browse-provider" ? "model" : selection.kind, state };
  }

  async selectAutoReview(target: ConversationTarget, selection: { threadId: string; enabled: boolean }, actorId: string): Promise<ConversationCommandResult> {
    const assertAuthorized = this.commandGuard(target, actorId, false);
    this.conversations.touchActivity?.(target);
    const state = await this.conversations.updateAutoReview(target, selection.enabled, selection.threadId, assertAuthorized);
    assertAuthorized();
    return { kind: "auto-review", state };
  }

  async execute(
    target: ConversationTarget,
    command: ConversationCommandName,
    input: string,
    actorId: string,
    isAllowed?: () => boolean,
    captureReplyAuthorization?: (authorize: () => void) => void,
    captureSubmission?: (submission: Promise<Submission>) => Promise<void>,
  ): Promise<ConversationCommandResult> {
    const assertActive = () => {
      if (isAllowed?.() === false) throw new UserFacingError("command.authorization-changed", "命令来源已关闭或授权已变化");
    };
    assertActive();
    const guard = this.commandGuard(target, actorId, command === "workspace");
    const sessionMetrics = command === "metrics" && parseMetricsCommand(input.trim()).view === "session"
      ? { threadId: this.conversations.status(target).threadId }
      : undefined;
    const assertMetricsThread = (): void => {
      if (sessionMetrics && this.conversations.status(target).threadId !== sessionMetrics.threadId) {
        throw new UserFacingError("command.authorization-changed", "指标查询对应的会话已变化，请重新查询。");
      }
    };
    const assertAuthorized = () => { assertActive(); guard(); assertMetricsThread(); };
    const result = await this.executeAuthorized(target, command, input, actorId, assertAuthorized, captureSubmission);
    try {
      assertActive();
      if (command === "workspace" && input.trim()) this.authorize(target, actorId);
      else assertAuthorized();
      if (captureReplyAuthorization) {
        const replyGuard = this.commandGuard(target, actorId, command === "workspace");
        const hasWorkspace = this.conversations.listWorkspaces().some(workspace =>
          workspace.id === this.conversations.selectedWorkspaceId(target));
        const replyThread = hasWorkspace ? this.conversations.status(target).threadId : undefined;
        captureReplyAuthorization(() => {
          assertActive(); replyGuard(); assertMetricsThread();
          if (hasWorkspace && this.conversations.status(target).threadId !== replyThread) {
            throw new UserFacingError("command.authorization-changed", "命令回复对应的会话已变化");
          }
        });
      }
    } catch (error) {
      if (result.kind === "scheduled-confirmation") this.scheduledTasks?.cancelConfirmation(result.preview.token);
      throw error;
    }
    return result;
  }

  private commandGuard(target: ConversationTarget, actorId: string, allowMissingWorkspace: boolean): () => void {
    this.authorize(target, actorId);
    const workspaceId = this.conversations.selectedWorkspaceId(target);
    const workspace = this.conversations.listWorkspaces().find(entry => entry.id === workspaceId);
    if (!workspace && !allowMissingWorkspace) {
      throw new UserFacingError("workspace.missing", "Workspace 不存在或未获授权", { workspaceId });
    }
    return () => {
      this.authorize(target, actorId);
      const currentId = this.conversations.selectedWorkspaceId(target);
      const current = this.conversations.listWorkspaces().find(entry => entry.id === currentId);
      if (currentId !== workspaceId || current?.cwd !== workspace?.cwd) {
        throw new UserFacingError("command.authorization-changed", "命令工作区已变化");
      }
    };
  }

  private async executeAuthorized(
    target: ConversationTarget,
    command: ConversationCommandName,
    input: string,
    actorId: string,
    assertAuthorized: () => void,
    captureSubmission?: (submission: Promise<Submission>) => Promise<void>,
  ): Promise<ConversationCommandResult> {
    this.conversations.touchActivity?.(target);
    const argumentsText = input.trim();
    switch (command) {
      case "hooks":
        return { kind: "hooks", view: await this.conversations.hooks(target, argumentsText, actorId) };
      case "autoreview": {
        if (!argumentsText) return { kind: "auto-review", state: this.conversations.autoReview(target) };
        if (argumentsText !== "on" && argumentsText !== "off") {
          throw new UserFacingError("autoreview.usage", "用法：/autoreview [on|off]");
        }
        return { kind: "auto-review", state: await this.conversations.updateAutoReview(target, argumentsText === "on", undefined, assertAuthorized) };
      }
      case "resume": {
        if (argumentsText) {
          const resumed = await this.conversations.resume(target, argumentsText, assertAuthorized);
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
        // `/resume` is the fast switching entry point.  Do not trigger the
        // optional per-session turn-history scan while rendering the picker.
        const sessions = await this.conversations.listSessions(target, {
          page: view.page,
          turnCountMode: "cached",
        }, assertAuthorized);
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
        const sessions = await this.conversations.listSessions(target, {
          ...toSessionQuery(view),
          turnCountMode: "cached",
        }, assertAuthorized);
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
          turnCountMode: "cached",
        }, assertAuthorized);
        return sessionListResult(sessions, view, { archived: true });
      }
      case "new": {
        const sessionSwitch = await this.conversations.newSession(target, assertAuthorized);
        const nextModel = toConversationModelSummary(this.conversations.status(target));
        return {
          kind: "outcome",
          outcome: {
            type: "session.new",
            ...(sessionSwitch.previousThreadId
              ? { previousThreadId: sessionSwitch.previousThreadId }
              : {}),
            ...(sessionSwitch.backgroundedThreadId
              ? { backgroundedThreadId: sessionSwitch.backgroundedThreadId }
              : {}),
            nextModel,
          },
        };
      }
      case "archive": {
        const threadId = await this.conversations.archive(target, assertAuthorized);
        return {
          kind: "outcome",
          outcome: { type: "thread.archived", threadId },
        };
      }
      case "unarchive": {
        const threadId = await this.conversations.unarchive(target, argumentsText, assertAuthorized);
        return {
          kind: "outcome",
          outcome: { type: "thread.unarchived", threadId },
        };
      }
      case "pin":
        {
          const changed = await this.conversations.setPinned(target, true, assertAuthorized);
          return {
            kind: "outcome",
            outcome: { type: "thread.pin-updated", pinned: true, changed },
          };
        }
      case "unpin":
        {
          const changed = await this.conversations.setPinned(target, false, assertAuthorized);
          return {
            kind: "outcome",
            outcome: { type: "thread.pin-updated", pinned: false, changed },
          };
        }
      case "status":
        return {
          kind: "status",
          status: await this.conversations.statusForDisplay(target),
        };
      case "workspace": {
        if (argumentsText) {
          return this.selectWorkspaceResult(target, argumentsText, assertAuthorized);
        }
        return {
          kind: "workspaces",
          workspaces: this.conversations.listWorkspaces(),
          currentWorkspaceId: this.conversations.selectedWorkspaceId(target),
        };
      }
      case "stop": {
        const stopped = await this.conversations.stop(target, assertAuthorized);
        return {
          kind: "outcome",
          outcome: { type: "turn.stop-requested", stopped },
        };
      }
      case "queue":
        return this.executeQueueCommand(target, argumentsText, assertAuthorized);
      case "revert":
        return this.executeRevertCommand(target, argumentsText, actorId, assertAuthorized);
      case "rename":
        await this.conversations.rename(target, argumentsText, assertAuthorized);
        return {
          kind: "outcome",
          outcome: { type: "thread.renamed", name: argumentsText },
        };
      case "compact":
        await this.conversations.compact(target, assertAuthorized);
        return {
          kind: "outcome",
          outcome: { type: "thread.compaction-requested" },
        };
      case "fork": {
        const threadId = await this.conversations.fork(target, assertAuthorized);
        return {
          kind: "outcome",
          outcome: { type: "thread.forked", threadId },
        };
      }
      case "review": {
        const reviewTarget = parseReviewTarget(argumentsText);
        const submission = await this.submitCommand(() => this.conversations.review(
          target,
          reviewTarget,
          assertAuthorized,
        ), captureSubmission);
        return {
          kind: "outcome",
          outcome: { type: "review.started", turnId: submission.turnId },
        };
      }
      case "model": {
        if (!argumentsText || argumentsText === "clear") {
          return {
            kind: "models",
            view: "model",
            state: argumentsText === "clear"
              ? await this.conversations.clearModelSelection(target, assertAuthorized)
              : await this.conversations.clearModelBrowse(target, assertAuthorized),
            };
        }
        const browseState = await this.conversations.modelState(target, assertAuthorized);
        if (
          browseState.providerFilter === undefined
          && (/^\d+$/u.test(argumentsText)
            || resolveProvider(browseState.models, argumentsText) !== undefined)
        ) {
          return {
            kind: "models",
            view: "model",
            state: await this.conversations.browseProviderModels(target, argumentsText, assertAuthorized),
          };
        }
        let state: Awaited<ReturnType<ConversationCommandUseCases["selectModel"]>>;
        try {
          state = await this.conversations.selectModel(target, argumentsText, assertAuthorized);
        } catch (error) {
          if (
            error instanceof UserFacingError
            && error.code === "model.selector.not-found"
          ) {
            return {
              kind: "models",
              view: "model",
              state: await this.conversations.browseProviderModels(
                target,
                argumentsText,
                assertAuthorized,
              ),
            };
          }
          throw error;
        }
        return modelSelectionResult(state);
      }
      case "effort":
        return {
          kind: "models",
          view: "effort",
          state: argumentsText
            ? await this.conversations.selectEffort(target, argumentsText, assertAuthorized)
            : await this.conversations.modelState(target, assertAuthorized),
        };
      case "fast":
        return {
          kind: "models",
          view: "fast",
          state: await this.conversations.selectFastMode(target, argumentsText, assertAuthorized),
        };
      case "skill": {
        if (!argumentsText) {
          return {
            kind: "skills",
            entries: await this.conversations.listSkills(target, assertAuthorized),
          };
        }
        const invocation = parseSkillInvocation(argumentsText);
        const submission = await this.submitCommand(() => this.conversations.invokeSkill(
          target,
          invocation.selector,
          invocation.task,
          assertAuthorized,
        ), captureSubmission);
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
        const submission = await this.submitCommand(() => this.conversations.invokeAgent(
          target,
          invocation.selector,
          invocation.task,
          assertAuthorized,
        ), captureSubmission);
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
      case "mcp":
        return this.executeMcpCommand(target, argumentsText, assertAuthorized);
      case "plugin":
        return this.executePluginCommand(target, argumentsText, assertAuthorized, captureSubmission);
      case "usage":
        return {
          kind: "usage",
          result: await this.conversations.providerAccountUsage(target, assertAuthorized),
        };
      case "metrics":
        return {
          kind: "metrics",
          summary: await this.conversations.requestMetrics(
            target,
            parseMetricsCommand(argumentsText),
          ),
        };
      case "limits":
        if (argumentsText) {
          if (!this.resetCredits) throw new UserFacingError("reset-credit.failed", "重置券功能不可用", { reason: "reset_unavailable" });
          return { kind: "reset-credit", result: await this.resetCredits.execute(target, actorId, argumentsText) };
        }
        return {
          kind: "limits",
          result: await this.conversations.providerAccountLimits(target, assertAuthorized),
        };
      case "permissions":
        {
          const status = this.conversations.status(target);
          const workspace = this.conversations.listWorkspaces().find(
            (entry) => entry.id === status.workspaceId,
          );
          return {
            kind: "permissions",
            profiles: await this.conversations.listPermissionProfiles(target, assertAuthorized),
            ...(workspace ? { workspace } : {}),
          };
        }
      case "diff":
        return {
          kind: "artifacts",
          view: "diff",
          artifacts: this.conversations.artifacts(target),
        };
      case "plan":
        if (argumentsText) {
          const submission = await this.submitCommand(() => this.conversations.startPlan(target, argumentsText, assertAuthorized), captureSubmission);
          return {
            kind: "outcome",
            outcome: { type: "plan.started", turnId: submission.turnId },
          };
        }
        return {
          kind: "collaboration-mode",
          state: await this.conversations.togglePlanMode(target, assertAuthorized),
        };
      case "goal":
        return this.goal(target, argumentsText, assertAuthorized);
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
          result: await this.conversations.releaseThread(target, force, assertAuthorized),
        };
      }
      case "schedule":
        return this.executeScheduledTaskCommand(target, argumentsText, actorId, assertAuthorized);
    }
    throw new UserFacingError(
      "command.unsupported",
      `不支持的会话命令：${String(command)}`,
      { command: String(command) },
    );
  }

  private async executeQueueCommand(
    target: ConversationTarget,
    input: string,
    assertAuthorized: () => void,
  ): Promise<ConversationCommandResult> {
    const operation = parseThreadQueueOperation(input);
    if (operation.type === "list") {
      return {
        kind: "thread-queue",
        result: await this.conversations.queueList(target, operation.page, assertAuthorized),
      };
    }
    if (operation.type === "add") {
      return {
        kind: "outcome",
        outcome: {
          type: "thread-queue.added",
          item: await this.conversations.queueAdd(target, operation.text, assertAuthorized),
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
            assertAuthorized,
          ),
        },
      };
    }
    if (operation.type === "delete") {
      const result = await this.conversations.queueDelete(target, operation.selector, assertAuthorized);
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
        assertAuthorized,
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
    const result = await this.conversations.queueStart(target, operation.selector, assertAuthorized);
    return {
      kind: "outcome",
      outcome: { type: "thread-queue.started", turnId: result.turnId },
    };
  }

  private async executeRevertCommand(
    target: ConversationTarget,
    input: string,
    actorId?: string,
    assertAuthorized?: () => void,
  ): Promise<ConversationCommandResult> {
    const operation = parseThreadRevertOperation(input);
    if (operation.type === "list") {
      return {
        kind: "thread-revert",
        result: await this.conversations.revertList(target, operation.page, assertAuthorized),
      };
    }
    if (operation.type === "preview") {
      return {
        kind: "thread-revert-preview",
        preview: await this.conversations.revertPreview(
          target,
          operation.selector,
          actorId,
          assertAuthorized,
        ),
      };
    }
    const result = await this.conversations.revertConfirm(
      target,
      operation.token,
      actorId,
      assertAuthorized,
    );
    return {
      kind: "outcome",
      outcome: {
        type: "thread.reverted",
        threadId: result.threadId,
        beforeTurnId: result.beforeTurnId,
      },
    };
  }

  private async executeMcpCommand(
    target: ConversationTarget,
    input: string,
    assertAuthorized?: () => void,
  ): Promise<ConversationCommandResult> {
    if (!input) {
      return {
        kind: "mcp",
        servers: await this.conversations.listMcpServers(target, assertAuthorized),
      };
    }
    const operation = parseMcpOperation(input);
    if (operation.type === "health") {
      return {
        kind: "mcp-health",
        report: await this.conversations.mcpHealth(target, assertAuthorized),
      };
    }
    if (operation.type === "reload") {
      await this.conversations.reloadMcpServers(target, assertAuthorized);
      return { kind: "mcp-reload" };
    }
    if (operation.type === "detail") {
      return {
        kind: "mcp-detail",
        selector: operation.selector,
        server: await this.conversations.mcpServerDetail(target, operation.selector, assertAuthorized),
        ...(operation.view ? { view: operation.view } : {}),
      };
    }
    if (operation.type === "login") {
      return {
        kind: "mcp-login",
        login: await this.conversations.loginMcpServer(target, operation.selector, assertAuthorized),
      };
    }
    return {
      kind: "mcp-resource",
      resource: await this.conversations.readMcpResource(
        target,
        operation.selector,
        operation.uri,
        assertAuthorized,
      ),
    };
  }

  private async executePluginCommand(
    target: ConversationTarget,
    input: string,
    assertAuthorized?: () => void,
    captureSubmission?: (submission: Promise<Submission>) => Promise<void>,
  ): Promise<ConversationCommandResult> {
    const operation = parsePluginOperation(input);
    if (operation.type === "list") {
      const catalog = await this.conversations.listPlugins(target, assertAuthorized);
      return pluginListResult(catalog, operation.view);
    }
    if (operation.type === "health") {
      return {
        kind: "plugin-health",
        report: await this.conversations.pluginHealth(target, assertAuthorized),
      };
    }
    if (operation.type === "detail") {
      return {
        kind: "plugin-detail",
        plugin: await this.conversations.pluginDetail(target, operation.selector, assertAuthorized),
      };
    }
    const submission = await this.submitCommand(() => this.conversations.invokePlugin(
      target,
      operation.selector,
      operation.task,
      assertAuthorized,
    ), captureSubmission);
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

  private async submitCommand<T extends Submission>(operation: () => Promise<T>,
    captureSubmission?: (submission: Promise<Submission>) => Promise<void>): Promise<T> {
    // Register before the use case can emit early output or approval requests. Capture only
    // actual submission work, never a catalog query or the command's queued platform reply.
    const submission = Promise.resolve().then(operation);
    const association = (async () => { await captureSubmission?.(submission); })();
    // A broken observer must still consume and settle a request which may already have run.
    const [submitted, associated] = await Promise.allSettled([submission, association] as const);
    if (submitted.status === "rejected") throw submitted.reason;
    if (associated.status === "rejected") throw associated.reason;
    return submitted.value;
  }

  private async executeScheduledTaskCommand(
    target: ConversationTarget,
    input: string,
    actorId: string,
    assertAuthorized: () => void,
  ): Promise<ConversationCommandResult> {
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
    const controller = new AbortController();
    const context: ScheduledTaskOperationContext = {
      signal: controller.signal,
      assertCurrent() {
        controller.signal.throwIfAborted();
        try {
          assertAuthorized();
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      },
    };
    context.assertCurrent();
    const operation = parseScheduledTaskOperation(input);
    switch (operation.type) {
      case "natural":
        return {
          kind: "scheduled-confirmation",
          preview: await scheduled.previewNaturalLanguage(target, actorId, operation.description, context),
        };
      case "create":
        return {
          kind: "scheduled-confirmation",
          preview: await scheduled.previewCreate(target, actorId, operation.request, context),
        };
      case "list":
        return {
          kind: "scheduled-tasks",
          result: await scheduled.list(target, actorId, operation.page, context),
        };
      case "runs":
        return {
          kind: "scheduled-runs",
          result: await scheduled.runs(target, actorId, operation.selector, operation.page, context),
        };
      case "rename":
        return {
          kind: "outcome",
          outcome: {
            type: "scheduled-task.renamed",
            task: await scheduled.rename(target, actorId, operation.selector, operation.name, context),
          },
        };
      case "pause":
      case "resume": {
        const task = await scheduled[operation.type](target, actorId, operation.selector, context);
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
        const run = await scheduled[operation.type](target, actorId, operation.selector, context);
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
          preview: await scheduled.previewDelete(target, actorId, operation.selector, context),
        };
      case "confirm": {
        const confirmed = await scheduled.confirm(target, actorId, operation.token, context);
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

  private async goal(
    target: ConversationTarget,
    input: string,
    assertAuthorized?: () => void,
  ): Promise<ConversationCommandResult> {
    if (input === "clear") {
      await this.conversations.clearGoal(target, assertAuthorized);
      return {
        kind: "outcome",
        outcome: { type: "goal.cleared" },
      };
    }
    if (input.startsWith("set ")) {
      const goal = await this.conversations.setGoal(target, input.slice(4), assertAuthorized);
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
    const goal = await this.conversations.getGoal(target, assertAuthorized);
    return { kind: "goal", goal };
  }
}

function toConversationModelSummary(
  status: ReturnType<ConversationCommandUseCases["status"]>,
): ConversationModelSummary {
  return {
    model: status.model,
    ...(status.modelProvider ? { modelProvider: status.modelProvider } : {}),
  };
}

function sessionListResult(
  sessions: Awaited<ReturnType<ConversationCommandUseCases["listSessions"]>>,
  view: SessionListView,
  metadata: {
    archived: boolean;
    currentThreadId?: string;
    backgroundThreadIds?: string[];
  },
): Extract<ConversationCommandResult, { kind: "sessions" }> {
  const pageCount = pageCountFor(sessions.length, maximumSessionListEntries);
  return {
    kind: "sessions",
    sessions: pageSlice(sessions, view.page, maximumSessionListEntries, pageCount),
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
  catalog: Awaited<ReturnType<ConversationCommandUseCases["listPlugins"]>>,
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
  const pageCount = pageCountFor(matches.length, maximumPluginListEntries);
  const pageEntries = pageSlice(matches, view.page, maximumPluginListEntries, pageCount);
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
