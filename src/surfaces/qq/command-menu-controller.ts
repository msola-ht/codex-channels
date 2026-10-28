import { randomBytes } from "node:crypto";
import {
  fastServiceTierId,
  modelSelectionSnapshot,
  parseThreadRevertOperation,
  parseMcpOperation,
  ultrafastServiceTierId,
  type ConversationCommandExecutor,
  type ConversationCommandResult,
  type ModelSelectionRequest,
  type ModelSelectionSnapshot,
} from "../../application/index.js";
import { conversationTargetKey, UserFacingError, type ConversationTarget } from "../../conversation-core/index.js";
import { formatConversationCommandOutcome } from "../conversation-command-outcome-format.js";
import { formatConversationModelState } from "../conversation-model-account-command-format.js";
import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { formatConversationStatus } from "../conversation-workspace-status-command-format.js";
import { createWorkspaceSelectionPresentation } from "../workspace-selection-presentation.js";
import { createModelSelectionPresentation } from "../model-selection-presentation.js";
import { createSessionListPresentation } from "../session-list-presentation.js";
import { cloudUsageChoices } from "../cloud-usage-format.js";
import { escapeLifecycleLiteral } from "../lifecycle-presentation.js";
import { formatCodexProviderLabel, formatDisplayedProvider, formatModelSpeedSupport, formatProviderModelSummary, formatServiceTier, modelListEntry } from "../provider-format.js";
import { formatReasoningEffort, reasoningEffortSettingName } from "../reasoning-effort-format.js";
import { formatConversationHooks, hookCommandChoices } from "../conversation-hook-command-format.js";
import { formatThreadQueueInputTypeLabel } from "../conversation-session-command-format.js";
import { formatQqLiteralDetails } from "./interactions.js";
import { qqLiteralMarkdown } from "./message-markdown.js";
import { qqMenuButton, qqChoiceLayout as choiceLayout, renderQqCommandMenu, renderQqStaticCommandMenu, type QqMenuButton } from "./command-menu.js";
import type { QqCommandKeyboard } from "./protocol.js";
import { QqProtocolError, QQ_MENU_PART_BYTES, QQ_BUTTON_LABEL_CHARACTERS } from "./protocol.js";
import { planText } from "./outbox.js";
import { isQqExtensionOperation, renderQqExtensionCommand, type QqExtensionChoice, type QqExtensionView } from "./extension-commands.js";

export interface QqMenuPanel {
  content: string;
  keyboard: QqCommandKeyboard;
  isCurrent(): boolean;
  detail?: string;
  markdownDetail?: string;
  delivered?(): void;
  signal?: AbortSignal;
}

interface Options {
  commands: ConversationCommandExecutor;
  scope(target: ConversationTarget): string;
  workspaceScope(target: ConversationTarget): string;
  selectionScope(target: ConversationTarget): string | undefined;
  readyThread(target: ConversationTarget): string | undefined;
  queryScope(target: ConversationTarget): string;
  allowed(target: ConversationTarget, actorId: string): boolean;
  beforeMutation(target: ConversationTarget, preserveRevert?: boolean): void;
  signal: AbortSignal;
}

type ModelView = "model" | "effort" | "fast";
type MenuAction =
  | { kind: "cloud-usage"; input: string }
  | { kind: "workspace"; id: string }
  | { kind: "model"; selection: ModelSelectionRequest }
  | { kind: "resume" | "unarchive"; id: string }
  | { kind: "auto-review"; threadId: string; enabled: boolean }
  | { kind: "goal-clear"; threadId: string }
  | { kind: "extension-query"; choice: QqExtensionChoice }
  | { kind: "hook"; input: string }
  | { kind: "hook-confirm"; token: string }
  | { kind: "workspace-page"; page: number }
  | { kind: "model-page"; page: number; view: ModelView; snapshot: ModelSelectionSnapshot }
  | { kind: "sessions-page"; page: number; filters: string; archived: boolean };
// Revert selections retain only IDs/tokens. Authoritative history remains in Application.
type RevertAction = { kind: "revert-page"; page: number }
  | { kind: "revert-preview"; id: string }
  | { kind: "revert-confirm"; token: string };
type QueueAction = { kind: "queue-page"; page: number }
  | { kind: "queue-item" | "queue-delete-preview"; id: string }
  | { kind: "queue-positions"; id: string; page: number }
  | { kind: "queue-write"; operation: "start" | "delete"; id: string }
  | { kind: "queue-write"; operation: "reorder"; id: string; position: number };
type QueueExecutor = (input: string, guard: () => void) => Promise<ConversationCommandResult>;

interface MenuContext {
  target: ConversationTarget;
  actorId: string;
  scope: string;
  workspaceScope: string;
  expiresAt: number;
  generation: number;
  selectionScope?: string;
  queryScope?: string;
  revertSignal?: AbortSignal;
  hookSignal?: AbortSignal;
  queueSignal?: AbortSignal;
  queueThreadId?: string;
}

interface Selection extends MenuContext { action: MenuAction | RevertAction | QueueAction; ready: boolean }
type Workspaces = Extract<ConversationCommandResult, { kind: "workspaces" }>;
type Models = Extract<ConversationCommandResult, { kind: "models" }>;
type Sessions = Extract<ConversationCommandResult, { kind: "sessions" }>;
type ThreadQueue = Extract<ConversationCommandResult, { kind: "thread-queue" }>;
type QueueItem = ThreadQueue["result"]["items"][number];
const MAX_SELECTIONS = 4096;
const MENU_LIFETIME_MS = 600_000;

/** One account generation owns these bounded, one-use command selections; no history is retained. */
export class QqCommandMenuController {
  private readonly selections = new Map<string, Selection>();
  private readonly revertScopes = new Map<string, AbortController>();
  private readonly hookScopes = new Map<string, AbortController>();
  private readonly queueScopes = new Map<string, AbortController>();
  private generation = 0;

  constructor(private readonly options: Options) {}

  idleReleased(target: ConversationTarget, actorId: string, threadId: string): QqMenuPanel {
    const context = this.context(target, actorId);
    return this.panel(context, {
      content: "点击下方按钮恢复此会话。",
      keyboard: { content: { rows: [{ buttons: [
        this.button(context, "恢复会话", { kind: "resume", id: threadId }),
      ] }] } },
    });
  }

  clear(): void {
    this.selections.clear();
    for (const controller of this.revertScopes.values()) controller.abort();
    this.revertScopes.clear();
    for (const controller of this.hookScopes.values()) controller.abort();
    this.hookScopes.clear();
    for (const controller of this.queueScopes.values()) controller.abort();
    this.queueScopes.clear();
    this.generation += 1;
  }

  async open(target: ConversationTarget, actorId: string, argumentsText: string, executeQueue?: QueueExecutor): Promise<QqMenuPanel> {
    const input = argumentsText.trim();
    const context = this.context(target, actorId);
    const staticMenu = renderQqStaticCommandMenu(input);
    if (staticMenu) return this.panel(context, staticMenu);
    const pick = /^pick ([a-f0-9]{24})$/u.exec(input);
    if (pick) return this.pick(context, pick[1]!, executeQueue);
    if (input === "queue") return this.queuePage(this.queueContext(context), 1);
    const workspace = /^workspace(?: ([1-9][0-9]{0,4}))?$/u.exec(input);
    if (workspace) return this.workspacePage(context, pageNumber(workspace[1]));
    const model = /^model(?: ([1-9][0-9]{0,4}))?$/u.exec(input);
    if (model) return this.modelPage(context, pageNumber(model[1]), "model");
    const sessions = /^(sessions|archived)(?: ([1-9][0-9]{0,4})(?: (.+))?)?$/u.exec(input);
    if (sessions) return this.sessionsPage(context, pageNumber(sessions[2]), sessions[3] ?? "", sessions[1] === "archived");
    const metrics = /^metrics(?: (global|providers|models|errors))?$/u.exec(input);
    if (metrics) return this.metrics(context, metrics[1]);
    throw unsupported();
  }

