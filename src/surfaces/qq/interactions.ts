import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { resolveApprovalChoice, safeInteractionDecision, type ApprovalChoice,
  type InteractionDecision, type InteractionPort, type InteractionRequest } from "../../approval/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
import { PendingInteractionRegistry } from "../pending-interaction-registry.js";
import { qqMenuButton } from "./command-menu.js";
import type { QqCommandKeyboard } from "./protocol.js";
import type { QqMessageInput } from "./message-input.js";

interface Pending {
  requestId: string;
  request: InteractionRequest;
  target: ConversationTarget;
  resolve(decision: InteractionDecision): void;
  timer: NodeJS.Timeout;
  deadline: number;
  current: () => boolean;
  ready: boolean;
  revision: number;
  question: number;
  page: number;
  answers: Record<string, string[]>;
}

export interface QqInteractionOptions {
  logger: Logger;
  /** Capture original actor/workspace/ownership before any asynchronous work. */
  authorize(target: ConversationTarget, request: InteractionRequest): (() => boolean) | undefined;
  prepareAsyncAnswer(target: ConversationTarget, request: Extract<InteractionRequest, { type: "user-input" }>, message: QqMessageInput): boolean;
  send(target: ConversationTarget, content: string, controls: { content: string; keyboard: QqCommandKeyboard; markdownContent?: string },
    signal: AbortSignal, current: () => boolean): Promise<void>;
}

