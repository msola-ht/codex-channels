import { randomBytes } from "node:crypto";
import type { ConversationCommandExecutor, ConversationCommandResult, ThreadOccupancyIdentity } from "../../application/index.js";
import { conversationTargetKey, UserFacingError, type ConversationTarget } from "../../conversation-core/index.js";
import { formatConversationResetCredits } from "../conversation-model-account-command-format.js";
import { formatConversationOccupancy } from "../conversation-session-command-format.js";
import { formatQqLiteralDetails } from "./interactions.js";
import { qqMenuButton, type QqMenuButton } from "./command-menu.js";
import type { QqMenuPanel } from "./command-menu-controller.js";
import { planText } from "./outbox.js";

type Command = "limits" | "release";
interface Context {
  target: ConversationTarget;
  actorId: string;
  scope: string;
  deadline: number;
  controller: AbortController;
  signal: AbortSignal;
}
type Action = { kind: "command"; command: Command; input: string; identity?: ThreadOccupancyIdentity }
  | { kind: "cancel"; creditToken?: string };
interface Selection { context: Context; action: Action; ready: boolean }

/** Disposable confirmations; account consumption and process inspection stay in Application/Runtime. */
export class QqPrivilegedManagementMenu {
  private readonly contexts = new Set<Context>();
  private readonly selections = new Map<string, Selection>();

  constructor(private readonly options: {
    commands: ConversationCommandExecutor;
    scope(target: ConversationTarget): string;
    allowed(target: ConversationTarget, actorId: string): boolean;
    signal: AbortSignal;
  }) {}

  cancel(target: ConversationTarget): void {
    for (const context of [...this.contexts]) {
      if (conversationTargetKey(context.target) === conversationTargetKey(target)) context.controller.abort();
    }
  }

  close(): void { for (const context of [...this.contexts]) context.controller.abort(); }

  async open(target: ConversationTarget, actorId: string, command: Command, input: string): Promise<QqMenuPanel> {
    if (!this.options.allowed(target, actorId)) throw expired();
    const value = input.trim();
    const pick = /^pick ([a-f0-9]{24})$/u.exec(value);
    if (pick) return this.pick(target, actorId, command, pick[1]!);
    const creditConfirmation = command === "limits" ? /^reset (confirm|cancel) (\S+)$/u.exec(value) : null;
    if (creditConfirmation) {
      const [, operation, token] = creditConfirmation;
      const entry = [...this.selections].find(([, selection]) => this.matches(selection.context, target, actorId)
        && (operation === "confirm"
          ? selection.action.kind === "command" && selection.action.command === "limits" && selection.action.input === `reset confirm ${token}`
          : selection.action.kind === "cancel" && selection.action.creditToken === token));
      if (!entry) throw expired();
      return this.pick(target, actorId, command, entry[0]);
    }
    if (command === "release" && value !== "" && value !== "force") {
      throw new UserFacingError("release.usage", "用法：/release 或 /release force；强制释放须先完整查看预览再确认。");
    }
    if (command === "limits" && !/^reset(?: [1-9]\d{0,3}| use \S+)?$/u.test(value)) {
      throw new UserFacingError("reset-credit.failed", "重置券命令参数无效。", { reason: "usage" });
    }
    this.cancel(target);
    const context = this.context(target, actorId);
    try {
      // Even a typed force command opens a read-only preview first.
      return this.result(context, await this.execute(context, command, command === "release" ? "" : value));
    } catch (error) { context.controller.abort(); throw error; }
  }

  private context(target: ConversationTarget, actorId: string): Context {
    for (const context of [...this.contexts]) this.current(context);
    if (this.contexts.size >= 256) throw new UserFacingError("command.authorization-changed", "管理菜单容量已满，请稍后重新打开。");
    const controller = new AbortController();
    const context: Context = { target: Object.freeze({ ...target }), actorId, scope: this.options.scope(target),
      deadline: performance.now() + 300_000, controller, signal: AbortSignal.any([controller.signal, this.options.signal]) };
    this.assertCurrent(context);
    this.contexts.add(context);
    const timer = setTimeout(() => controller.abort(), Math.max(0, context.deadline - performance.now()));
    timer.unref();
    context.signal.addEventListener("abort", () => {
      clearTimeout(timer); this.contexts.delete(context);
      for (const [token, selection] of this.selections) if (selection.context === context) this.selections.delete(token);
    }, { once: true });
    return context;
  }