  async fromResult(target: ConversationTarget, actorId: string, result: ConversationCommandResult): Promise<QqMenuPanel | undefined> {
    if (result.kind === "usage" && result.result.kind === "cloud-usage") {
      const context = { ...this.context(target, actorId), queryScope: this.options.queryScope(target) };
      const buttons = cloudUsageChoices(result.result).map(choice => this.button(context, choice.label, { kind: "cloud-usage", input: choice.input }));
      const detail = renderConversationCommandResult(result)!;
      return { ...this.panel(context, { content: "", keyboard: { content: { rows: [
        { buttons: buttons.slice(0, 3) }, { buttons: buttons.slice(3) },
      ] } } }), detail: formatQqLiteralDetails(detail), markdownDetail: detail };
    }
    if (result.kind === "status" || result.kind === "limits" && result.result.kind === "rate-limits") {
      const context = { ...this.context(target, actorId), queryScope: this.options.queryScope(target) };
      const buttons = result.kind === "status"
        ? [qqMenuButton("metrics", "请求统计", "/metrics"), qqMenuButton("usage", "账户用量", "/usage"),
          qqMenuButton("limits", "账户额度", "/limits"),
          qqMenuButton("model", "模型设置", "/model"), qqMenuButton("workspace", "工作区", "/workspace"),
          qqMenuButton("permissions", "权限查询", "/permissions"), qqMenuButton("autoreview", "审批设置", "/autoreview")]
        : [qqMenuButton("credits", "查看重置券", "/limits reset")];
      const rows = buttonRows(buttons);
      rows.push({ buttons: [homeButton()] });
      const detail = renderConversationCommandResult(result)!;
      return { ...this.panel(context, { content: result.kind === "status" ? "" : "选择下方操作继续。", keyboard: { content: { rows } } }),
        detail: formatQqLiteralDetails(detail), markdownDetail: result.kind === "status"
          ? formatConversationStatus(result.status, escapeLifecycleLiteral, result) : detail };
    }
    const extension = renderQqExtensionCommand(result);
    if (extension) return this.extensionPanel({ ...this.context(target, actorId), queryScope: this.options.queryScope(target) }, extension);
    if (result.kind === "thread-queue") return this.queueList(this.queueContext(this.context(target, actorId)), result, (result.result.page - 1) * 3 + 1);
    if (result.kind !== "workspaces" && result.kind !== "models" && result.kind !== "sessions" && result.kind !== "auto-review" && result.kind !== "goal") return undefined;
    const context = this.context(target, actorId);
    switch (result.kind) {
      case "workspaces": return this.workspaces(context, result, 1);
      case "models": return this.models(context, result, 1, result.view);
      case "sessions": return this.sessions(context, result, result.page);
      case "auto-review": return this.autoReview(context, result);
      case "goal": return this.goal(context, result);
    }
  }

  private context(target: ConversationTarget, actorId: string): MenuContext {
    const context = {
      target: { ...target }, actorId,
      scope: this.options.scope(target), workspaceScope: this.options.workspaceScope(target),
      expiresAt: performance.now() + MENU_LIFETIME_MS, generation: this.generation,
    };
    this.assertCurrent(context);
    for (const [token, selection] of this.selections) {
      if (selection.expiresAt <= performance.now()
        || (conversationTargetKey(selection.target) === conversationTargetKey(target) && selection.scope !== context.scope)) {
        this.selections.delete(token);
      }
    }
    return context;
  }

  private active(context: MenuContext): boolean {
    return !this.options.signal.aborted && !context.revertSignal?.aborted && !context.hookSignal?.aborted && !context.queueSignal?.aborted && context.generation === this.generation
      && performance.now() < context.expiresAt && this.options.allowed(context.target, context.actorId);
  }

  private current(context: MenuContext, workspaceOnly = false): boolean {
    return this.active(context)
      && (context.queueThreadId === undefined || this.options.readyThread(context.target) === context.queueThreadId)
      && (context.queryScope === undefined || this.options.queryScope(context.target) === context.queryScope)
      && (workspaceOnly ? this.options.workspaceScope(context.target) === context.workspaceScope
        : this.options.scope(context.target) === context.scope
          && (context.selectionScope === undefined || this.options.selectionScope(context.target) === context.selectionScope));
  }

  private assertCurrent(context: MenuContext, workspaceOnly = false): void {
    if (!this.current(context, workspaceOnly)) throw expired();
  }

  private panel(context: MenuContext, value: { content: string; keyboard: QqCommandKeyboard }): QqMenuPanel {
    this.assertCurrent(context);
    return { ...value, isCurrent: () => this.current(context) };
  }

  private button(context: MenuContext, label: string, action: MenuAction | RevertAction | QueueAction, labelLimit = QQ_BUTTON_LABEL_CHARACTERS): QqMenuButton {
    this.assertCurrent(context);
    while (this.selections.size >= MAX_SELECTIONS) this.selections.delete(this.selections.keys().next().value!);
    const token = randomBytes(12).toString("hex");
    this.selections.set(token, { ...context, action, ready: !["revert-confirm", "hook-confirm", "auto-review", "goal-clear", "queue-write"].includes(action.kind) });
    return qqMenuButton(token, bounded(label, labelLimit), `/help pick ${token}`);
  }

