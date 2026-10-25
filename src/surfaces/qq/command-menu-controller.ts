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
import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { formatServiceTierSetting } from "../provider-format.js";
import { formatConversationHooks, hookCommandChoices } from "../conversation-hook-command-format.js";
import { formatThreadQueueInputTypeLabel } from "../conversation-session-command-format.js";
import { formatQqLiteralDetails } from "./interactions.js";
import { qqLiteralMarkdown } from "./message-markdown.js";
import { qqMenuButton, renderQqCommandMenu, type QqMenuButton } from "./command-menu.js";
import type { QqCommandKeyboard } from "./protocol.js";
import { QqProtocolError } from "./protocol.js";
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
    if (!input) return this.panel(context, renderQqCommandMenu());
    if (input === "account") return this.panel(context, {
      content: "# 账户工具\n查看重置券或当前渠道身份。机器人接入与群授权请在本机 Setup 管理。",
      keyboard: { content: { rows: [
        { buttons: [qqMenuButton("credits", "查看重置券", "/limits reset"), qqMenuButton("whoami", "我的身份", "/whoami")] },
        { buttons: [homeButton()] },
      ] } },
    });
    if (input === "extensions") return this.panel(context, {
      content: "# 能力与集成\n选择技能、子代理或插件后填写任务；MCP 管理及 Hook 确认沿各自入口处理。",
      keyboard: { content: { rows: [
        { buttons: [qqMenuButton("agents", "子代理", "/agents"), qqMenuButton("skill", "Skills", "/skill"), qqMenuButton("plugin", "Plugin", "/plugin")] },
        { buttons: [qqMenuButton("mcp", "MCP 列表", "/mcp"), qqMenuButton("mcphealth", "MCP 健康", "/mcp health"), qqMenuButton("pluginhealth", "插件健康", "/plugin health")] },
        { buttons: [qqMenuButton("hooks", "Hooks", "/hooks"), qqMenuButton("mcpreload", "重载 MCP", "/mcp reload")] },
        { buttons: [homeButton()] },
      ] } },
    });
    if (input === "tasks") return this.panel(context, {
      content: "# 任务工具\n查看改动、发起审查或管理排队与计划任务。",
      keyboard: { content: { rows: [
        { buttons: [qqMenuButton("diff", "Diff", "/diff"), qqMenuButton("review", "Review", "/help review")] },
        { buttons: [qqMenuButton("queue", "原生队列", "/help queue"), qqMenuButton("schedule", "计划任务", "/schedule")] },
        { buttons: [qqMenuButton("planrequest", "填写计划需求", "/plan ", false)] },
        { buttons: [homeButton()] },
      ] } },
    });
    if (input === "review") return this.panel(context, {
      content: "# Review\n审查当前改动可直接执行；指定分支、提交或审查要求时填写相应内容。",
      keyboard: { content: { rows: [
        { buttons: [qqMenuButton("review", "审查当前改动", "/review"), qqMenuButton("reviewbranch", "审查分支差异", "/review branch ", false)] },
        { buttons: [qqMenuButton("reviewcommit", "审查指定提交", "/review commit ", false), qqMenuButton("reviewcustom", "填写审查要求", "/review custom ", false)] },
        { buttons: [qqMenuButton("contents", "返回任务工具", "/help tasks"), homeButton()] },
      ] } },
    });
    if (input === "settings") return this.panel(context, {
      content: "# 偏好设置\n调整后续任务的模式与当前会话审批方式；权限入口仅查询。",
      keyboard: { content: { rows: [
        { buttons: [qqMenuButton("effort", "思考等级", "/effort"), qqMenuButton("fast", "速度设置", "/fast status")] },
        { buttons: [qqMenuButton("goal", "Goal", "/goal"), qqMenuButton("plan", "Plan 模式", "/plan")] },
        { buttons: [qqMenuButton("autoreview", "会话审批方式", "/autoreview"), qqMenuButton("permissions", "权限查询", "/permissions")] },
        { buttons: [homeButton()] },
      ] } },
    });
    if (input === "manage") return this.panel(context, {
      content: "# 会话操作\n操作当前会话；归档会退出当前会话。",
      keyboard: { content: { rows: [
        { buttons: [qqMenuButton("archive", "归档当前", "/archive"), qqMenuButton("archived", "已归档会话", "/help archived 1")] },
        { buttons: [qqMenuButton("fork", "分叉会话", "/fork"), qqMenuButton("rename", "重命名", "/rename ", false)] },
        { buttons: [qqMenuButton("release", "释放占用", "/release"), qqMenuButton("pin", "固定会话", "/pin"), qqMenuButton("unpin", "取消固定", "/unpin")] },
        { buttons: [qqMenuButton("revert", "历史回退", "/revert"), qqMenuButton("compact", "压缩上下文", "/compact")] },
        { buttons: [homeButton()] },
      ] } },
    });
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

  fromResult(target: ConversationTarget, actorId: string, result: ConversationCommandResult): QqMenuPanel | undefined {
    const extension = renderQqExtensionCommand(result);
    if (extension) return this.extensionPanel({ ...this.context(target, actorId), queryScope: this.options.queryScope(target) }, extension);
    if (result.kind === "thread-queue") return this.queueList(this.queueContext(this.context(target, actorId)), result, (result.result.page - 1) * 3 + 1);
    if (result.kind !== "workspaces" && result.kind !== "models" && result.kind !== "sessions" && result.kind !== "auto-review" && result.kind !== "goal") return undefined;
    const context = this.context(target, actorId);
    switch (result.kind) {
      case "workspaces": return this.workspaces(context, result, 1);
      case "models": return this.models(context, result, 1, result.view);
      case "sessions": return this.sessions(context, result, (result.page - 1) * 2 + 1);
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

  private current(context: MenuContext, workspaceOnly = false): boolean {
    return !this.options.signal.aborted && !context.revertSignal?.aborted && !context.hookSignal?.aborted && !context.queueSignal?.aborted && context.generation === this.generation
      && performance.now() < context.expiresAt && this.options.allowed(context.target, context.actorId)
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

  private button(context: MenuContext, label: string, action: MenuAction | RevertAction | QueueAction): QqMenuButton {
    this.assertCurrent(context);
    while (this.selections.size >= MAX_SELECTIONS) this.selections.delete(this.selections.keys().next().value!);
    const token = randomBytes(12).toString("hex");
    this.selections.set(token, { ...context, action, ready: !["revert-confirm", "hook-confirm", "auto-review", "goal-clear", "queue-write"].includes(action.kind) });
    return qqMenuButton(token, bounded(label, 10), `/help pick ${token}`);
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
        return this.panel(selection, { content: markdown(formatConversationCommandOutcome(result.outcome), 1600),
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
        return this.panel(selection, { content: "# 已清除当前会话目标\n清除目标不等于中断正在运行的任务；如需停止，请使用 /stop。",
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
      result = await this.options.commands.selectWorkspace(selection.target, action.id, selection.actorId);
    } else if (action.kind === "model") {
      // Shared model selection owns and validates its own Thread/snapshot progression,
      // including the synchronous unbinding performed by a Provider switch.
      result = await this.options.commands.selectModelSetting(selection.target, action.selection, selection.actorId,
        () => this.assertCurrent(selection, true));
      this.assertCurrent(selection, true);
    } else {
      result = await this.options.commands.execute(selection.target, action.kind, action.id, selection.actorId);
    }
    // Only a completed mutation may adopt its resulting workspace or Thread scope.
    if (this.options.signal.aborted || selection.generation !== this.generation
      || performance.now() >= selection.expiresAt || !this.options.allowed(selection.target, selection.actorId)) throw expired();
    const next = this.context(selection.target, selection.actorId);
    if (result.kind === "models") return this.models(next, result, 1, result.view);
    if (result.kind !== "outcome") throw unsupported();
    return this.panel(next, { ...renderQqCommandMenu(), content: markdown(formatConversationCommandOutcome(result.outcome), 1600) });
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
    const content = ["# App Server Queue", `第 ${page} 屏 · 共 ${shared.totalItemCount} 条 · 每屏最多九项`,
      "选择条目查看完整安全摘要；条目正文由 App Server 持久保存，Gateway 不保存第二份。",
      ...entries.map((item, index) => `${(shared.page - 1) * 25 + local * 9 + index + 1}. ${markdown(item.textPreview ?? formatThreadQueueInputTypeLabel(item.inputType), 130)}`),
      ...entries.length ? [] : ["队列为空。"],
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
      ? qqMenuButton(`task${index}`, bounded(choice.label, 10), `/${choice.command} ${choice.input} `, false)
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
    const buttons = hookCommandChoices(result.view).map(choice => this.button(context, choice.label,
      choice.input.startsWith("confirm ") ? { kind: "hook-confirm", token: choice.input.slice(8) } : { kind: "hook", input: choice.input }));
    const rows = buttonRows(buttons);
    rows.push({ buttons: [qqMenuButton("extensions", "扩展管理", "/help extensions"), homeButton()] });
    if (rows.length > 5) throw unsupported();
    // Hook review fields must never acquire Markdown semantics, even inside a fence.
    const detail = formatQqLiteralDetails(formatConversationHooks(result.view, true));
    try {
      if (planText({ mode: "active", recipient: context.actorId, content: detail }).length > 7) throw new QqProtocolError("message", "invalid-input");
    } catch (error) {
      if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input") throw error;
      throw new UserFacingError("hooks.local-review-required", "Hook 详情超出完整展示预算");
    }
    return { ...this.panel(context, { content: "核对上方完整 Hook 信息后操作。确认仅对本次预览有效；停止、切换或重启后失效。", keyboard: { content: { rows } } }),
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
    const entries = slicePage(result.workspaces, page, 9);
    const buttons = entries.map((workspace, index) => this.button(context,
      `${(page - 1) * 9 + index + 1} ${workspace.name}`, { kind: "workspace", id: workspace.id }));
    const lines = entries.map((workspace, index) =>
      `${(page - 1) * 9 + index + 1}. ${markdown(workspace.name, 100)}${workspace.id === result.currentWorkspaceId ? "（当前）" : ""}\n${markdown(workspace.id, 70)}`);
    return this.listPanel(context, "选择工作区", lines, buttons, page, Math.ceil(result.workspaces.length / 9),
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

  private models(context: MenuContext, result: Models, page: number, view: ModelView): QqMenuPanel {
    const { state } = result;
    const snapshot = modelSelectionSnapshot(state);
    if (this.options.selectionScope(context.target) !== snapshot.selectionScope) throw expired();
    context = { ...context, selectionScope: snapshot.selectionScope };
    const selected = state.models.find(model => model.model === state.model
      && (model.provider ?? "openai") === (state.modelProvider ?? "openai") && model.available !== false);
    if (view !== "model") {
      if (!selected && view === "effort") throw expired();
      const choices: Array<{ label: string; selection: ModelSelectionRequest }> = view === "effort"
        ? selected!.supportedReasoningEfforts.map(option => ({
          label: `${option.effort === state.effort ? "当前 " : ""}${option.effort}`,
          selection: { kind: "effort", effort: option.effort, snapshot },
        }))
        : [
          { label: "Standard", selection: { kind: "fast", mode: "off", snapshot } },
          ...(selected && fastServiceTierId(selected) ? [{ label: "Fast", selection: { kind: "fast" as const, mode: "on" as const, snapshot } }] : []),
          ...(selected && ultrafastServiceTierId(selected) ? [{ label: "Ultrafast", selection: { kind: "fast" as const, mode: "ultrafast" as const, snapshot } }] : []),
        ];
      const entries = slicePage(choices, page, 9);
      const buttons = entries.map(choice => this.button(context, choice.label, { kind: "model", selection: choice.selection }));
      const extra = [this.button(context, "选择模型", { kind: "model-page", page: 1, view: "model", snapshot })];
      if (view === "effort" && selected && (fastServiceTierId(selected) || ultrafastServiceTierId(selected))) {
        extra.push(this.button(context, "选择速度", { kind: "model-page", page: 1, view: "fast", snapshot }));
      }
      return this.listPanel(context, view === "effort" ? "选择思考等级" : "选择速度",
        [`当前模型：${markdown(selected?.displayName ?? state.model ?? "未知", 100)}`, ...(view === "fast" ? [`速度：${markdown(formatServiceTierSetting(state, selected), 200)}`, "速度影响下一轮；主 Provider 同时更新 Codex 用户级默认速度。"] : []), ...entries.map(choice => markdown(choice.label, 100))],
        buttons, page, Math.ceil(choices.length / 9), next => ({ kind: "model-page", page: next, view, snapshot }), extra);
    }
    const catalog = state.models.filter(model => model.available !== false);
    const entries = slicePage(catalog, page, 9);
    const buttons = entries.map((model, index) => this.button(context, `${(page - 1) * 9 + index + 1} ${model.displayName}`, {
      kind: "model", selection: { kind: "model", provider: model.provider ?? "openai", model: model.model, snapshot },
    }));
    const lines = entries.map((model, index) => `${(page - 1) * 9 + index + 1}. ${markdown(model.displayName, 80)}\n${markdown(`${model.provider ?? "openai"} / ${model.model}`, 90)}`);
    const extra: QqMenuButton[] = [];
    if (selected && selected.supportedReasoningEfforts.length > 1) extra.push(this.button(context, "思考等级", { kind: "model-page", page: 1, view: "effort", snapshot }));
    if (selected && (fastServiceTierId(selected) || ultrafastServiceTierId(selected))) extra.push(this.button(context, "选择速度", { kind: "model-page", page: 1, view: "fast", snapshot }));
    return this.listPanel(context, "选择模型", lines, buttons, page, Math.ceil(catalog.length / 9),
      next => ({ kind: "model-page", page: next, view: "model", snapshot }), extra);
  }

  private async sessionsPage(context: MenuContext, page: number, filters: string, archived: boolean): Promise<QqMenuPanel> {
    this.assertCurrent(context);
    const result = await this.options.commands.execute(context.target, archived ? "archived" : "sessions", `${Math.ceil(page / 2)} ${filters}`.trim(), context.actorId);
    this.assertCurrent(context);
    if (result.kind !== "sessions" || result.archived !== archived) throw unsupported();
    return this.sessions(context, result, page);
  }

  private sessions(context: MenuContext, result: Sessions, page: number): QqMenuPanel {
    const offset = page % 2 === 0 ? 10 : 0;
    const entries = result.sessions.slice(offset, offset + 10);
    const pages = Math.max(1, Math.ceil(result.matchedSessionCount / 10));
    if (page > pages) throw unsupported();
    const buttons = entries.map((session, index) => this.button(context, `${(page - 1) * 10 + index + 1} ${session.name || session.preview || session.id}`, { kind: result.archived ? "unarchive" : "resume", id: session.id }));
    buttons.push(qqMenuButton("search", "搜索标题", result.archived ? "/archived search " : "/sessions search ", false),
      qqMenuButton("resume", "手动恢复ID", result.archived ? "/unarchive " : "/resume ", false));
    const lines = entries.map((session, index) => `${(page - 1) * 10 + index + 1}. ${markdown(session.name || session.preview || session.id, 140)}${session.id === result.currentThreadId ? "（当前）" : ""}`);
    const filters = [
      `filter ${result.view.filter}`,
      ...(result.view.provider ? [`provider ${result.view.provider}`] : []),
      ...(result.view.searchTerm ? [`search ${result.view.searchTerm}`] : []),
    ].join(" ");
    return this.listPanel(context, result.archived ? "已归档会话 · 选择恢复" : "历史会话", lines, buttons, page, pages,
      next => ({ kind: "sessions-page", page: next, filters, archived: result.archived }));
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
    return this.panel(context, { content: scope === undefined ? "# 请求统计" : "# 选择统计时段", keyboard: { content: { rows } } });
  }

  private listPanel(context: MenuContext, title: string, lines: string[], buttons: QqMenuButton[], page: number, pageCount: number,
    navigate: (page: number) => MenuAction | RevertAction, extra: QqMenuButton[] = []): QqMenuPanel {
    const rows = buttonRows(buttons);
    if (extra.length) rows.push({ buttons: extra });
    const footer: QqMenuButton[] = [];
    if (page > 1) footer.push(this.button(context, "上一页", navigate(page - 1)));
    if (page < pageCount) footer.push(this.button(context, "下一页", navigate(page + 1)));
    footer.push(homeButton());
    rows.push({ buttons: footer });
    const content = [`# ${title}`, `${page} / ${Math.max(1, pageCount)}`, ...lines.length ? lines : ["暂无可选项"]].join("\n");
    if (Buffer.byteLength(content, "utf8") > 2000 || rows.length > 5) throw unsupported();
    return this.panel(context, { content, keyboard: { content: { rows } } });
  }
}

function homeButton(): QqMenuButton { return qqMenuButton("home", "首页", "/help"); }
function queueCommandId(id: string): string {
  // Pure numbers are shared list selectors, never an exact Queue ID command.
  if (!id || /[\s\p{Cc}\p{Cf}]/u.test(id) || /^\d+$/u.test(id)) throw unsupported();
  return id;
}
function buttonRows(buttons: QqMenuButton[]): QqCommandKeyboard["content"]["rows"] {
  return Array.from({ length: Math.ceil(buttons.length / 3) }, (_, index) => ({ buttons: buttons.slice(index * 3, index * 3 + 3) }));
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
    const escaped = /[\\`*_{}[\]()#+.!|>~<]/u.test(character) ? `\\${character}` : character;
    if (Buffer.byteLength(output + escaped, "utf8") > maximumBytes - 3) return `${output}…`;
    output += escaped;
  }
  return output || "未命名";
}
function expired(): UserFacingError { return new UserFacingError("command.selection.expired", "菜单已失效，请重新发送 /help 打开菜单。"); }
function unsupported(): UserFacingError { return new UserFacingError("command.unsupported", "QQ 菜单不支持此参数，请重新发送 /help。"); }
