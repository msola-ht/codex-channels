import { randomBytes } from "node:crypto";
import { resolveApprovalChoice, safeInteractionDecision, type ApprovalChoice, type InteractionDecision, type InteractionPort, type InteractionRequest } from "../../approval/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
import { PendingInteractionRegistry } from "../pending-interaction-registry.js";
import type { QqRenderedMessage } from "./rendering.js";

interface Pending {
  requestId: string;
  request: InteractionRequest;
  target: ConversationTarget;
  actor: string;
  deadline: number;
  ready: boolean;
  grantCurrent: () => boolean;
  answers: Map<string, string[]>;
  resolve(decision: InteractionDecision): void;
  timer: NodeJS.Timeout;
}

export interface QqInteractionDelivery {
  allowed(target: ConversationTarget, actor: string): boolean;
  rejected?(reason: string): void;
  /** Resolve only after the entire prompt is confirmed; return the original grant's validity guard. */
  send(target: ConversationTarget, request: InteractionRequest, result: QqRenderedMessage,
    signal: AbortSignal, authorized: () => boolean): Promise<{ current: () => boolean; remainingMs: number }>;
}

export class QqInteractionDeliveryError extends Error {
  constructor(readonly reason: "missing-turn-grant" | "turn-association-unconfirmed" | "grant-expired") {
    super("QQ 交互缺少有效的原轮次回复依据");
  }
}