  private async pick(request: MenuContext, token: string, executeQueue?: QueueExecutor): Promise<QqMenuPanel> {
    const selection = this.selections.get(token);
    if (!selection || selection.actorId !== request.actorId
      || conversationTargetKey(selection.target) !== conversationTargetKey(request.target)) throw expired();
    this.assertCurrent(selection);
    if (!selection.ready) throw expired();
    this.selections.delete(token);
    const { action } = selection;
    switch (action.kind) {
      case "cloud-usage": {
        const result = await this.options.commands.execute(selection.target, "usage", action.input, selection.actorId, () => this.assertCurrent(selection));
        this.assertCurrent(selection);
        const panel = await this.fromResult(selection.target, selection.actorId, result);
        if (!panel) throw unsupported();
        return panel;
      }
      case "queue-page": return this.queuePage(selection, action.page);
      case "queue-item": return this.queueItem(selection, action.id);
      case "queue-delete-preview": return this.queueItem(selection, action.id, true);
      case "queue-positions": return this.queuePositions(selection, action.id, action.page);
      case "queue-write": {
        if (!executeQueue) throw expired();
        const guard = () => this.assertCurrent(selection);
        guard();
        const input = `${action.operation} ${action.id}${action.operation === "reorder" ? ` ${action.position}` : ""}`;
        // The real inbound message owns Queue submission/deletion observation.
        // Consuming this token before awaiting also prevents uncertain writes being retried.
        const result = await executeQueue(input, guard);
        guard();
        if (result.kind !== "outcome" || result.outcome.type !== `thread-queue.${action.operation === "delete" ? "deleted" : action.operation === "start" ? "started" : "reordered"}`) throw unsupported();
        this.clearQueueSelections(selection.target);
        return this.panel(selection, { content: formatConversationCommandOutcome(result.outcome),
          keyboard: { content: { rows: [{ buttons: [this.button(selection, "查看队列", { kind: "queue-page", page: 1 }), homeButton()] }] } } });
      }
      case "hook": return this.hookResult(selection, await this.options.commands.execute(selection.target, "hooks", action.input, selection.actorId, () => this.assertCurrent(selection)));
      case "hook-confirm": {
        const result = await this.options.commands.execute(selection.target, "hooks", `confirm ${action.token}`, selection.actorId, () => this.assertCurrent(selection));
        return this.hookResult(selection, result);
      }
      case "extension-query": {
        const choice = action.choice;
        if (!isQqExtensionOperation(choice.command, choice.input)) throw unsupported();
        const operation = choice.command === "mcp" && choice.input ? parseMcpOperation(choice.input) : undefined;
        const result = operation?.type === "login" && choice.expectedName !== undefined
          ? await this.options.commands.selectMcpLogin(selection.target, operation.selector, choice.expectedName, selection.actorId, () => this.assertCurrent(selection))
          : await this.options.commands.execute(selection.target, choice.command, choice.input, selection.actorId, () => this.assertCurrent(selection));
        this.assertCurrent(selection);
        if (choice.expectedName !== undefined && (result.kind === "mcp-detail" ? result.server.name
          : result.kind === "plugin-detail" ? result.plugin.id : result.kind === "mcp-login" ? result.login.server : undefined) !== choice.expectedName) throw expired();
        const view = renderQqExtensionCommand(result, choice.page);
        if (!view) throw unsupported();
        return this.extensionPanel(selection, view);
      }
      case "workspace-page": return this.workspacePage(selection, action.page);
      case "model-page": return this.modelPage(selection, action.page, action.view, action.snapshot);
      case "sessions-page": return this.sessionsPage(selection, action.page, action.filters, action.archived);
      case "revert-page": return this.revertPage(selection, action.page);
      case "revert-preview": return this.revertResult(selection, await this.options.commands.execute(selection.target, "revert", action.id, selection.actorId, () => this.assertCurrent(selection)));
      case "auto-review": {
        const result = await this.options.commands.selectAutoReview(selection.target,
          { threadId: action.threadId, enabled: action.enabled }, selection.actorId, () => this.assertCurrent(selection));
        this.assertCurrent(selection);
        if (result.kind !== "auto-review") throw unsupported();
        return this.autoReview(selection, result);
      }
      case "goal-clear": {
        const guard = () => { this.assertCurrent(selection); if (this.options.readyThread(selection.target) !== action.threadId) throw expired(); };
        const result = await this.options.commands.execute(selection.target, "goal", "clear", selection.actorId, guard);
        guard();
        if (result.kind !== "outcome" || result.outcome.type !== "goal.cleared") throw unsupported();
        return this.panel(selection, { content: "已清除当前会话目标。\n清除目标不等于中断正在运行的任务；如需停止，请使用 /stop。",
          keyboard: { content: { rows: [{ buttons: [qqMenuButton("goal", "查询目标", "/goal"), homeButton()] }] } } });
      }
    }
    if (action.kind !== "model" || action.selection.kind === "model") {
      this.options.beforeMutation(selection.target, action.kind === "revert-confirm");
    }
    this.assertCurrent(selection);
    let result: ConversationCommandResult;
    if (action.kind === "revert-confirm") {
      this.clearRevertSelections(selection.target);
      result = await this.options.commands.execute(selection.target, "revert", `confirm ${action.token}`, selection.actorId, () => this.assertCurrent(selection));
      this.assertCurrent(selection);
    } else if (action.kind === "workspace") {
      // The shared mutation guards the original Workspace and Thread. Keep
      // this menu's lifetime at its final write boundary while allowing the
      // successful operation itself to change the selected Workspace.
      result = await this.options.commands.selectWorkspace(selection.target, action.id, selection.actorId,
        () => { if (!this.active(selection)) throw expired(); });
    } else if (action.kind === "model") {
      // Shared model selection owns and validates its own Thread/snapshot progression,
      // including the synchronous unbinding performed by a Provider switch.
      result = await this.options.commands.selectModelSetting(selection.target, action.selection, selection.actorId,
        () => this.assertCurrent(selection, true));
      this.assertCurrent(selection, true);
    } else {
      // Resume/unarchive intentionally change Thread; the shared lifecycle
      // owns that transition, while the menu still fixes its Workspace.
      result = await this.options.commands.execute(selection.target, action.kind, action.id, selection.actorId,
        () => this.assertCurrent(selection, true));
    }
    // Only a completed mutation may adopt its resulting workspace or Thread scope.
    if (this.options.signal.aborted || selection.generation !== this.generation
      || performance.now() >= selection.expiresAt || !this.options.allowed(selection.target, selection.actorId)) throw expired();
    const next = this.context(selection.target, selection.actorId);
    if (result.kind === "models") return this.models(next, result, 1, result.view);
    if (result.kind !== "outcome") throw unsupported();
    const detail = formatConversationCommandOutcome(result.outcome, undefined, false);
    return { ...this.panel(next, { ...renderQqCommandMenu(), content: "选择下方操作继续。" }),
      detail, markdownDetail: formatConversationCommandOutcome(result.outcome, escapeLifecycleLiteral) };
  }

  private autoReview(context: MenuContext, result: Extract<ConversationCommandResult, { kind: "auto-review" }>): QqMenuPanel {
    const { threadId, reviewer } = result.state;
    const buttons = threadId && (reviewer === "user" || reviewer === "auto_review")
      ? [this.button(context, "自动审查", { kind: "auto-review", threadId, enabled: true }),
        this.button(context, "手动审批", { kind: "auto-review", threadId, enabled: false }), homeButton()]
      : [homeButton()];
    const detail = renderConversationCommandResult(result)!;
    return { ...this.panel(context, { content: "选择审批方式；仅作用于上述会话。", keyboard: { content: { rows: [{ buttons }] } } }),
      detail: formatQqLiteralDetails(detail), markdownDetail: detail, delivered: () => this.activate(context, buttons) };
  }

  private goal(context: MenuContext, result: Extract<ConversationCommandResult, { kind: "goal" }>): QqMenuPanel {
    const threadId = this.options.readyThread(context.target);
    if (!threadId || result.goal && result.goal.threadId !== threadId) throw expired();
    const buttons = result.goal ? [this.button(context, "清除当前目标", { kind: "goal-clear", threadId }), homeButton()] : [homeButton()];
    const detail = result.goal ? renderConversationCommandResult(result)! : "当前会话没有 Goal。";
    const panel = this.panel(context, { content: "QQ 当前支持查询和清除目标；清除不等于停止当前任务。", keyboard: { content: { rows: [{ buttons }] } } });
    return { ...panel, isCurrent: () => panel.isCurrent() && this.options.readyThread(context.target) === threadId,
      detail: formatQqLiteralDetails(detail), markdownDetail: detail, delivered: () => this.activate(context, buttons) };
  }

