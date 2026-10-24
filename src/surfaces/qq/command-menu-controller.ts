import { randomBytes } from "node:crypto";
import {
  fastServiceTierId,
  modelSelectionSnapshot,
  ultrafastServiceTierId,
  type ConversationCommandExecutor,
  type ConversationCommandResult,
  type ModelSelectionRequest,
  type ModelSelectionSnapshot,
} from "../../application/index.js";
import { conversationTargetKey, UserFacingError, type ConversationTarget } from "../../conversation-core/index.js";
import { formatConversationCommandOutcome } from "../conversation-command-outcome-format.js";
import { qqMenuButton, renderQqCommandMenu, type QqMenuButton } from "./command-menu.js";
import type { QqCommandKeyboard } from "./protocol.js";

export interface QqMenuPanel {
  content: string;
  keyboard: QqCommandKeyboard;
  isCurrent(): boolean;
}

interface Options {
  commands: ConversationCommandExecutor;
  scope(target: ConversationTarget): string;
  workspaceScope(target: ConversationTarget): string;
  selectionScope(target: ConversationTarget): string | undefined;
  allowed(target: ConversationTarget, actorId: string): boolean;
  beforeMutation(target: ConversationTarget): void;
  signal: AbortSignal;
}

type ModelView = "model" | "effort" | "fast";
type MenuAction =
  | { kind: "workspace"; id: string }
  | { kind: "model"; selection: ModelSelectionRequest }
  | { kind: "resume"; id: string }
  | { kind: "workspace-page"; page: number }
  | { kind: "model-page"; page: number; view: ModelView; snapshot: ModelSelectionSnapshot }
  | { kind: "sessions-page"; page: number; filters: string };

interface MenuContext {
  target: ConversationTarget;
  actorId: string;
  scope: string;
  workspaceScope: string;
  expiresAt: number;
  generation: number;
  selectionScope?: string;
}

interface Selection extends MenuContext { action: MenuAction }
type Workspaces = Extract<ConversationCommandResult, { kind: "workspaces" }>;
type Models = Extract<ConversationCommandResult, { kind: "models" }>;
type Sessions = Extract<ConversationCommandResult, { kind: "sessions" }>;
const MAX_SELECTIONS = 4096;
const MENU_LIFETIME_MS = 600_000;

/** One account generation owns these bounded, one-use command selections; no history is retained. */
export class QqCommandMenuController {
  private readonly selections = new Map<string, Selection>();
  private generation = 0;

  constructor(private readonly options: Options) {}

  clear(): void {
    this.selections.clear();
    this.generation += 1;
  }

  async open(target: ConversationTarget, actorId: string, argumentsText: string): Promise<QqMenuPanel> {
    const input = argumentsText.trim();
    const context = this.context(target, actorId);
    if (!input) return this.panel(context, renderQqCommandMenu());
    const pick = /^pick ([a-f0-9]{24})$/u.exec(input);
    if (pick) return this.pick(context, pick[1]!);
    const workspace = /^workspace(?: ([1-9][0-9]{0,4}))?$/u.exec(input);
    if (workspace) return this.workspacePage(context, pageNumber(workspace[1]));
    const model = /^model(?: ([1-9][0-9]{0,4}))?$/u.exec(input);
    if (model) return this.modelPage(context, pageNumber(model[1]), "model");
    const sessions = /^sessions(?: ([1-9][0-9]{0,4})(?: (.+))?)?$/u.exec(input);
    if (sessions) return this.sessionsPage(context, pageNumber(sessions[1]), sessions[2] ?? "");
    const metrics = /^metrics(?: (global|providers|models|errors))?$/u.exec(input);
    if (metrics) return this.metrics(context, metrics[1]);
    throw unsupported();
  }