/** Reuse shared decisions and cancellation registry; QQ owns only its presentation and response transport. */
export class QqInteractionPort implements InteractionPort {
  private readonly pending = new PendingInteractionRegistry<Pending>(32);
  private readonly preparations = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly delivery: QqInteractionDelivery) {}

  request(target: ConversationTarget, request: InteractionRequest): Promise<InteractionDecision> {
    const actor = target.conversationId.startsWith("c2c:") ? target.conversationId.slice(4) : "";
    const rejection = this.closed ? "port-closed"
      : target.surface !== "qq" || !actor || !this.delivery.allowed(target, actor) ? "unauthorized-target"
      : !supports(request) ? "unsupported-interaction"
      : request.isCurrent?.() !== true ? "stale-request"
      : !Number.isFinite(request.expiresInMs) || request.expiresInMs <= 0 || request.expiresInMs > 2_147_483_647 ? "invalid-lifetime"
      : request.type === "user-input" && request.expectedActorId !== undefined && request.expectedActorId !== actor ? "actor-mismatch" : undefined;
    if (rejection) {
      this.delivery.rejected?.(rejection);
      return Promise.resolve(safeInteractionDecision(request));
    }
    const token = randomBytes(12).toString("base64url");
    if (!this.pending.reserve(request.requestId, token)) {
      this.delivery.rejected?.("duplicate-or-capacity-exceeded");
      return Promise.resolve(safeInteractionDecision(request));
    }
    let result: QqRenderedMessage;
    try { result = prompt(request, token); }
    catch {
      this.pending.release(request.requestId, token);
      this.delivery.rejected?.("unrepresentable-prompt");
      return Promise.resolve(safeInteractionDecision(request));
    }
    const signal = this.pending.signal(token);
    const deadline = performance.now() + request.expiresInMs;
    const decision = new Promise<InteractionDecision>(resolve => {
      const timer = setTimeout(() => this.finish(token, safeInteractionDecision(request), "deadline-exceeded"), request.expiresInMs);
      timer.unref();
      this.pending.activate(token, { requestId: request.requestId, request, target, actor, deadline,
        ready: false, grantCurrent: () => false, answers: new Map(), resolve, timer });
    });
    const authorized = (): boolean => {
      const entry = this.pending.get(token);
      return !!entry && this.current(entry, false);
    };
    const preparation = Promise.resolve().then(async () => {
      try {
        const grant = await this.delivery.send(target, request, result, signal, authorized);
        const entry = this.pending.get(token);
        if (!entry) return;
        entry.grantCurrent = grant.current;
        if (!this.current(entry, false) || !grant.current() || grant.remainingMs <= 0) this.finish(token, safeInteractionDecision(request), "stale-after-delivery");
        else {
          entry.deadline = Math.min(entry.deadline, performance.now() + grant.remainingMs);
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => this.finish(token, safeInteractionDecision(request), "deadline-exceeded"), Math.max(0, entry.deadline - performance.now()));
          entry.timer.unref();
          entry.ready = true;
        }
      } catch (error) {
        this.finish(token, safeInteractionDecision(request), error instanceof QqInteractionDeliveryError ? error.reason : "prompt-delivery-unconfirmed");
      }
    }).finally(() => this.preparations.delete(preparation));
    this.preparations.add(preparation);
    return decision;
  }

  /** Reserved response verbs never fall through to ordinary model input, even for obsolete tokens. */
  handleText(target: ConversationTarget, actor: string, text: string): string | null {
    const normalized = text.trim();
    if (!/^\/(?:批准一次|批准会话|保存命令规则|保存网络规则|拒绝|取消|选择|填写)(?:\s|$)/u.test(normalized)) return null;
    const match = /^\/(批准一次|批准会话|保存命令规则|保存网络规则|拒绝|取消|选择|填写)\s+([A-Za-z0-9_-]{16})(?:\s+([\s\S]+))?$/u.exec(normalized);
    if (!match) return "交互回应格式无效，请使用当前提示中的完整操作。";
    const [, action, token, input] = match;
    const entry = this.pending.get(token!);
    if (!entry || entry.actor !== actor || !sameTarget(target, entry.target)) return "交互请求不存在、已过期或与当前用户不匹配。";
    if (!this.current(entry, false) || (entry.ready && !entry.grantCurrent())) {
      this.finish(token!, safeInteractionDecision(entry.request));
      return "交互请求已失效，请在原生客户端核对。";
    }
    if (!entry.ready) return "交互内容尚未完整确认送达，请稍后重试当前操作。";
    if (action === "取消" && input === undefined) {
      this.finish(token!, safeInteractionDecision(entry.request));
      return "已接收取消选择。";
    }
    if (entry.request.type === "approval") {
      const offered = approvalActions(entry.request).find(candidate => candidate.verb === action && candidate.argument === input);
      const choice = offered && resolveApprovalChoice(entry.request, offered.choice);
      if (!choice) return "当前请求不支持该选择。";
      this.finish(token!, choice.decision);
      return "已接收审批选择；实际执行结果以随后会话回复为准。";
    }
    if (entry.request.type !== "user-input" || !input || (action !== "选择" && action !== "填写")) return "请使用当前问题提供的选项或填写操作。";
    const answer = /^([1-9]\d*)\s+([\s\S]+)$/u.exec(input);
    const question = answer && entry.request.questions[Number(answer[1]) - 1];
    if (!answer || !question || entry.answers.has(question.id)) return "问题序号无效或该问题已经回答。";
    const value = action === "选择" && /^[1-9]\d*$/u.test(answer[2]!)
      ? question.options[Number(answer[2]) - 1]
      : action === "填写" && (question.allowOther || question.options.length === 0) ? answer[2]!.trim() : undefined;
    if (!value || (action === "填写" && Buffer.byteLength(value, "utf8") > 4_000)) return "回答无效或过长，请使用当前问题提供的操作。";
    entry.answers.set(question.id, [value]);
    if (entry.answers.size === entry.request.questions.length) {
      this.finish(token!, { type: "user-input", answers: Object.fromEntries(entry.answers) });
      return "已接收全部回答。";
    }
    return "已接收该项回答，请继续回答原消息中的其他问题。";
  }

  resolved(requestId: string): void {
    const entry = this.pending.resolved(requestId);
    if (entry?.pending) this.finish(entry.token, safeInteractionDecision(entry.pending.request));
  }
  cancelAll(): void {
    this.pending.cancelPreparing();
    for (const [token, entry] of this.pending.entries()) this.finish(token, safeInteractionDecision(entry.request));
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cancelAll();
    await Promise.allSettled([...this.preparations]);
  }
  private current(entry: Pending, requireReady = true): boolean {
    return !this.closed && performance.now() < entry.deadline && entry.request.isCurrent?.() === true
      && this.delivery.allowed(entry.target, entry.actor) && (!requireReady || entry.ready && entry.grantCurrent());
  }
  private finish(token: string, decision: InteractionDecision, reason?: string): void {
    const entry = this.pending.take(token);
    if (entry) {
      entry.resolve(decision);
      if (reason) this.delivery.rejected?.(reason);
    }
  }
}

function supports(request: InteractionRequest): boolean {
  if (request.type === "approval") return ["command", "file", "permissions", "stdin"].includes(request.kind);
  return request.type === "user-input" && !request.asynchronous && request.questions.length > 0 && request.questions.length <= 3
    && new Set(request.questions.map(question => question.id)).size === request.questions.length
    && request.questions.every(question => !question.secret && question.id.length > 0 && question.options.length <= 8
      && question.options.every(option => option.length > 0));
}