  private activate(context: MenuContext, buttons: QqMenuButton[]): void {
    if (!this.current(context)) return;
    for (const button of buttons) {
      const selection = this.selections.get(button.id);
      if (selection) selection.ready = true;
    }
  }

  cancelQueue(target: ConversationTarget): void {
    const key = conversationTargetKey(target);
    this.queueScopes.get(key)?.abort();
    this.queueScopes.delete(key);
    this.clearQueueSelections(target);
  }

  invalidateQueueSelections(target: ConversationTarget): void { this.clearQueueSelections(target); }

  private clearQueueSelections(target: ConversationTarget): void {
    const key = conversationTargetKey(target);
    for (const [token, selection] of this.selections) if (selection.action.kind.startsWith("queue-")
      && conversationTargetKey(selection.target) === key) this.selections.delete(token);
  }

  private queueContext(context: MenuContext): MenuContext {
    if (context.queueSignal) { this.assertCurrent(context); return context; }
    const threadId = this.options.readyThread(context.target);
    if (!threadId) throw new UserFacingError("command.selection.expired", "请先选择并等待当前会话恢复完成，再管理 Queue。");
    this.cancelQueue(context.target);
    while (this.queueScopes.size >= MAX_SELECTIONS) {
      const oldest = this.queueScopes.keys().next().value!;
      this.queueScopes.get(oldest)!.abort(); this.queueScopes.delete(oldest);
    }
    const controller = new AbortController();
    this.queueScopes.set(conversationTargetKey(context.target), controller);
    return { ...context, queueSignal: controller.signal, queueThreadId: threadId };
  }

  private async readQueue(context: MenuContext, sharedPage: number): Promise<ThreadQueue> {
    this.assertCurrent(context);
    const result = await this.options.commands.execute(context.target, "queue", `list ${sharedPage}`, context.actorId, () => this.assertCurrent(context));
    this.assertCurrent(context);
    if (result.kind !== "thread-queue" || result.result.page !== sharedPage) throw unsupported();
    return result;
  }

  private async queuePage(context: MenuContext, page: number): Promise<QqMenuPanel> {
    if (!Number.isInteger(page) || page < 1 || page > 12) throw unsupported();
    const result = await this.readQueue(context, Math.floor((page - 1) / 3) + 1);
    // A queue can shrink between navigation clicks. Return the new last page.
    if (result.result.page > result.result.pageCount) return this.queuePage(context, Math.max(1, result.result.pageCount) * 3 - 2);
    return this.queueList(context, result, page);
  }

  private queueList(context: MenuContext, result: ThreadQueue, page: number): QqMenuPanel {
    this.assertCurrent(context);
    this.clearQueueSelections(context.target);
    const shared = result.result;
    if (shared.page > shared.pageCount) return this.queuePanel(context,
      "本页已不存在，请返回队列首页。", [this.button(context, "队列首页", { kind: "queue-page", page: 1 })]);
    const localCount = Math.max(1, Math.ceil(shared.items.length / 9));
    const local = Math.min((page - 1) % 3, localCount - 1);
    page = (shared.page - 1) * 3 + local + 1;
    const entries = shared.items.slice(local * 9, local * 9 + 9);
    const buttons = entries.map((item, index) => this.button(context,
      `${(shared.page - 1) * 25 + local * 9 + index + 1} ${item.textPreview ?? formatThreadQueueInputTypeLabel(item.inputType)}`,
      { kind: "queue-item", id: queueCommandId(item.id) }));
    const lastPage = (shared.page - 1) * 3 + localCount;
    const navigation = [
      ...(page > 1 ? [this.button(context, "上一页", { kind: "queue-page", page: page - 1 })] : []),
      this.button(context, "刷新", { kind: "queue-page", page }),
      ...(local + 1 < localCount || shared.page < shared.pageCount
        ? [this.button(context, "下一页", { kind: "queue-page", page: page === lastPage ? shared.page * 3 + 1 : page + 1 })] : []),
    ];
    const rows = buttonRows(buttons);
    rows.push({ buttons: navigation }, { buttons: [qqMenuButton("queueadd", "新增排队文本", "/queue add ", false), homeButton()] });
    const content = ["## App Server Queue\n", `第 ${page} 屏 · 共 ${shared.totalItemCount} 条 · 每屏最多九项\n`, "### 排队条目\n",
      ...entries.map((item, index) => `${(shared.page - 1) * 25 + local * 9 + index + 1}. ${markdown(item.textPreview ?? formatThreadQueueInputTypeLabel(item.inputType), 130)}`),
      ...entries.length ? [] : ["队列为空。"],
      "\n点击条目查看完整安全摘要，再选择操作。",
    ].join("\n");
    return this.panel(context, { content, keyboard: { content: { rows } } });
  }

  private async findQueueItem(context: MenuContext, id: string): Promise<{ item: QueueItem; total: number }> {
    queueCommandId(id);
    // IDs survive ordering changes; a stale screen number must never select another item.
    for (let page = 1; page <= 4; page += 1) {
      const result = await this.readQueue(context, page);
      const item = result.result.items.find(candidate => candidate.id === id);
      if (item) return { item, total: result.result.totalItemCount };
      if (page >= result.result.pageCount) break;
    }
    throw new UserFacingError("queue.item-not-found", "Queue 条目已不存在，请刷新队列列表。");
  }

  private async queueItem(context: MenuContext, id: string, deleting = false): Promise<QqMenuPanel> {
    const { item } = await this.findQueueItem(context, id);
    this.clearQueueSelections(context.target);
    const buttons = deleting
      ? [this.button(context, "确认删除", { kind: "queue-write", operation: "delete", id }), this.button(context, "取消", { kind: "queue-item", id })]
      : [this.button(context, "启动此条", { kind: "queue-write", operation: "start", id }),
        this.button(context, "删除此条", { kind: "queue-delete-preview", id }),
        this.button(context, "调整位置", { kind: "queue-positions", id, page: 1 })];
    const update = `/queue update ${id} `;
    if (!deleting && item.editable && [...update].length <= 100) buttons.push(qqMenuButton("queueupdate", "更新文本", update, false));
    const detail = [deleting ? "确认删除 Queue 条目？删除后无法通过 Gateway 恢复。" : "Queue 条目", `ID：${item.id}`,
      `类型：${formatThreadQueueInputTypeLabel(item.inputType)}${item.editable ? " · 可更新" : " · 只读摘要"}`,
      `安全摘要：${item.textPreview ?? "（无文本预览）"}`,
      ...!deleting && item.editable && [...update].length > 100 ? [`更新文本请手动发送：${update}<新文本>`] : [],
      "安全摘要不是完整排队正文。启动会执行该条原生 Queue 输入。",
    ].join("\n");
    return this.queuePanel(context, "核对上方完整条目信息后操作；停止、切换或过期后按钮失效。", buttons, detail);
  }