/** Disposable presentation and response tokens; shared Approval owns decisions and routing. */
export class QqInteractions implements InteractionPort {
  private readonly pending = new PendingInteractionRegistry<Pending>();
  private readonly preparations = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: QqInteractionOptions) {}

  request(target: ConversationTarget, request: InteractionRequest): Promise<InteractionDecision> {
    const safe = () => safeInteractionDecision(request);
    const current = this.options.authorize(target, request);
    if (this.closed || !current || !Number.isFinite(request.expiresInMs) || request.expiresInMs <= 0
      || request.expiresInMs > 2_147_483_647 || !this.check(current)
      || (request.type === "elicitation" && request.mode === "tool-approval" && !request.toolApproval)
      || (request.type === "user-input" && (request.questions.length === 0
        || new Set(request.questions.map(question => question.id)).size !== request.questions.length))) return Promise.resolve(safe());
    const token = randomBytes(18).toString("base64url");
    if (!this.pending.reserve(request.requestId, token)) return Promise.resolve(safe());
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finish(token, safe()), request.expiresInMs);
      timer.unref();
      const pending: Pending = { requestId: request.requestId, request, target, resolve, timer,
        deadline: performance.now() + request.expiresInMs, current, ready: false, revision: 0,
        question: 0, page: 0, answers: Object.create(null) as Record<string, string[]> };
      this.pending.activate(token, pending);
      this.prepare(token, pending);
    });
  }

  /** Reserved syntax is consumed even after expiry/restart, never submitted as a task. */
  respond(target: ConversationTarget, message: QqMessageInput): string | undefined {
    const { actorId, content: text } = message;
    if (!/^\s*\/respond(?:\s|$)/iu.test(text)) return undefined;
    const match = /^\s*\/respond ([A-Za-z0-9_-]{24}) (\d+) ([a-z]+\d*)(?: ([\s\S]*))?$/u.exec(text.trim());
    if (!match) return "回应格式无效，请使用原请求中的按钮或输入回答入口。";
    const [, token, revision, action, value] = match;
    const pending = this.pending.get(token!);
    if (!pending || pending.target.surface !== target.surface || pending.target.accountId !== target.accountId
      || pending.target.conversationId !== target.conversationId || target.conversationId !== `c2c:${actorId}`
      || (pending.request.type === "user-input" && pending.request.expectedActorId !== undefined
        && pending.request.expectedActorId !== actorId)) return "该请求已失效或不属于当前用户。";
    if (!this.valid(pending)) {
      this.finish(token!, safeInteractionDecision(pending.request));
      return "该请求已失效，请勿重复回应。";
    }
    if (!pending.ready || Number(revision) !== pending.revision) return "此按钮尚未就绪或已失效，请使用最新的请求面板。";
    if (action === "cancel" && value === undefined) {
      this.finish(token!, safeInteractionDecision(pending.request));
      return "已取消本次交互；是否停止任务以 /status 为准。";
    }
    const request = pending.request;
    if (request.type === "approval" && value === undefined) {
      const choice: ApprovalChoice | undefined = action === "once" ? { type: "once" }
        : action === "session" ? { type: "session" } : action === "policy" ? { type: "execpolicy" }
        : /^network\d+$/u.test(action!) ? { type: "networkpolicy", amendmentIndex: Number(action!.slice(7)) } : undefined;
      const resolution = choice && resolveApprovalChoice(request, choice);
      if (!resolution) return "该授权范围不属于本次请求。";
      this.finish(token!, resolution.decision);
      return "已将审批选择交回原请求。";
    }
    if (request.type === "user-input") {
      const question = request.questions[pending.question]!;
      if (action === "next" || action === "prev") {
        if (value !== undefined) return "选项翻页格式无效。";
        const page = pending.page + (action === "next" ? 1 : -1);
        if (page < 0 || page * 10 >= question.options.length) return "没有此页选项。";
        pending.page = page;
        this.advance(token!, pending);
        return "正在显示新的选项页。";
      }
      const index = /^option\d+$/u.test(action!) ? Number(action!.slice(6)) : -1;
      const answer = action === "text" && (question.allowOther || question.options.length === 0)
        ? value?.trim() : value === undefined && index >= pending.page * 10 && index < (pending.page + 1) * 10
          ? question.options[index] : undefined;
      if (!answer) return "回答不能为空，请选择当前选项，或使用允许的输入回答入口。";
      pending.answers[question.id] = [answer];
      if (Buffer.byteLength(JSON.stringify(pending.answers)) > 32 * 1024) {
        this.finish(token!, safeInteractionDecision(request));
        return "回答超过本地容量，本次问题已取消。";
      }
      if (++pending.question === request.questions.length) {
        if (request.asynchronous && !this.check(() => this.options.prepareAsyncAnswer(target, request, message))) {
          this.finish(token!, safeInteractionDecision(request));
          return "当前回答无法取得提交资格，本次问题已取消，请核对 /status。";
        }
        this.finish(token!, { type: "user-input", answers: pending.answers });
        return "已将回答交回原请求；后续提交状态以任务回复为准。";
      }
      pending.page = 0;
      this.advance(token!, pending);
      return "已记录本题回答，正在显示下一题。";
    }
    if (request.type === "elicitation") {
      if (request.mode === "tool-approval" && value === undefined) {
        const scope = action === "once" ? "once" : action === "session" && request.toolApproval?.allowSession
          ? "session" : action === "always" && request.toolApproval?.allowAlways ? "always" : undefined;
        if (!scope) return "该授权范围不属于本次工具请求。";
        this.finish(token!, { type: "elicitation", action: "accept", content: null, scope });
      } else if (request.mode === "form" && action === "text" && value) {
        let content: unknown;
        try { content = JSON.parse(value); } catch { return "请保留回答前缀，输入有效 JSON 对象。"; }
        if (!content || typeof content !== "object" || Array.isArray(content)) return "回答必须是 JSON 对象。";
        this.finish(token!, { type: "elicitation", action: "accept", content });
      } else if (request.mode === "url" && action === "done" && value === undefined) {
        this.finish(token!, { type: "elicitation", action: "accept", content: null });
      } else return "请选择原请求支持的回应方式。";
      return "已将选择交回原请求。";
    }
    return "该回应不属于本次请求。";
  }

  resolved(requestId: string): void {
    const result = this.pending.resolved(requestId);
    if (result?.pending) this.finish(result.token, safeInteractionDecision(result.pending.request));
  }
  cancelTarget(target: ConversationTarget): void {
    for (const [token, pending] of this.pending.entries()) {
      if (pending.target.surface === target.surface && pending.target.accountId === target.accountId
        && pending.target.conversationId === target.conversationId) this.finish(token, safeInteractionDecision(pending.request));
    }
  }
  cancelAll(): void {
    for (const [token, pending] of this.pending.entries()) this.finish(token, safeInteractionDecision(pending.request));
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancelAll();
    await Promise.allSettled(this.preparations);
  }
  private advance(token: string, pending: Pending): void {
    pending.ready = false;
    pending.revision++;
    this.prepare(token, pending);
  }
  private prepare(token: string, pending: Pending): void {
    const task = Promise.resolve().then(async () => {
      if (!this.valid(pending)) throw new Error("QQ 交互失效");
      const panel = render(pending, token);
      await this.options.send(pending.target, panel.content, panel.controls, this.pending.signal(token),
        () => this.pending.get(token) === pending && this.valid(pending));
      if (this.pending.get(token) !== pending || !this.valid(pending)) throw new Error("QQ 交互失效");
      pending.ready = true;
      this.options.logger.info({ requestId: pending.requestId, requestType: pending.request.type }, "QQ 交互完整展示已确认，回应入口就绪");
    }).catch(() => {
      if (this.pending.get(token) !== pending) return;
      this.options.logger.warn({ requestId: pending.requestId, requestType: pending.request.type,
        reason: "interaction-presentation-unconfirmed" }, "QQ 交互展示未确认，已安全取消");
      this.finish(token, safeInteractionDecision(pending.request));
    }).finally(() => this.preparations.delete(task));
    this.preparations.add(task);
  }
  private finish(token: string, decision: InteractionDecision): void {
    const pending = this.pending.get(token);
    if (!pending) return;
    const valid = this.valid(pending);
    this.pending.take(token);
    pending.resolve(valid ? decision : safeInteractionDecision(pending.request));
  }
  private valid(pending: Pending): boolean {
    return !this.closed && performance.now() < pending.deadline && this.check(pending.current)
      && this.check(() => pending.request.isCurrent?.() !== false);
  }
  private check(current: () => boolean): boolean { try { return current() === true; } catch { return false; } }
}