  private current(context: Context): boolean {
    let valid = false;
    try { valid = !context.signal.aborted && performance.now() < context.deadline
      && this.options.allowed(context.target, context.actorId) && this.options.scope(context.target) === context.scope; }
    catch { /* authorization checks fail closed */ }
    if (!valid) context.controller.abort();
    return valid;
  }

  private assertCurrent(context: Context): void { if (!this.current(context)) throw expired(); }

  private matches(context: Context, target: ConversationTarget, actorId: string): boolean {
    return context.actorId === actorId && conversationTargetKey(context.target) === conversationTargetKey(target);
  }

  private async execute(context: Context, command: Command, input: string, identity?: ThreadOccupancyIdentity): Promise<ConversationCommandResult> {
    this.assertCurrent(context);
    return this.options.commands.execute(context.target, command, input, context.actorId,
      () => this.assertCurrent(context), undefined, undefined, undefined, identity);
  }

  private async pick(target: ConversationTarget, actorId: string, command: Command, token: string): Promise<QqMenuPanel> {
    const selection = this.selections.get(token);
    if (!selection || !selection.ready || !this.matches(selection.context, target, actorId)
      || (selection.action.kind === "command" && selection.action.command !== command)
      || (selection.action.kind === "cancel" && (selection.action.creditToken !== undefined) !== (command === "limits"))) throw expired();
    const { context, action } = selection;
    this.assertCurrent(context);
    // Consume all sibling choices before waiting. Unknown writes are never retried.
    for (const [key, sibling] of this.selections) if (sibling.context === context) this.selections.delete(key);
    try {
      if (action.kind === "cancel") {
        if (action.creditToken) await this.execute(context, "limits", `reset cancel ${action.creditToken}`);
        context.controller.abort();
        return this.panel(this.context(target, actorId), "已取消本次管理确认；未发起本次消费或进程终止。", []);
      }
      return this.result(context, await this.execute(context, action.command, action.input, action.identity), action.identity !== undefined);
    } catch (error) { context.controller.abort(); throw error; }
  }

  private button(context: Context, label: string, action: Action, command: Command): QqMenuButton {
    this.assertCurrent(context);
    if (this.selections.size >= 4096) throw new UserFacingError("command.authorization-changed", "管理菜单选项容量已满，请重新打开。");
    const token = randomBytes(12).toString("hex");
    this.selections.set(token, { context, action, ready: false });
    return qqMenuButton(token, label, `/${command} pick ${token}`);
  }

  private panel(context: Context, content: string, buttons: QqMenuButton[], detail?: string, markdownDetail?: string): QqMenuPanel {
    this.assertCurrent(context);
    const literal = detail === undefined ? undefined : formatQqLiteralDetails(detail);
    if (literal !== undefined && planText({ mode: "active", recipient: context.actorId, content: literal }).length > 7) {
      throw new UserFacingError("command.authorization-changed", "完整管理预览超出 QQ 展示预算，请在本机核对，未开放确认。");
    }
    const rows: { buttons: QqMenuButton[] }[] = [];
    for (let index = 0; index < buttons.length; index += 3) rows.push({ buttons: buttons.slice(index, index + 3) });
    rows.push({ buttons: [qqMenuButton("limits", "账户额度", "/limits"), qqMenuButton("home", "返回首页", "/help")] });
    if (rows.length > 5) throw new UserFacingError("command.authorization-changed", "管理菜单超出容量，未开放确认。");
    const entries = buttons.map(button => this.selections.get(button.id)).filter((entry): entry is Selection => entry !== undefined);
    return { content, keyboard: { content: { rows } }, ...(literal === undefined ? {} : { detail: literal }),
      ...(markdownDetail === undefined ? {} : { markdownDetail }), signal: context.signal,
      isCurrent: () => this.current(context) && entries.every(entry => [...this.selections.values()].includes(entry)),
      delivered: () => {
        if (this.current(context)) for (const entry of entries) if ([...this.selections.values()].includes(entry)) entry.ready = true;
      } };
  }