/** Display and acceptance use the same offered choices; never infer a broader scope from response text. */
function approvalActions(request: Extract<InteractionRequest, { type: "approval" }>): Array<{
  verb: string; argument?: string; choice: ApprovalChoice; description: string;
}> {
  const actions: ReturnType<typeof approvalActions> = [{ verb: "批准一次", choice: { type: "once" },
    description: request.kind === "permissions" ? "仅授予上文列出的本次 Turn 临时权限。"
      : request.kind === "stdin" ? "仅批准本次终端输入，不保存授权规则。" : "仅批准当前请求一次。" }];
  if ((request.kind === "command" || request.kind === "file") && request.allowSession) {
    actions.push({ verb: "批准会话", choice: { type: "session" }, description: request.networkApprovalContext
      ? `本会话允许上文的网络目标（JSON）：${approvalHost(request.networkApprovalContext.host)}` : "在当前 App Server 会话范围内批准。" });
  }
  if (request.kind === "command" && request.execPolicyAmendment) {
    actions.push({ verb: "保存命令规则", choice: { type: "execpolicy" }, description: "持久保存上文的完整命令前缀规则，由 App Server 执行。" });
  }
  if (request.kind === "command") {
    for (const [index, amendment] of (request.networkPolicyAmendments ?? []).entries()) {
      actions.push({ verb: "保存网络规则", argument: String(index + 1), choice: { type: "networkpolicy", amendmentIndex: index },
        description: `持久${amendment.action === "allow" ? "允许" : "拒绝"}主机（JSON）${approvalHost(amendment.host)}；只提交此条规则，由 App Server 执行。` });
    }
  }
  actions.push({ verb: "拒绝", choice: { type: "reject" }, description: request.kind === "stdin" ? "中止本次终端输入。" : "拒绝当前请求。" });
  return actions;
}

function approvalHost(host: string): string {
  // Keep scope labels readable without letting upstream control characters alter them.
  return JSON.stringify(host).replace(/[\p{Cf}\u2028\u2029]/gu,
    character => character.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

function sameTarget(left: ConversationTarget, right: ConversationTarget): boolean {
  return left.surface === right.surface && left.accountId === right.accountId && left.conversationId === right.conversationId;
}

function prompt(request: InteractionRequest, token: string): QqRenderedMessage {
  const body: string[] = [];
  const actions: string[] = [];
  const markup: string[] = [];
  const action = (command: string, input = false): void => {
    const encoded = encodeURIComponent(command);
    if (encoded.length > 100) throw new Error("QQ 交互操作过长");
    actions.push(command);
    markup.push(input
      ? `<qqbot-cmd-input text="${encoded}" show="${encodeURIComponent("填写答案")}" reference="false" />`
      : `<qqbot-cmd-enter text="${encoded}" />`);
  };
  body.push(`${request.title}\n有效期至多 ${Math.ceil(request.expiresInMs / 1000)} 秒；仅当前用户可回应。`);
  if (request.type === "approval") {
    body.push(request.detail, "授权选项（仅当前请求提供的范围）：");
    for (const offered of approvalActions(request)) {
      body.push(`${offered.verb}${offered.argument ? ` ${offered.argument}` : ""}：${offered.description}`);
      action(`/${offered.verb} ${token}${offered.argument ? ` ${offered.argument}` : ""}`);
    }
  } else if (request.type === "user-input") {
    request.questions.forEach((question, index) => {
      body.push(`问题 ${index + 1}：${question.header}\n${question.question}`);
      question.options.forEach((option, optionIndex) => {
        body.push(`${optionIndex + 1}. ${option}`);
        action(`/选择 ${token} ${index + 1} ${optionIndex + 1}`);
      });
      if (question.allowOther || question.options.length === 0) action(`/填写 ${token} ${index + 1} `, true);
    });
  }
  action(`/取消 ${token}`);
  body.push("操作区按问题与选项序号对应上文；填写时在问题序号后输入答案。点击不可用时可复制完整操作回应。");
  const blocks: QqRenderedMessage["blocks"] = [{ text: body.join("\n") }, { text: actions.join("\n"), markdown: markup.join("\n") }];
  const text = blocks.map(block => block.text).join("\n");
  if (Buffer.byteLength(text, "utf8") > 12_000) throw new Error("QQ 交互详情无法完整展示");
  return { text, blocks };
}