function render(pending: Pending, token: string): { content: string; controls: { content: string; keyboard: QqCommandKeyboard; markdownContent?: string } } {
  const request = pending.request;
  const prefix = `/respond ${token} ${pending.revision} `;
  const buttons: ReturnType<typeof qqMenuButton>[] = [];
  const add = (action: string, label: string, enter = true) => buttons.push(qqMenuButton(action, label, prefix + action + (enter ? "" : " "), enter));
  let content: string;
  let markdownContent: string | undefined;
  let instruction = "请核对完整详情，再选择授权范围。";
  if (request.type === "approval") {
    content = `${request.title}\n\n${request.detail}`;
    add("once", "允许一次");
    if (request.allowSession) add("session", "本会话允许");
    if (request.execPolicyAmendment) add("policy", "保存命令规则");
    request.networkPolicyAmendments?.forEach((rule, index) => {
      content += `\n网络规则 ${index + 1}：${rule.action} ${rule.host}`;
      add(`network${index}`, `网络规则 ${index + 1}`);
    });
  } else if (request.type === "user-input") {
    const question = request.questions[pending.question]!;
    const number = `问题 ${pending.question + 1}/${request.questions.length}`;
    const heading = question.header.trim() && question.header.trim() !== number
      ? `${number} · ${question.header.trim()}` : number;
    content = `${request.title}\n\n${heading}\n\n${question.question}`;
    content += question.options.map((option, index) => `\n\n${index + 1}. ${option}`).join("");
    if (question.secret) content += "\n请勿在 QQ 聊天记录中发送密钥、Token 或其他敏感凭据。";
    markdownContent = `## ${request.title}\n\n### ${heading}\n\n${question.question}`
      + question.options.map((option, index) => `\n\n${index + 1}. ${option}`).join("")
      + (question.secret ? "\n\n请勿在 QQ 聊天记录中发送密钥、Token 或其他敏感凭据。" : "");
    instruction = question.options.length === 0
      ? "点击“输入回答”，在填入的前缀后追加回答并发送。"
      : question.allowOther ? "请选择选项，或点击“输入回答”，在填入的前缀后追加回答并发送。" : "请选择下方选项。";
    for (let index = pending.page * 10; index < Math.min(question.options.length, (pending.page + 1) * 10); index++) add(`option${index}`, `选项 ${index + 1}`);
    if (pending.page > 0) add("prev", "上一页");
    if ((pending.page + 1) * 10 < question.options.length) add("next", "下一页");
    if (question.allowOther || question.options.length === 0) add("text", "输入回答", false);
  } else {
    content = `${request.title}\n\n${request.message}`;
    if (request.mode === "tool-approval") {
      content += `\n工具：${request.toolApproval?.toolTitle ?? "未命名工具"}\n${request.toolApproval?.detail ?? ""}`;
      add("once", "允许一次");
      if (request.toolApproval?.allowSession) add("session", "本会话允许");
      if (request.toolApproval?.allowAlways) add("always", "始终允许");
    } else if (request.mode === "form") {
      add("text", "输入 JSON", false);
      instruction = "点击“输入 JSON”，在填入的前缀后追加 JSON 对象并发送。";
    } else { content += `\n${request.url ?? ""}`; add("done", "已完成"); instruction = "完成上方操作后，点击“已完成”。"; }
  }
  add("cancel", request.type === "approval" ? "拒绝" : request.type === "user-input" ? "取消回答" : "取消交互");
  if (buttons.length > 15) throw new Error("QQ 交互按钮容量不足");
  const rows: QqCommandKeyboard["content"]["rows"] = [];
  for (let index = 0; index < buttons.length; index += 3) rows.push({ buttons: buttons.slice(index, index + 3) });
  return { content: formatQqLiteralDetails(content), controls: {
    content: instruction,
    keyboard: { content: { rows } },
    ...(markdownContent === undefined ? {} : { markdownContent }),
  } };
}

/** Lossless visible escapes prevent platform tags and invisible characters hiding approval scope. */
export function formatQqLiteralDetails(value: string): string {
  const escaped = literal(value);
  return escaped === value ? value
    : `特殊字符使用转义表示：双反斜杠表示一个反斜杠，\\u{码点} 表示对应字符。\n\n${escaped}`;
}

function literal(value: string): string {
  return value.replace(/[\\<>&\p{Cf}\p{Cc}]/gu, character => character === "\n" ? character : character === "\\" ? "\\\\"
    : [...character].map(point => `\\u{${point.codePointAt(0)!.toString(16)}}`).join(""));
}