  private async queuePositions(context: MenuContext, id: string, page: number): Promise<QqMenuPanel> {
    const { item, total } = await this.findQueueItem(context, id);
    this.clearQueueSelections(context.target);
    const pageCount = Math.max(1, Math.ceil(total / 9));
    page = Math.min(page, pageCount);
    const positions = Array.from({ length: total }, (_, index) => index + 1).slice((page - 1) * 9, page * 9);
    const buttons = positions.map(position => this.button(context, `移至第 ${position} 位`, { kind: "queue-write", operation: "reorder", id, position }));
    const navigation = [
      ...(page > 1 ? [this.button(context, "上一页", { kind: "queue-positions", id, page: page - 1 })] : []),
      this.button(context, "返回条目", { kind: "queue-item", id }),
      ...(page < pageCount ? [this.button(context, "下一页", { kind: "queue-positions", id, page: page + 1 })] : []),
    ];
    const detail = [`调整 Queue 条目位置 · 第 ${page}/${pageCount} 页`, `ID：${item.id}`, `安全摘要：${item.textPreview ?? "（无文本预览）"}`,
      `当前共 ${total} 条；选择目标位置后立即排序，其他条目的相对顺序保持。`].join("\n");
    return this.queuePanel(context, "选择目标位置；执行时由 App Server 重新核对条目及当前队列。", buttons, detail, navigation);
  }

  private queuePanel(context: MenuContext, content: string, buttons: QqMenuButton[], detail?: string, navigation?: QqMenuButton[]): QqMenuPanel {
    const rows = buttonRows(buttons);
    if (navigation?.length) rows.push({ buttons: navigation });
    rows.push({ buttons: [this.button(context, "队列首页", { kind: "queue-page", page: 1 }), homeButton()] });
    const panel = this.panel(context, { content, keyboard: { content: { rows } } });
    if (!detail) return panel;
    const literal = formatQqLiteralDetails(detail);
    try {
      if (planText({ mode: "active", recipient: context.actorId, content: literal }).length > 7) throw new QqProtocolError("message", "invalid-input");
    } catch (error) {
      if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input") throw error;
      this.clearQueueSelections(context.target);
      throw new UserFacingError("queue.failed", "Queue 条目详情超出完整展示预算，请在本机核对。");
    }
    const markdownDetail = qqLiteralMarkdown(detail);
    return { ...panel, detail: literal, ...(markdownDetail === undefined ? {} : { markdownDetail }), delivered: () => this.activate(context, buttons) };
  }

  private extensionPanel(context: MenuContext, view: QqExtensionView): QqMenuPanel {
    const rows = buttonRows(view.choices.map((choice, index) => choice.taskInput
      ? qqMenuButton(`task${index}`, bounded(choice.label, QQ_BUTTON_LABEL_CHARACTERS), `/${choice.command} ${choice.input} `, false)
      : this.button(context, choice.label, { kind: "extension-query", choice })));
    const navigation: QqMenuButton[] = [qqMenuButton("extensions", "扩展管理", "/help extensions"), homeButton()];
    if (view.authorizationUrl) navigation.unshift({ id: "oauth-url", render_data: { label: "浏览器授权", visited_label: "已打开", style: 0 },
      action: { type: 0, permission: { type: 2 }, data: view.authorizationUrl } });
    rows.push({ buttons: navigation });
    if (rows.length > 5) throw unsupported();
    const panel = this.panel(context, { content: "选择任务入口后补充需求并发送；查询操作可直接选择。登录需浏览器授权，重载结果请用 MCP 健康核对。", keyboard: { content: { rows } } });
    const detail = formatQqLiteralDetails(view.detail);
    try {
      if (planText({ mode: "active", recipient: context.actorId, content: detail }).length > 7) throw new QqProtocolError("message", "invalid-input");
    } catch (error) {
      if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input") throw error;
      return { ...panel, content: "查询详情超过 QQ 完整展示预算，本次未发送详情。请缩小查询范围、翻页或在本机查看。" };
    }
    return { ...panel, detail, markdownDetail: view.detail };
  }

  cancelRevert(target: ConversationTarget): void {
    const key = conversationTargetKey(target);
    this.revertScopes.get(key)?.abort();
    this.revertScopes.delete(key);
    this.clearRevertSelections(target);
  }

  cancelManagement(target: ConversationTarget): void {
    const key = conversationTargetKey(target);
    this.hookScopes.get(key)?.abort();
    this.hookScopes.delete(key);
    for (const [token, value] of this.selections) if ((value.action.kind === "hook" || value.action.kind === "hook-confirm")
      && conversationTargetKey(value.target) === key) this.selections.delete(token);
  }

  async hooks(target: ConversationTarget, actorId: string, input: string): Promise<QqMenuPanel> {
    const value = input.trim();
    if (!value || /^page\s+[1-9]\d*$/u.test(value)) this.cancelManagement(target);
    const key = conversationTargetKey(target);
    let controller = this.hookScopes.get(key);
    if (!controller) {
      while (this.hookScopes.size >= MAX_SELECTIONS) {
        const oldest = this.hookScopes.keys().next().value!;
        this.hookScopes.get(oldest)!.abort(); this.hookScopes.delete(oldest);
      }
      controller = new AbortController(); this.hookScopes.set(key, controller);
    }
    const context = { ...this.context(target, actorId), hookSignal: controller.signal, queryScope: this.options.queryScope(target) };
    const confirm = /^confirm\s+([a-f0-9]{32})$/u.exec(value);
    if (confirm) {
      const entry = [...this.selections.entries()].find(([, selection]) => selection.action.kind === "hook-confirm"
        && selection.action.token === confirm[1] && selection.actorId === actorId && conversationTargetKey(selection.target) === key);
      if (!entry) throw expired();
      return this.pick(context, entry[0]);
    }
    if (/^confirm(?:\s|$)/u.test(value)) throw expired();
    return this.hookResult(context, await this.options.commands.execute(target, "hooks", value, actorId, () => this.assertCurrent(context)));
  }

  private hookResult(context: MenuContext, result: ConversationCommandResult): QqMenuPanel {
    this.assertCurrent(context);
    if (result.kind !== "hooks") throw unsupported();
    const buttons = hookCommandChoices(result.view).map(choice => {
      const entry = !result.view.detail && !result.view.updated
        ? result.view.entries.find(entry => entry.selector === choice.input) : undefined;
      const label = entry ? `${entry.selector.split(".").at(-1)} ${entry.hook.eventName}` : choice.label;
      return this.button(context, label,
        choice.input.startsWith("confirm ") ? { kind: "hook-confirm", token: choice.input.slice(8) } : { kind: "hook", input: choice.input });
    });
    const rows = buttonRows(buttons);
    rows.push({ buttons: [qqMenuButton("extensions", "扩展管理", "/help extensions"), homeButton()] });
    if (rows.length > 5) throw unsupported();
    // Hook review fields must never acquire Markdown semantics, even inside a fence.
    const confirmation = hookCommandChoices(result.view).find(choice => choice.input.startsWith("confirm "));
    const detail = formatQqLiteralDetails(formatConversationHooks(result.view, true));
    try {
      if (planText({ mode: "active", recipient: context.actorId, content: detail }).length > 7) throw new QqProtocolError("message", "invalid-input");
    } catch (error) {
      if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input") throw error;
      throw new UserFacingError("hooks.local-review-required", "Hook 详情超出完整展示预算");
    }
    const content = ["核对上方完整 Hook 信息后操作。确认仅对本次预览有效；停止、切换或重启后失效。",
      ...(confirmation ? [`也可发送：/hooks ${confirmation.input}`] : []),
    ].join("\n\n");
    return { ...this.panel(context, { content, keyboard: { content: { rows } } }),
      detail, delivered: () => this.activate(context, buttons) };
  }

