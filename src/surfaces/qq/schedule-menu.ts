import { randomBytes } from "node:crypto";
import { parseScheduledTaskOperation, type ConversationCommandExecutor, type ConversationCommandResult,
  type ScheduledTaskConfirmation } from "../../application/index.js";
import { conversationTargetKey, UserFacingError, type ConversationTarget } from "../../conversation-core/index.js";
import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { formatConversationCommandOutcome } from "../conversation-command-outcome-format.js";
import { formatConversationScheduledConfirmation, formatConversationScheduledTasks,
  formatConversationScheduledRuns } from "../conversation-scheduled-task-command-format.js";
import { qqMenuButton, type QqMenuButton } from "./command-menu.js";
import type { QqMenuPanel } from "./command-menu-controller.js";
import { formatQqLiteralDetails } from "./interactions.js";
import { qqLiteralMarkdown } from "./message-markdown.js";
import { planText } from "./outbox.js";
import { QqProtocolError } from "./protocol.js";

type ScheduledTaskOperationContext = NonNullable<Parameters<ConversationCommandExecutor["execute"]>[7]>;

interface Context extends ScheduledTaskOperationContext {
  readonly target: ConversationTarget;
  readonly actorId: string;
  readonly scope: string;
  readonly deadline: number;
  readonly controller: AbortController;
}
type Action = { kind: "command"; input: string }
  | { kind: "confirm"; token: string }
  | { kind: "cancel" };
interface Selection { context: Context; action: Action; ready: boolean }

/** Disposable UI identities only. Application owns tasks, runs, previews and writes. */
export class QqScheduleMenu {
  private readonly contexts = new Set<Context>();
  private readonly selections = new Map<string, Selection>();

  constructor(private readonly options: {
    commands: ConversationCommandExecutor;
    scope(target: ConversationTarget): string;
    allowed(target: ConversationTarget, actorId: string): boolean;
    signal: AbortSignal;
  }) {}

  cancel(target: ConversationTarget): void {
    for (const context of [...this.contexts]) if (conversationTargetKey(context.target) === conversationTargetKey(target)) context.controller.abort();
  }

  close(): void { for (const context of [...this.contexts]) context.controller.abort(); }

  async open(target: ConversationTarget, actorId: string, input: string): Promise<QqMenuPanel> {
    if (!this.options.allowed(target, actorId)) throw expired();
    const value = input.trim();
    if (value === "cancel") {
      this.cancel(target);
      return this.panel(this.context(target, actorId), "已取消计划任务确认；已运行的任务不会因此停止。", []);
    }
    const pick = /^pick ([a-f0-9]{24})$/u.exec(value);
    if (pick) return this.pick(target, actorId, pick[1]!);
    const operation = parseScheduledTaskOperation(value);
    if (operation.type === "confirm") {
      const entry = [...this.selections].find(([, selection]) => selection.action.kind === "confirm"
        && selection.action.token === operation.token && this.matches(selection.context, target, actorId));
      if (!entry) throw expired();
      return this.pick(target, actorId, entry[0]);
    }
    const context = this.context(target, actorId);
    try { return this.result(context, await this.execute(context, value)); }
    catch (error) { context.controller.abort(); throw error; }
  }

  present(target: ConversationTarget, actorId: string, preview: ScheduledTaskConfirmation): QqMenuPanel {
    const context = this.context(target, actorId, preview.expiresAt);
    try { return this.confirmation(context, preview); }
    catch (error) { context.controller.abort(); throw error; }
  }