  private result(context: Context, result: ConversationCommandResult, released = false): QqMenuPanel {
    this.assertCurrent(context);
    if (result.kind === "reset-credit") {
      const value = result.result;
      const buttons: QqMenuButton[] = [];
      if (value.type === "list") {
        for (const [index, credit] of value.credits.entries()) {
          if (!/^\S{1,256}$/u.test(credit.id)) throw new UserFacingError("reset-credit.failed", "券 ID 无法通过支持的命令格式选择，请使用本机入口。", { reason: "reset_unavailable" });
          const label = [...`${index + 1} ${credit.title ?? "用量重置券"}`.replace(/[\p{Cc}\p{Cf}]/gu, " ")];
          buttons.push(this.button(context, label.length > 10 ? `${label.slice(0, 9).join("")}…` : label.join(""),
            { kind: "command", command: "limits", input: `reset use ${credit.id}` }, "limits"));
        }
        if (value.page > 1) buttons.push(this.button(context, "上一页", { kind: "command", command: "limits", input: `reset ${value.page - 1}` }, "limits"));
        if (value.page < value.pageCount) buttons.push(this.button(context, "下一页", { kind: "command", command: "limits", input: `reset ${value.page + 1}` }, "limits"));
        buttons.push(this.button(context, "刷新券列表", { kind: "command", command: "limits", input: "reset" }, "limits"));
      } else if (value.type === "preview") {
        if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) throw expired();
        context.deadline = Math.min(context.deadline, performance.now() + value.expiresAt - Date.now());
        buttons.push(this.button(context, "确认使用重置券", { kind: "command", command: "limits", input: `reset confirm ${value.token}` }, "limits"),
          this.button(context, "取消本次确认", { kind: "cancel", creditToken: value.token }, "limits"));
      }
      const detail = formatConversationResetCredits(result, "buttons");
      return this.panel(context, value.type === "preview" ? "核对完整账户与券预览后确认。使用将消费所选券，结果未知时请先核对账户，不要重复提交。" : "OpenAI 重置券",
        buttons, detail, detail);
    }
    if (result.kind !== "occupancy") throw new UserFacingError("command.authorization-changed", "管理操作未返回可识别回执。");
    const value = result.result;
    const buttons: QqMenuButton[] = [];
    let detail = formatConversationOccupancy(result);
    if (!released && value.status === "held" && value.releasable && /^\d+$/u.test(value.holder.startedAt ?? "")) {
      const identity = { threadId: value.threadId, pid: value.holder.pid, startedAt: value.holder.startedAt! };
      detail += `\n\n强制释放确认\n目标 Thread：${identity.threadId}\n目标 PID：${identity.pid}\n进程启动身份：${identity.startedAt}\n确认将结束上述 Codex 进程，可能中断其全部会话与进行中的任务；若是受监管 App Server，服务可能自动重启并使所有会话重连。共享进程正常持锁不代表故障。\n仅限本用户、当前会话、Workspace 和 Thread，五分钟内有效；进程身份变化必须重新预览。`;
      buttons.push(this.button(context, "确认结束该进程", { kind: "command", command: "release", input: "force", identity }, "release"),
        this.button(context, "取消本次确认", { kind: "cancel" }, "release"));
    } else if (!released && value.status === "held" && value.releasable) {
      detail += "\n无法取得可靠进程启动身份，未开放强制释放，请在本机诊断。";
    }
    return this.panel(context, released ? "释放占用操作回执；失败或未知结果不会自动重试。" : "占用诊断与释放预览；完整送达后才可确认。", buttons, detail);
  }
}

function expired(): UserFacingError {
  return new UserFacingError("command.authorization-changed", "管理菜单或确认未完整送达、已使用、取消、过期或上下文变化，请重新预览。");
}