  fromResult(target: ConversationTarget, actorId: string, result: ConversationCommandResult): QqMenuPanel | undefined {
    if (result.kind !== "workspaces" && result.kind !== "models" && result.kind !== "sessions") return undefined;
    const context = this.context(target, actorId);
    switch (result.kind) {
      case "workspaces": return this.workspaces(context, result, 1);
      case "models": return this.models(context, result, 1, result.view);
      case "sessions": return this.sessions(context, result, (result.page - 1) * 2 + 1);
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
    return !this.options.signal.aborted && context.generation === this.generation
      && performance.now() < context.expiresAt && this.options.allowed(context.target, context.actorId)
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

  private button(context: MenuContext, label: string, action: MenuAction): QqMenuButton {
    this.assertCurrent(context);
    while (this.selections.size >= MAX_SELECTIONS) this.selections.delete(this.selections.keys().next().value!);
    const token = randomBytes(12).toString("hex");
    this.selections.set(token, { ...context, action });
    return qqMenuButton(token, bounded(label, 10), `/help pick ${token}`);
  }

  private async pick(request: MenuContext, token: string): Promise<QqMenuPanel> {
    const selection = this.selections.get(token);
    if (!selection || selection.actorId !== request.actorId
      || conversationTargetKey(selection.target) !== conversationTargetKey(request.target)) throw expired();
    this.assertCurrent(selection);
    this.selections.delete(token);
    const { action } = selection;
    switch (action.kind) {
      case "workspace-page": return this.workspacePage(selection, action.page);
      case "model-page": return this.modelPage(selection, action.page, action.view, action.snapshot);
      case "sessions-page": return this.sessionsPage(selection, action.page, action.filters);
    }
    this.options.beforeMutation(selection.target);
    this.assertCurrent(selection);
    let result: ConversationCommandResult;
    if (action.kind === "workspace") {
      result = await this.options.commands.selectWorkspace(selection.target, action.id, selection.actorId);
    } else if (action.kind === "model") {
      // Shared model selection owns and validates its own Thread/snapshot progression,
      // including the synchronous unbinding performed by a Provider switch.
      result = await this.options.commands.selectModelSetting(selection.target, action.selection, selection.actorId,
        () => this.assertCurrent(selection, true));
      this.assertCurrent(selection, true);
    } else {
      result = await this.options.commands.execute(selection.target, "resume", action.id, selection.actorId);
    }
    // Only a completed mutation may adopt its resulting workspace or Thread scope.
    if (this.options.signal.aborted || selection.generation !== this.generation
      || performance.now() >= selection.expiresAt || !this.options.allowed(selection.target, selection.actorId)) throw expired();
    const next = this.context(selection.target, selection.actorId);
    if (result.kind === "models") return this.models(next, result, 1, result.view);
    if (result.kind !== "outcome") throw unsupported();
    return this.panel(next, { ...renderQqCommandMenu(), content: markdown(formatConversationCommandOutcome(result.outcome), 1600) });
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
      if (!selected) throw expired();
      const choices: Array<{ label: string; selection: ModelSelectionRequest }> = view === "effort"
        ? selected.supportedReasoningEfforts.map(option => ({
          label: `${option.effort === state.effort ? "当前 " : ""}${option.effort}`,
          selection: { kind: "effort", effort: option.effort, snapshot },
        }))
        : [
          { label: "Standard", selection: { kind: "fast", mode: "off", snapshot } },
          ...(fastServiceTierId(selected) ? [{ label: "Fast", selection: { kind: "fast" as const, mode: "on" as const, snapshot } }] : []),
          ...(ultrafastServiceTierId(selected) ? [{ label: "Ultrafast", selection: { kind: "fast" as const, mode: "ultrafast" as const, snapshot } }] : []),
        ];
      const entries = slicePage(choices, page, 9);
      const buttons = entries.map(choice => this.button(context, choice.label, { kind: "model", selection: choice.selection }));
      const extra = [this.button(context, "选择模型", { kind: "model-page", page: 1, view: "model", snapshot })];
      if (view === "effort" && (fastServiceTierId(selected) || ultrafastServiceTierId(selected))) {
        extra.push(this.button(context, "选择速度", { kind: "model-page", page: 1, view: "fast", snapshot }));
      }
      return this.listPanel(context, view === "effort" ? "选择思考等级" : "选择速度",
        [`当前模型：${markdown(selected.displayName, 100)}`, ...entries.map(choice => markdown(choice.label, 100))],
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

  private async sessionsPage(context: MenuContext, page: number, filters: string): Promise<QqMenuPanel> {
    this.assertCurrent(context);
    const result = await this.options.commands.execute(context.target, "sessions", `${Math.ceil(page / 2)} ${filters}`.trim(), context.actorId);
    this.assertCurrent(context);
    if (result.kind !== "sessions" || result.archived) throw unsupported();
    return this.sessions(context, result, page);
  }

  private sessions(context: MenuContext, result: Sessions, page: number): QqMenuPanel {
    if (result.archived) throw unsupported();
    const offset = page % 2 === 0 ? 10 : 0;
    const entries = result.sessions.slice(offset, offset + 10);
    const pages = Math.max(1, Math.ceil(result.matchedSessionCount / 10));
    if (page > pages) throw unsupported();
    const buttons = entries.map((session, index) => this.button(context, `${(page - 1) * 10 + index + 1} ${session.name || session.preview || session.id}`, { kind: "resume", id: session.id }));
    buttons.push(qqMenuButton("search", "搜索标题", "/sessions search ", false), qqMenuButton("resume", "手动恢复ID", "/resume ", false));
    const lines = entries.map((session, index) => `${(page - 1) * 10 + index + 1}. ${markdown(session.name || session.preview || session.id, 140)}${session.id === result.currentThreadId ? "（当前）" : ""}`);
    const filters = [
      `filter ${result.view.filter}`,
      ...(result.view.provider ? [`provider ${result.view.provider}`] : []),
      ...(result.view.searchTerm ? [`search ${result.view.searchTerm}`] : []),
    ].join(" ");
    return this.listPanel(context, "历史会话", lines, buttons, page, pages,
      next => ({ kind: "sessions-page", page: next, filters }));
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
    navigate: (page: number) => MenuAction, extra: QqMenuButton[] = []): QqMenuPanel {
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
function expired(): UserFacingError { return new UserFacingError("model.selection.expired", "菜单已失效，请重新发送 /help 打开菜单。"); }
function unsupported(): UserFacingError { return new UserFacingError("command.unsupported", "QQ 菜单不支持此参数，请重新发送 /help。"); }