  private context(target: ConversationTarget, actorId: string, expiresAt = Date.now() + 300_000): Context {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw expired();
    for (const context of [...this.contexts]) this.current(context);
    if (this.contexts.size >= 256) throw new UserFacingError("scheduled-task.state.invalid", "计划任务菜单容量已满，请稍后重新打开。");
    const controller = new AbortController();
    const deadline = performance.now() + Math.min(300_000, expiresAt - Date.now());
    const context: Context = { target: Object.freeze({ ...target }), actorId, scope: this.options.scope(target), deadline, controller,
      signal: AbortSignal.any([controller.signal, this.options.signal]), assertCurrent: () => {
        if (!this.current(context)) throw expired();
      } };
    context.assertCurrent();
    this.contexts.add(context);
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - performance.now()));
    timer.unref();
    context.signal.addEventListener("abort", () => {
      clearTimeout(timer); this.contexts.delete(context);
      for (const [token, selection] of this.selections) if (selection.context === context) this.selections.delete(token);
    }, { once: true });
    return context;
  }

  private current(context: Context): boolean {
    let current = false;
    try { current = !context.signal.aborted && performance.now() < context.deadline
      && this.options.allowed(context.target, context.actorId) && this.options.scope(context.target) === context.scope; }
    catch { /* authorization checks fail closed */ }
    if (!current) context.controller.abort();
    return current;
  }

  private matches(context: Context, target: ConversationTarget, actorId: string): boolean {
    return context.actorId === actorId && conversationTargetKey(context.target) === conversationTargetKey(target);
  }

  private async execute(context: Context, input: string): Promise<ConversationCommandResult> {
    context.assertCurrent();
    const result = await this.options.commands.execute(context.target, "schedule", input, context.actorId,
      () => context.assertCurrent(), undefined, undefined, context);
    context.assertCurrent();
    return result;
  }

  private async pick(target: ConversationTarget, actorId: string, token: string): Promise<QqMenuPanel> {
    const selection = this.selections.get(token);
    if (!selection || !this.matches(selection.context, target, actorId) || !selection.ready) throw expired();
    const { context, action } = selection;
    context.assertCurrent();
    // Consume before any write; an unknown result must not be repeated.
    this.selections.delete(token);
    if (action.kind === "cancel") {
      context.controller.abort();
      return this.panel(this.context(target, actorId), "已取消本次计划任务确认；已运行任务仍按原状态继续。", []);
    }
    try { return this.result(context, await this.execute(context, action.kind === "confirm" ? `confirm ${action.token}` : action.input)); }
    catch (error) { context.controller.abort(); throw error; }
  }

  private button(context: Context, label: string, action: Action, ready = true): QqMenuButton {
    context.assertCurrent();
    if (this.selections.size >= 4096) throw new UserFacingError("scheduled-task.state.invalid", "计划任务选项容量已满，请稍后重试。");
    const token = randomBytes(12).toString("hex");
    this.selections.set(token, { context, action, ready });
    return qqMenuButton(token, label, `/schedule pick ${token}`);
  }

  private command(context: Context, label: string, input: string): QqMenuButton {
    return this.button(context, label, { kind: "command", input });
  }

  private panel(context: Context, content: string, buttons: QqMenuButton[], detail?: string): QqMenuPanel {
    context.assertCurrent();
    const rows: { buttons: QqMenuButton[] }[] = [];
    for (let index = 0; index < buttons.length; index += 3) rows.push({ buttons: buttons.slice(index, index + 3) });
    rows.push({ buttons: [qqMenuButton("schedulehome", "计划任务列表", "/schedule list"), qqMenuButton("home", "返回首页", "/help")] });
    if (rows.length > 5) throw new QqProtocolError("message", "invalid-input");
    const literal = detail === undefined ? undefined : formatQqLiteralDetails(detail);
    if (literal !== undefined && planText({ mode: "active", recipient: context.actorId, content: literal }).length > 7) {
      throw new UserFacingError("scheduled-task.state.invalid", "计划任务详情超出 QQ 完整展示预算，请在本机核对。");
    }
    const markdownDetail = detail === undefined ? undefined : qqLiteralMarkdown(detail);
    return { content, keyboard: { content: { rows } }, ...(literal === undefined ? {} : { detail: literal }),
      ...(markdownDetail === undefined ? {} : { markdownDetail }),
      isCurrent: () => this.current(context), signal: context.signal };
  }

  private confirmation(context: Context, preview: ScheduledTaskConfirmation): QqMenuPanel {
    if (!Number.isSafeInteger(preview.expiresAt) || preview.expiresAt <= Date.now()) throw expired();
    const confirm = this.button(context, preview.action === "create" ? "确认创建" : "确认删除", { kind: "confirm", token: preview.token }, false);
    const selected = this.selections.get(confirm.id)!;
    const panel = this.panel(context, "核对完整预览后确认。五分钟内有效；停止、切换、取消或重启后失效。暂停与删除不会停止已运行任务。",
      [confirm, this.button(context, "取消本次确认", { kind: "cancel" })],
      formatConversationScheduledConfirmation({ kind: "scheduled-confirmation", preview }));
    return { ...panel, isCurrent: () => panel.isCurrent() && this.selections.get(confirm.id) === selected,
      delivered: () => {
        if (this.current(context) && Date.now() < preview.expiresAt && this.selections.get(confirm.id) === selected) selected.ready = true;
      } };
  }

  private result(context: Context, result: ConversationCommandResult): QqMenuPanel {
    context.assertCurrent();
    if (result.kind === "scheduled-confirmation") return this.confirmation(context, result.preview);
    if (result.kind === "scheduled-tasks") {
      const list = result.result;
      const buttons = list.tasks.map((task, index) => this.command(context, `任务 ${list.selectors[index] ?? index + 1}`, `runs ${task.taskId}`));
      if (list.page > 1) buttons.push(this.command(context, "上一页", `list ${list.page - 1}`));
      if (list.page < list.pageCount) buttons.push(this.command(context, "下一页", `list ${list.page + 1}`));
      buttons.push(qqMenuButton("scheduleadd", "新增计划任务", "/help schedule-create"));
      return this.panel(context, "选择任务查看运行记录与管理选项。新增需求须写明时区。", buttons, formatConversationScheduledTasks(result, "snapshot", "buttons"));
    }
    if (result.kind === "scheduled-runs") {
      const { task, runs, page, pageCount } = result.result;
      const buttons = [this.command(context, "立即运行", `run ${task.taskId}`),
        this.command(context, task.status === "paused" ? "恢复计划" : "暂停计划", `${task.status === "paused" ? "resume" : "pause"} ${task.taskId}`),
        this.command(context, "删除预览", `delete ${task.taskId}`)];
      const prefix = `/schedule rename ${task.taskId} `;
      if ([...prefix].length <= 100) buttons.push(qqMenuButton("schedulerename", "填写新名称", prefix, false));
      const navigation = [
        ...(page > 1 ? [this.command(context, "上一页", `runs ${task.taskId} ${page - 1}`)] : []),
        ...(page < pageCount ? [this.command(context, "下一页", `runs ${task.taskId} ${page + 1}`)] : []),
      ];
      const visibleRetries = runs.filter(run => run.state === "uncertain").slice(0, 12 - buttons.length - navigation.length);
      for (const run of visibleRetries) buttons.push(this.command(context, `重试 ${run.selector}`, `retry ${run.runId}`));
      buttons.push(...navigation);
      // The remaining uncertain Run IDs remain available in the full literal details.
      return this.panel(context, "暂停、删除不会停止已运行任务；/stop 操作当前前台任务。结果未知时先核对 Run，再显式重试。",
        buttons, formatConversationScheduledRuns(result, "snapshot", "buttons"));
    }
    const text = result.kind === "outcome" ? formatConversationCommandOutcome(result.outcome) : renderConversationCommandResult(result);
    if (!text) throw new UserFacingError("scheduled-task.state.invalid", "计划任务没有可交付结果。");
    return this.panel(context, "计划任务操作回执", [], text);
  }
}

function expired(): UserFacingError {
  return new UserFacingError("scheduled-task.confirmation.invalid", "计划任务菜单或确认未完整送达、已取消、过期或上下文变化，请重新预览。");
}