  private clearRevertSelections(target: ConversationTarget): void {
    for (const [key, value] of this.selections) if (value.action.kind.startsWith("revert-")
      && conversationTargetKey(value.target) === conversationTargetKey(target)) this.selections.delete(key);
  }

  async revert(target: ConversationTarget, actorId: string, input: string): Promise<QqMenuPanel> {
    const context = this.revertContext(this.context(target, actorId));
    const operation = parseThreadRevertOperation(input);
    if (operation.type === "confirm") {
      const entry = [...this.selections.entries()].find(([, value]) => value.action.kind === "revert-confirm"
        && value.action.token === operation.token && value.actorId === actorId
        && conversationTargetKey(value.target) === conversationTargetKey(target));
      if (!entry) throw expired();
      return this.pick(context, entry[0]);
    }
    if (operation.type === "list") return this.revertPage(context, (operation.page - 1) * 3 + 1);
    return this.revertResult(context, await this.options.commands.execute(target, "revert", input, actorId, () => this.assertCurrent(context)));
  }

  private revertContext(context: MenuContext): MenuContext {
    if (context.revertSignal) return context;
    const key = conversationTargetKey(context.target);
    let controller = this.revertScopes.get(key);
    if (!controller) {
      while (this.revertScopes.size >= MAX_SELECTIONS) {
        const oldest = this.revertScopes.keys().next().value!;
        this.revertScopes.get(oldest)!.abort();
        this.revertScopes.delete(oldest);
      }
      controller = new AbortController();
      this.revertScopes.set(key, controller);
    }
    return { ...context, revertSignal: controller.signal };
  }

  private async revertPage(context: MenuContext, page: number): Promise<QqMenuPanel> {
    this.assertCurrent(context);
    this.clearRevertSelections(context.target);
    const sharedPage = Math.floor((page - 1) / 3) + 1;
    const result = await this.options.commands.execute(context.target, "revert", `list ${sharedPage}`, context.actorId, () => this.assertCurrent(context));
    this.assertCurrent(context);
    if (result.kind !== "thread-revert") throw unsupported();
    const offset = Math.min(((page - 1) % 3) * 9, Math.max(0, (Math.ceil(result.result.turns.length / 9) - 1) * 9));
    page = (sharedPage - 1) * 3 + offset / 9 + 1;
    const turns = result.result.turns.slice(offset, offset + 9);
    const buttons = turns.map((turn, index) => this.button(context, `预览 ${result.result.selectors[offset + index] ?? turn.id}`, { kind: "revert-preview", id: turn.id }));
    const lines = turns.map((turn, index) => `${result.result.selectors[offset + index] ?? ""}. ${markdown(turn.id, 100)} · ${markdown(turn.status, 30)}\n${markdown(turn.textPreview ?? "无文字预览", 70)}`);
    const lastPage = (sharedPage - 1) * 3 + Math.max(1, Math.ceil(result.result.turns.length / 9));
    return this.listPanel(context, "历史回退 · 选择预览", lines, buttons, page,
      result.result.hasNextPage ? sharedPage * 3 + 1 : lastPage, next => ({ kind: "revert-page",
        page: next > page && page === lastPage ? sharedPage * 3 + 1 : next }));
  }

  private revertResult(context: MenuContext, result: ConversationCommandResult): QqMenuPanel {
    this.assertCurrent(context);
    if (result.kind !== "thread-revert-preview") throw unsupported();
    const current = { ...context, expiresAt: Math.min(context.expiresAt, performance.now() + 300_000) };
    const confirm = this.button(current, "确认回退历史", { kind: "revert-confirm", token: result.preview.token });
    const selection = this.selections.get(confirm.id)!;
    const panel = this.panel(current, { content: "## 确认历史回退\n请核对上方完整预览。仅回退历史，不恢复文件或外部副作用。",
      keyboard: { content: { rows: [{ buttons: [confirm, qqMenuButton("refresh", "重新查看历史", "/revert list"), homeButton()] }] } } });
    const detail = renderConversationCommandResult(result)!;
    const markdownDetail = qqLiteralMarkdown(detail);
    return { ...panel, isCurrent: () => panel.isCurrent() && this.selections.get(confirm.id) === selection,
      detail: formatQqLiteralDetails(detail),
      ...(markdownDetail === undefined ? {} : { markdownDetail }), delivered: () => {
      if (this.selections.get(confirm.id) === selection && this.current(selection)) selection.ready = true;
    } };
  }

  private async workspacePage(context: MenuContext, page: number): Promise<QqMenuPanel> {
    this.assertCurrent(context);
    const result = await this.options.commands.execute(context.target, "workspace", "", context.actorId);
    this.assertCurrent(context);
    if (result.kind !== "workspaces") throw unsupported();
    return this.workspaces(context, result, page);
  }

  private workspaces(context: MenuContext, result: Workspaces, page: number): QqMenuPanel {
    const view = createWorkspaceSelectionPresentation(result);
    const entries = slicePage(view.entries, page, 9);
    const buttons = entries.map((workspace) => this.button(context,
      `${workspace.position} ${workspace.name}`, { kind: "workspace", id: workspace.id }));
    const lines = entries.map((workspace) =>
      `**${workspace.position}. ${markdown(workspace.name, 100)}**${workspace.isCurrent ? " · 当前" : ""}\n\n目录：${markdown(workspace.cwd, 260)}\n`);
    const currentWorkspace = view.currentWorkspace;
    lines.unshift(`**当前工作区：${markdown(currentWorkspace?.name ?? view.currentWorkspaceId, 100)}**\n\n${currentWorkspace ? `目录：${markdown(currentWorkspace.cwd, 260)}` : "原选择已失效，请重新选择。"}\n\n### 工作区列表\n`);
    lines.push("\n点击下方工作区切换；切换后请重新发起操作，不会自动重试之前的请求。");
    return this.listPanel(context, "工作区", lines, buttons, page, Math.ceil(view.entries.length / 9),
      next => ({ kind: "workspace-page", page: next }));
  }

  private async modelPage(context: MenuContext, page: number, view: ModelView, snapshot?: ModelSelectionSnapshot): Promise<QqMenuPanel> {
    this.assertCurrent(context);
    // /model without arguments clears Provider browsing. Pagination must retain
    // the catalog and snapshot that produced the clicked page.
    const result = snapshot?.providerFilter !== undefined
      ? await this.options.commands.selectModelSetting(context.target,
        { kind: "browse-provider", provider: snapshot.providerFilter, snapshot }, context.actorId,
        () => this.assertCurrent(context))
      : await this.options.commands.execute(context.target, "model", "", context.actorId);
    this.assertCurrent(context);
    if (result.kind !== "models") throw unsupported();
    return this.models(context, result, page, view);
  }

  private async models(context: MenuContext, result: Models, page: number, view: ModelView): Promise<QqMenuPanel> {
    const { state } = result;
    const snapshot = modelSelectionSnapshot(state);
    if (this.options.selectionScope(context.target) !== snapshot.selectionScope) throw expired();
    context = { ...context, selectionScope: snapshot.selectionScope };
    const presentation = createModelSelectionPresentation(state);
    const selected = presentation.availableCurrentModel;
    if (view !== "model" && state.providerFilter !== undefined
      && state.providerFilter !== state.modelProvider) {
      // Settings must use the current model's catalog for both rendering and
      // snapshot validation, even when /fast status supplied a directed catalog.
      // Reuse /model's browse reset, without changing the selected model. The
      // Thread, Workspace and lifetime still guard the query. Resetting browsing
      // intentionally changes selectionScope; Application guards the fresh read.
      this.assertCurrent(context);
      const browseContext = { ...context };
      delete browseContext.selectionScope;
      const refreshed = await this.options.commands.execute(context.target, "model", "", context.actorId,
        () => this.assertCurrent(browseContext));
      this.assertCurrent(browseContext);
      if (refreshed.kind !== "models" || refreshed.state.providerFilter !== undefined) throw expired();
      return this.models(browseContext, refreshed, 1, view);
    }
    const [modelLine, ...settingLines] = formatConversationModelState(result, value => markdown(value, 140));
    const current = `**${modelLine}**\n\n${settingLines.map(line => `- ${line}`).join("\n")}\n`;
    if (view !== "model") {
      if (!selected && view === "effort") throw expired();
      const choices: Array<{ label: string; description?: string; selection: ModelSelectionRequest }> = view === "effort"
        ? selected!.supportedReasoningEfforts.map(option => ({
          label: `${formatReasoningEffort(option.effort)}${option.effort === state.effort ? state.effortPending ? " · 已选" : " · 当前" : ""}`,
          description: option.description,
          selection: { kind: "effort", effort: option.effort, snapshot },
        }))
        : presentation.speedOptions.map(({ label, mode }) => ({
          label, selection: { kind: "fast", mode, snapshot },
        }));
      const speed = state.serviceTierKnown ? formatServiceTier(state.serviceTier, selected) : undefined;
      const layout = choiceLayout(choices.map(choice => view === "fast" && choice.label === speed ? `${choice.label} · 已选` : choice.label));
      const entries = slicePage(choices, page, layout.pageSize).map(choice => ({ ...choice,
        label: view === "fast" && choice.label === speed ? `${choice.label} · 已选` : choice.label,
      }));
      const buttons = entries.map(choice => this.button(context, choice.label, { kind: "model", selection: choice.selection }, QQ_BUTTON_LABEL_CHARACTERS));
      const extra = [this.button(context, "选择模型", { kind: "model-page", page: 1, view: "model", snapshot })];
      if (view === "effort" && selected && (fastServiceTierId(selected) || ultrafastServiceTierId(selected))) {
        extra.push(this.button(context, "Fast", { kind: "model-page", page: 1, view: "fast", snapshot }));
      }
      return this.listPanel(context, view === "effort" ? `选择${reasoningEffortSettingName(state.effort, selected)}` : "Fast",
        [current, `### ${view === "effort" ? reasoningEffortSettingName(state.effort, selected) : "速度"}选项\n`, ...entries.map((choice, index) => `**${(page - 1) * layout.pageSize + index + 1}. ${markdown(choice.label, 100)}**${choice.description ? `\n\n${markdown(choice.description, 180)}` : ""}\n`),
          view === "fast" ? `\n- 当前模型：${formatModelSpeedSupport(selected)}\n\n点击下方速度选项，影响下一轮；主 Provider 同时更新 Codex 用户级默认速度。` : "\n点击下方选项调整思考设置。"],
        buttons, page, Math.ceil(choices.length / layout.pageSize), next => ({ kind: "model-page", page: next, view, snapshot }), extra, layout.columns);
    }
    if (state.providerFilter === undefined) {
      const providers = presentation.providers;
      const layout = choiceLayout(providers.map(provider => formatCodexProviderLabel(provider.id)));
      const entries = slicePage(providers, page, layout.pageSize);
      const buttons = entries.map(({ id: provider }) => this.button(context, formatCodexProviderLabel(provider), {
        kind: "model", selection: { kind: "browse-provider", provider, snapshot },
      }, QQ_BUTTON_LABEL_CHARACTERS));
      const lines = [current, "### 提供商列表\n", ...entries.map(({ id: provider, position, isCurrent }) =>
        `**${position}. ${markdown(formatCodexProviderLabel(provider), 100)}**${isCurrent && state.modelProvider !== undefined ? state.providerPending ? " · 已选" : " · 当前" : ""}\n\n${markdown(formatProviderModelSummary(state.models, provider), 180)}\n`), "\n点击下方提供商，继续选择模型。"];
      return this.listPanel(context, "选择提供商", lines, buttons, page, Math.ceil(providers.length / layout.pageSize),
        next => ({ kind: "model-page", page: next, view, snapshot }), [], layout.columns);
    }
    const catalog = presentation.entries;
    const labels = catalog.map(({ model, position }) => `${position} ${modelListEntry(model.displayName, model.provider, model.model).modelName}`);
    const layout = choiceLayout(labels);
    const entries = slicePage(catalog, page, layout.pageSize);
    const buttons = entries.flatMap(({ model, provider }, index) => model.available === false ? [] : [this.button(context, labels[(page - 1) * layout.pageSize + index]!, {
      kind: "model", selection: { kind: "model", provider, model: model.model, snapshot },
    }, QQ_BUTTON_LABEL_CHARACTERS)]);
    const lines = [current, `**浏览提供商：${markdown(formatCodexProviderLabel(state.providerFilter), 100)}**\n`, ...entries.map(({ model, position, isCurrent }) => `**${position}. ${markdown(modelListEntry(model.displayName, model.provider, model.model).modelName, 130)}**${isCurrent ? state.modelPending ? " · 已选" : " · 当前" : ""} · ${formatModelSpeedSupport(model)}${model.available === false ? ` · 暂不可用${model.unavailableReason ? `：${markdown(model.unavailableReason, 180)}` : ""}` : ""}\n`), "\n点击下方模型完成选择，再调整该模型的思考等级和速度；上方当前设置不会因浏览而切换。"];
    const extra: QqMenuButton[] = [qqMenuButton("providers", "返回提供商", "/model")];
    if (selected && selected.supportedReasoningEfforts.length > 1) extra.push(this.button(context, "思考等级", { kind: "model-page", page: 1, view: "effort", snapshot }));
    if (selected && (fastServiceTierId(selected) || ultrafastServiceTierId(selected))) extra.push(this.button(context, "Fast", { kind: "model-page", page: 1, view: "fast", snapshot }));
    return this.listPanel(context, "选择模型", lines, buttons, page, Math.ceil(catalog.length / layout.pageSize),
      next => ({ kind: "model-page", page: next, view: "model", snapshot }), extra, layout.columns);
  }

  private async sessionsPage(context: MenuContext, page: number, filters: string, archived: boolean): Promise<QqMenuPanel> {
    this.assertCurrent(context);
    const result = await this.options.commands.execute(context.target, archived ? "archived" : "sessions", `${page} ${filters}`.trim(), context.actorId);
    this.assertCurrent(context);
    if (result.kind !== "sessions" || result.archived !== archived) throw unsupported();
    return this.sessions(context, result, page);
  }

  private sessions(context: MenuContext, result: Sessions, page: number): QqMenuPanel {
    const pages = result.pageCount;
    if (page > pages) throw unsupported();
    const title = result.archived ? "已归档会话" : "历史会话";
    const heading = `## ${title}\n\n共 ${result.matchedSessionCount} 条 · 第 ${page} / ${pages} 页`;
    const hint = `${result.archived ? "点击下方对应会话取消归档并切换" : "点击下方对应会话恢复"}；省略号表示标题或字段已截断。`;
    const entries = createSessionListPresentation(result).map(({ session, selector, isCurrent, isBackground }) => ({
      session,
      number: selector,
      text: [
        `**${selector}. ${markdown(bounded(session.name || session.preview || "未命名", 32), 160)}${isCurrent ? "（当前）" : isBackground ? "（后台）" : ""}${session.isPinned ? "（固定）" : ""}**\n`,
        [
          ...(session.model ? [`模型：${markdown(session.model, 60)}`] : []),
          ...(session.reasoningEffort ? [`${reasoningEffortSettingName(session.reasoningEffort)}：${markdown(formatReasoningEffort(session.reasoningEffort), 40)}`] : []),
          ...(session.modelProvider ? [`Provider：${markdown(formatDisplayedProvider(session.modelProvider), 80)}`] : []),
        ].join(" · ").replace(/^(.+)$/u, "- $1"),
        [
          ...(session.turnCount === undefined ? [] : [`轮数：${session.turnCount}`]),
          `状态：${session.status.type}`, `ID：${markdown(session.id.slice(0, 12), 24)}`,
        ].join(" · ").replace(/^/u, "- "),
      ].filter(Boolean).join("\n"),
    }));
    const filters = [
      `filter ${result.view.filter}`,
      ...(result.view.provider ? [`provider ${result.view.provider}`] : []),
      ...(result.view.searchTerm ? [`search ${result.view.searchTerm}`] : []),
    ].join(" ");
    const navigate = (next: number): MenuAction => ({
      kind: "sessions-page", page: next, filters, archived: result.archived,
    });
    const navigation = [
      ...(page > 1 ? [this.button(context, "上一页", navigate(page - 1))] : []),
      ...(page < pages ? [this.button(context, "下一页", navigate(page + 1))] : []),
      homeButton(),
    ];
    const buttons = entries.map(entry => this.button(context, `${entry.number} ${entry.session.name || entry.session.preview || "未命名"}`, {
      kind: result.archived ? "unarchive" : "resume", id: entry.session.id,
    }));
    const rows = buttonRows(buttons);
    const tools = [
      qqMenuButton("search", "搜索标题", result.archived ? "/archived search " : "/sessions search ", false),
      qqMenuButton("resume", "填写恢复ID", result.archived ? "/unarchive " : "/resume ", false),
    ];
    const last = rows.at(-1);
    if (last && last.buttons.length === 1) last.buttons.push(...tools);
    else rows.push({ buttons: tools });
    rows.push({ buttons: navigation });
    const content = [heading,
      ...entries.length ? entries.map(entry => entry.text) : ["当前工作区没有匹配会话。"], hint].join("\n\n");
    if (Buffer.byteLength(content) > QQ_MENU_PART_BYTES || rows.length > 5) throw unsupported();
    return this.panel(context, { content, keyboard: { content: { rows } } });
  }

  private metrics(context: MenuContext, scope?: string): QqMenuPanel {
    const buttons = scope === undefined
      ? [qqMenuButton("session", "当前会话", "/metrics session"),
        ...[["global", "全局"], ["providers", "提供商"], ["models", "模型"], ["errors", "错误"]].map(([value, label]) =>
          qqMenuButton(value!, label!, `/help metrics ${value}`))]
      : [["24h", "24小时"], ["7d", "7天"], ["30d", "30天"], ["90d", "90天"], ["all", "全部"]].map(([value, label]) =>
        qqMenuButton(value!, label!, `/metrics ${scope} ${value}`));
    const rows = buttonRows(buttons);
    rows.push({ buttons: [qqMenuButton("metrics", "统计范围", "/help metrics"), homeButton()] });
    const scopeLabels: Record<string, string> = { global: "全局", providers: "提供商", models: "模型", errors: "错误" };
    const scopeLabel = scopeLabels[scope ?? ""];
    const content = scope === undefined
      ? "## 请求统计\n\n### 统计范围\n\n1. 当前会话\n2. 全局\n3. 提供商\n4. 模型\n5. 错误\n\n点击下方范围；聚合统计继续选择时段。"
      : `## 请求统计\n\n**当前范围：${scopeLabel}**\n\n### 统计时段\n\n1. 24 小时\n2. 7 天\n3. 30 天\n4. 90 天\n5. 全部\n\n点击下方时段查看统计。`;
    return this.panel(context, { content, keyboard: { content: { rows } } });
  }

  private listPanel(context: MenuContext, title: string, lines: string[], buttons: QqMenuButton[], page: number, pageCount: number,
    navigate: (page: number) => MenuAction | RevertAction, extra: QqMenuButton[] = [], columns?: number): QqMenuPanel {
    const rows = buttonRows(buttons, columns);
    if (extra.length) rows.push({ buttons: extra });
    const footer: QqMenuButton[] = [];
    if (page > 1) footer.push(this.button(context, "上一页", navigate(page - 1)));
    if (page < pageCount) footer.push(this.button(context, "下一页", navigate(page + 1)));
    footer.push(homeButton());
    rows.push({ buttons: footer });
    const content = [`## ${title}\n`, ...(pageCount > 1 ? [`第 ${page} / ${pageCount} 页\n`] : []), ...lines.length ? lines : ["暂无可选项"]].join("\n");
    if (Buffer.byteLength(content, "utf8") > QQ_MENU_PART_BYTES || rows.length > 5) throw unsupported();
    return this.panel(context, { content, keyboard: { content: { rows } } });
  }
}

function homeButton(): QqMenuButton { return qqMenuButton("home", "首页", "/help"); }
function queueCommandId(id: string): string {
  // Pure numbers are shared list selectors, never an exact Queue ID command.
  if (!id || /[\s\p{Cc}\p{Cf}]/u.test(id) || /^\d+$/u.test(id)) throw unsupported();
  return id;
}
function buttonRows(buttons: QqMenuButton[], columns?: number): QqCommandKeyboard["content"]["rows"] {
  const rowCount = Math.ceil(buttons.length / (columns ?? 3));
  const rowSize = columns !== undefined && rowCount ? Math.ceil(buttons.length / rowCount) : 3;
  return Array.from({ length: rowCount }, (_, index) => ({ buttons: buttons.slice(index * rowSize, index * rowSize + rowSize) }));
}
function pageNumber(value?: string): number {
  const page = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > 20_000) throw unsupported();
  return page;
}
function slicePage<T>(entries: readonly T[], page: number, size: number): T[] {
  if (page < 1 || page > Math.max(1, Math.ceil(entries.length / size))) throw unsupported();
  return entries.slice((page - 1) * size, page * size);
}
function clean(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ").replace(/\s+/gu, " ").trim();
}
function bounded(value: string, maximum: number): string {
  const characters = Array.from(clean(value));
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join("")}…` : characters.join("") || "未命名";
}
function markdown(value: string, maximumBytes: number): string {
  let output = "";
  for (const character of clean(value)) {
    const escaped = escapeLifecycleLiteral(character);
    if (Buffer.byteLength(output + escaped, "utf8") > maximumBytes - 3) return `${output}…`;
    output += escaped;
  }
  return output || "未命名";
}
function expired(): UserFacingError { return new UserFacingError("command.selection.expired", "菜单已失效，请重新发送 /help 打开菜单。"); }
function unsupported(): UserFacingError { return new UserFacingError("command.unsupported", "QQ 菜单不支持此参数，请重新发送 /help。"); }
