import type { Logger } from "pino";
import type { InteractionRequest } from "../../approval/index.js";
import type { ConversationCommandExecutor, ConversationSessionUseCases, ConversationTurnUseCases } from "../../application/index.js";
import { UserFacingError, type ConversationTarget, type OutputEvent } from "../../conversation-core/index.js";
import type { ConversationActorRegistry, SurfaceAccessPolicy } from "../../policy/index.js";
import type { DeliveryCheckpoint } from "../delivery-receipt.js";
import type { SurfaceOutputPort } from "../types.js";
import { parseSlashCommand, isEmergencyStopCommand } from "../slash-command.js";
import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { formatConversationCommandOutcome } from "../conversation-command-outcome-format.js";
import { resolveSurfaceDelivery } from "../delivery-policy.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";
import { parseQqTextEvent } from "./inbound.js";
import { parseQqButtonEvent } from "./button-inbound.js";
import type { QqMessageInput } from "./message-input.js";
import { QqTaskSources, type QqTaskScope, type QqTaskSourceReference, type QqTaskTicket } from "./task-sources.js";
import { QqTextOutbox, planText } from "./outbox.js";
import { QqSendBudget } from "./send-budget.js";
import { QQ_TEXT_PART_BYTES, QqProtocolError, type QqProtocolClient, type QqTextMessage, type QqCommandKeyboard } from "./protocol.js";
import { renderQqTurnCompleted } from "./lifecycle.js";
import { QqBodyStreaming } from "./streaming.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import { QqCommandMenuController } from "./command-menu-controller.js";
import { qqBodyMarkdownPrefix } from "./body-markdown.js";
import { QqInteractions } from "./interactions.js";

export interface QqMessageOptions {
  appId: string;
  access: SurfaceAccessPolicy;
  service: Pick<ConversationTurnUseCases, "submit" | "touchActivity"> & Pick<ConversationSessionUseCases, "selectedWorkspaceId" | "listWorkspaces" | "status">;
  commands: ConversationCommandExecutor;
  actors: ConversationActorRegistry;
  ownsThread(target: ConversationTarget, threadId: string): boolean;
  logger: Logger;
  autoCompactPercent?: (provider: string | null | undefined, model: string | null | undefined) => number | null;
  startupNotification?: {
    recipients(): readonly string[];
    text(target: ConversationTarget, signal: AbortSignal): Promise<string>;
  };
}

const QUERY_COMMANDS = new Set(["usage", "limits", "metrics", "diff"]);

/** Owns one connection generation's input tasks and disposable source authority. */
export class QqMessages implements SurfaceOutputPort {
  readonly interactions: QqInteractions;
  private readonly lifetime = new AbortController();
  private readonly startedAt = Date.now();
  private lastWall = this.startedAt;
  private readonly dedup = new Map<string, number>();
  private readonly busy = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly sources: QqTaskSources;
  private readonly outbox: QqTextOutbox;
  private readonly streaming: QqBodyStreaming;
  private readonly budget = new QqSendBudget();
  private readonly menus: QqCommandMenuController;
  private readonly admitted = new WeakMap<OutputEvent, QqTaskSourceReference>();
  private readonly replied = new WeakSet<QqMessageInput>();
  private callbackTimes: number[] = [];
  private callbackStopTimes: number[] = [];
  private readonly pendingCallbacks = new Map<string, Set<AbortController>>();
  private readonly asyncAnswers = new Map<string, { target: ConversationTarget; ticket: QqTaskTicket; remove: () => void; failed: () => Promise<void> }>();

  constructor(private readonly options: QqMessageOptions, private readonly client: QqProtocolClient) {
    this.sources = new QqTaskSources({ accountId: options.appId, isCurrent: (scope, threadId) => this.current(scope, threadId) });
    this.menus = new QqCommandMenuController({
      commands: options.commands,
      scope: target => this.menuScope(target),
      workspaceScope: target => this.menuWorkspaceScope(target),
      selectionScope: target => this.options.service.status(target).selectionScope,
      allowed: (target, actorId) => this.allowed(target, actorId),
      beforeMutation: (target, preserveRevert) => { this.cancelCallbacks(target); if (!preserveRevert) this.menus.cancelRevert(target); this.sources.cancelTarget(target); this.interactions.cancelTarget(target); },
      signal: this.lifetime.signal,
    });
    this.outbox = new QqTextOutbox(client, options.logger);
    this.interactions = new QqInteractions({
      logger: options.logger,
      authorize: (target, request) => this.interactionAuthorization(target, request),
      prepareAsyncAnswer: (target, request, message) => this.prepareAsyncAnswer(target, request, message),
      send: (target, content, interactionControls, signal, current) => this.outbox.deliver({
        mode: "active", recipient: target.conversationId.slice(4), content,
      }, { signal: AbortSignal.any([signal, this.lifetime.signal]), interactionControls,
        beforeSend: () => { if (!current()) throw new Error("QQ 交互授权失效"); },
        reserve: parts => this.budget.reserve(target.conversationId.slice(4), parts, "interaction"),
      }, async () => {}),
    });
    this.streaming = new QqBodyStreaming(client, this.sources, this.budget,
      () => options.logger.warn({ reason: "body-stream-unconfirmed" }, "QQ 正文流未确认；最终正文仍由共享投递核对"),
      frames => options.logger.info({ frames }, "QQ 正文流结束帧与完整结果已确认"));
  }

  readonly deliverySource = {
    capture: (event: OutputEvent) => this.admitted.get(event),
    await: (reference: QqTaskSourceReference, signal: AbortSignal) => this.sources.awaitSource(reference, signal),
    current: (reference: QqTaskSourceReference) => this.sources.isCurrent(reference),
  };

  admitLive(event: OutputEvent): void {
    if (event.target.surface !== "qq" || event.target.accountId !== this.options.appId) return;
    if ((!this.supported(event) && event.type !== "turn.started") || !("threadId" in event) || !("turnId" in event)) return;
    const source = this.sources.capture(event.target, event.threadId, event.turnId);
    if (source) this.admitted.set(event, source);
  }
  observe(event: OutputEvent): void {
    const source = this.admitted.get(event);
    if (source && event.type === "turn.started") this.streaming.started(source);
    if (event.type === "text.delta" || event.type === "text.completed") this.streaming.observe(event, source);
    if (source && event.type === "turn.completed") this.sources.terminal(source);
  }
  retains(event: OutputEvent): boolean { return event.type !== "text.delta" && this.supported(event) && this.admitted.has(event); }
  async handle(event: OutputEvent, _context?: { liveAdmitted: true }, signal?: AbortSignal): Promise<void> {
    if (event.type === "text.delta") { if (this.admitted.has(event)) await this.streaming.update(event, signal); return; }
    if (this.supported(event)) throw new Error("QQ 任务结果必须通过共享持久投递");
  }
  async deliver(event: OutputEvent, signal: AbortSignal, checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized?: () => boolean): Promise<void> {
    if (!this.supported(event) || !authorized) throw new Error("QQ 输出未获授权");
    if (event.type !== "text.completed" && event.type !== "turn.completed") throw new Error("QQ 输出类型不受支持");
    let text = event.type === "text.completed" ? event.text : renderQqTurnCompleted(event, this.options.autoCompactPercent);
    let continuation = false;
    let checkpointFailed = false;
    const record = async (value: DeliveryCheckpoint) => {
      try { await checkpoint(value); }
      catch (error) { checkpointFailed = true; throw error; }
    };
    try {
      if (event.type === "text.completed") {
        const result = await this.streaming.finish(event, signal, record, authorized);
        if (result.kind === "complete") return;
        if (result.kind === "continue") { text = result.text; continuation = true; }
      }
      // Preselect the representation before sending. Continuations have no full
      // Markdown context and must stay text; never retry a failed Markdown as text.
      const markdown = event.type === "text.completed" && !continuation
        && Buffer.byteLength(text) <= QQ_TEXT_PART_BYTES && qqBodyMarkdownPrefix(text, true) === text;
      await this.outbox.deliver({ mode: "active", recipient: event.target.conversationId.slice(4), content: text }, {
        signal: AbortSignal.any([signal, this.lifetime.signal]),
        ...(markdown ? { representation: "markdown" as const } : {}),
        ...(event.type === "turn.completed" ? { preferMarkdown: true } : {}),
        allowResultFile: event.type === "text.completed" && !markdown,
        beforeSend: () => { if (authorized() !== true) throw new Error("QQ 输出授权失效"); },
        reserve: parts => this.budget.reserve(event.target.conversationId.slice(4), parts,
          { key: JSON.stringify([event.target.conversationId, event.threadId, event.turnId]), status: event.type === "turn.completed" }),
      }, record);
    } catch (error) {
      if (event.type === "text.completed" && !checkpointFailed && !signal.aborted && authorized()) {
        try {
          await this.outbox.deliver({ mode: "active", recipient: event.target.conversationId.slice(4),
            content: "正文未完整送达或发送结果未确认；这不等于任务执行失败。请在本机 WebUI 投递箱核对，完整内容可在原生 Codex 会话查看。人工重试可能重复已收到的内容。" }, {
            signal: AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(10_000)]),
            preferMarkdown: true,
            beforeSend: () => { if (authorized() !== true) throw new Error("QQ 输出授权失效"); },
            reserve: parts => this.budget.reserve(event.target.conversationId.slice(4), parts,
              { key: JSON.stringify([event.target.conversationId, event.threadId, event.turnId]), status: true }),
          }, async () => {});
        } catch { this.options.logger.warn({ reason: "body-failure-notice-unconfirmed" }, "QQ 正文失败提示未确认"); }
      }
      throw error;
    }
  }

  startNotifications(): void {
    if (!this.options.startupNotification || this.lifetime.signal.aborted) return;
    const task = this.sendStartupNotifications().catch(() => {
      if (!this.lifetime.signal.aborted) this.options.logger.warn({ reason: "startup-notification-failed" }, "QQ 上线通知未确认，不自动重试");
    }).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private async sendStartupNotifications(): Promise<void> {
    const notification = this.options.startupNotification;
    if (!notification) return;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]);
    for (const actorId of new Set(notification.recipients())) {
      signal.throwIfAborted();
      const scope = this.scope(actorId);
      if (!scope || !this.current(scope)) continue;
      try {
        const content = await notification.text(this.target(actorId), signal);
        signal.throwIfAborted();
        await this.outbox.deliver({ mode: "active", recipient: actorId, content }, {
          signal,
          preferMarkdown: true,
          beforeSend: () => { if (!this.current(scope)) throw new Error("QQ 上线通知授权失效"); },
          reserve: parts => this.budget.reserve(actorId, parts, "startup"),
        }, async () => {});
      } catch {
        if (signal.aborted) throw signal.reason;
        this.options.logger.warn({ reason: "startup-notification-unconfirmed" }, "QQ 上线通知未确认，不影响文字接入，不自动重试");
      }
    }
  }

  /** Synchronous bounded admission: Transport must remain free to receive /stop. */
  receive(envelope: unknown): void {
    if (this.lifetime.signal.aborted) return;
    const button = parseQqButtonEvent(envelope, this.options.appId);
    if (button.kind === "supported") { this.admit({ ...button.interaction, kind: "interaction" }); return; }
    if (button.kind === "rejected") {
      this.options.logger.warn({ reason: button.reason }, "QQ 按钮回调未接纳"); return;
    }
    const parsed = parseQqTextEvent(envelope);
    if (parsed.kind !== "supported") {
      if (parsed.kind === "rejected") this.options.logger.warn({ reason: parsed.reason, field: parsed.field }, "QQ 非普通文字事件未处理");
      return;
    }
    this.admit(parsed.message);
  }

  private admit(message: QqMessageInput): void {
    const target = this.target(message.actorId);
    if (!this.options.access.isAllowed({ target, actorId: message.actorId })) return;
    const now = Date.now();
    if (now < this.lastWall) { this.lastWall = Infinity; return; }
    this.lastWall = now;
    if (message.sentAtMs < this.startedAt || message.sentAtMs > now || now - message.sentAtMs > 60_000) return;
    for (const [key, until] of this.dedup) if (until <= performance.now()) this.dedup.delete(key);
    const callback = "kind" in message;
    const key = JSON.stringify([callback ? "interaction" : "text", message.actorId, message.id,
      callback ? undefined : message.msgIdx]);
    if (this.dedup.has(key)) return;
    if (this.dedup.size >= 4096 || this.tasks.size >= (isEmergencyStopCommand(message.content) ? 40 : 32)) {
      this.options.logger.warn({ reason: "input-capacity" }, "QQ 输入容量已满，未提交或排队"); return;
    }
    if (callback) {
      const monotonic = performance.now();
      this.callbackTimes = this.callbackTimes.filter(value => value > monotonic - 1000);
      this.callbackStopTimes = this.callbackStopTimes.filter(value => value > monotonic - 1000);
      const emergency = isEmergencyStopCommand(message.content);
      const times = emergency ? this.callbackStopTimes : this.callbackTimes;
      if (times.length >= (emergency ? 8 : 24)) {
        this.options.logger.warn({ reason: "callback-capacity" }, "QQ 按钮回调过于频繁，未执行"); return;
      }
      times.push(monotonic);
    }
    this.dedup.set(key, performance.now() + 600_000);
    this.options.actors.rememberActor(target, message.actorId);
    const task = (callback ? this.processCallback(message, target) : this.process(message, target)).catch((error: unknown) => {
      this.options.logger.warn({ reason: callback ? "callback-or-reply-failed" : "input-or-reply-failed",
        ...(error instanceof QqProtocolError ? { operation: error.operation, protocolReason: error.reason, httpStatus: error.httpStatus } : {}),
      }, "QQ 输入处理或回复未确认；不自动重试");
    }).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private async processCallback(message: QqMessageInput, target: ConversationTarget): Promise<void> {
    const stop = isEmergencyStopCommand(message.content);
    const response = /^\s*\/respond(?:\s|$)/iu.test(message.content);
    if (stop) this.cancelCallbacks(target);
    const blocked = !stop && !response && this.busy.has(target.conversationId);
    const ownsBusy = !stop && !response && !blocked;
    const controller = new AbortController();
    const waiting = this.pendingCallbacks.get(target.conversationId) ?? new Set<AbortController>();
    waiting.add(controller);
    this.pendingCallbacks.set(target.conversationId, waiting);
    if (ownsBusy) this.busy.add(target.conversationId);
    try {
      const scope = this.menuScope(target);
      const allowed = () => !controller.signal.aborted && this.allowed(target, message.actorId) && this.menuScope(target) === scope;
      // ACK means receipt, not business success. Do not execute when receipt is
      // unknown; never retry an interaction ID or invent a passive message ID.
      await this.client.acknowledgeInteraction(message.id, blocked ? 2 : 0, {
        signal: AbortSignal.any([controller.signal, this.lifetime.signal, AbortSignal.timeout(3000)]),
        beforeSend: () => { if (!allowed()) throw new Error("QQ 按钮回调授权失效"); },
      });
      if (!allowed() || blocked) return;
      waiting.delete(controller);
      await this.process(message, target, ownsBusy);
    } finally {
      waiting.delete(controller);
      if (waiting.size === 0 && this.pendingCallbacks.get(target.conversationId) === waiting) this.pendingCallbacks.delete(target.conversationId);
      if (ownsBusy) this.busy.delete(target.conversationId);
    }
  }

  private cancelCallbacks(target: ConversationTarget): void {
    for (const controller of this.pendingCallbacks.get(target.conversationId) ?? []) controller.abort();
  }

  private async process(message: QqMessageInput, target: ConversationTarget, ownsBusy = false): Promise<void> {
    // Response tokens remain usable while ordinary submit is preparing. They
    // never enter task submission, including unknown tokens after restart.
    const response = this.interactions.respond(target, message);
    if (response !== undefined) {
      await this.reply(message, response, () => this.allowed(target, message.actorId));
      return;
    }
    let command: ReturnType<typeof parseSlashCommand>;
    try { command = parseSlashCommand(message.content); }
    catch { await this.reply(message, "命令格式不受支持。使用 /help 查看 QQ 命令。", () => this.allowed(target, message.actorId)); return; }
    const stop = command?.name === "stop" && !command.argumentsText;
    if (stop) { this.cancelCallbacks(target); this.menus.cancelRevert(target); this.sources.cancelTarget(target); this.interactions.cancelTarget(target); }
    if (this.busy.has(target.conversationId) && !stop && !ownsBusy) {
      await this.reply(message, "上一条输入仍在处理中，请稍后重试；/stop 可取消当前准备和任务。", () => this.allowed(target, message.actorId)); return;
    }
    if (!stop && !ownsBusy) this.busy.add(target.conversationId);
    let stage: "command" | "render" | "reply" | "submit" = "command";
    try {
      if (command) {
        if (!["help", "status", "stop", "workspace", "model", "new", "sessions", "resume", "rename", "archived", "archive", "unarchive", "pin", "unpin", "compact", "fork", "revert", ...QUERY_COMMANDS].includes(command.name)
          || (["status", "stop", "new", "usage", "limits", "diff", "archive", "pin", "unpin", "compact", "fork"].includes(command.name) && command.argumentsText.trim())) {
          await this.reply(message, "QQ 暂不支持此命令或参数。使用 /help 查看支持范围。", () => this.allowed(target, message.actorId)); return;
        }
        if (command.name === "help" || command.name === "revert") {
          const menu = await (command.name === "help" ? this.menus.open(target, message.actorId, command.argumentsText)
            : this.menus.revert(target, message.actorId, command.argumentsText));
          stage = "reply";
          await this.reply(message, menu.content, () => this.allowed(target, message.actorId) && menu.isCurrent(), undefined, menu.keyboard, menu.detail);
          menu.delivered?.();
          return;
        }
        if (((command.name === "workspace" || command.name === "model" || command.name === "resume" || command.name === "unarchive") && command.argumentsText.trim()) || command.name === "new" || command.name === "archive" || command.name === "fork") {
          this.cancelCallbacks(target); this.menus.cancelRevert(target); this.sources.cancelTarget(target); this.interactions.cancelTarget(target);
        }
        const commandScope = this.scope(message.actorId);
        const hasSelectionMenu = ["workspace", "model", "sessions", "resume", "archived"].includes(command.name);
        const menuScope = hasSelectionMenu ? this.menuScope(target) : undefined;
        const menuWorkspaceScope = hasSelectionMenu ? this.menuWorkspaceScope(target) : undefined;
        const queryStatus = QUERY_COMMANDS.has(command.name) ? this.options.service.status(target) : undefined;
        const result = await this.options.commands.execute(target, command.name as "status" | "stop" | "workspace" | "model" | "new" | "sessions" | "resume" | "rename" | "archived" | "archive" | "unarchive" | "pin" | "unpin" | "compact" | "fork" | "usage" | "limits" | "metrics" | "diff", command.argumentsText, message.actorId);
        const sessionReplyScope = ["rename", "archive", "unarchive", "pin", "unpin", "compact", "fork"].includes(command.name)
          ? this.menuScope(target) : undefined;
        stage = "render";
        const scope = command.name === "workspace" && command.argumentsText.trim() ? this.scope(message.actorId) : commandScope;
        const menu = this.menus.fromResult(target, message.actorId, result);
        if (menu) {
          stage = "reply";
          await this.reply(message, menu.content, () => {
            const sameContext = result.kind === "models" && command.argumentsText.trim()
              ? this.menuWorkspaceScope(target) === menuWorkspaceScope && !!result.state.selectionScope
                && result.state.selectionScope === this.options.service.status(target).selectionScope
              : this.menuScope(target) === menuScope;
            return sameContext && menu.isCurrent() && this.allowed(target, message.actorId);
          }, undefined, menu.keyboard);
          return;
        }
        const text = result.kind === "outcome" && result.outcome.type === "thread.compaction-requested"
          ? "已请求压缩当前会话。QQ 暂不单独推送压缩进度；此回执不表示压缩已完成。"
          : result.kind === "outcome" ? formatConversationCommandOutcome(result.outcome)
          : renderConversationCommandResult(result);
        if (!text) throw new Error("QQ 命令没有可交付结果");
        stage = "reply";
        await this.reply(message, text, () => {
          if (!scope || !this.current(scope)) return false;
          if (sessionReplyScope !== undefined && this.menuScope(target) !== sessionReplyScope) return false;
          if (result.kind === "outcome" && result.outcome.type === "thread.forked"
            && this.options.service.status(target).threadId !== result.outcome.threadId) return false;
          if (!queryStatus) return true;
          const current = this.options.service.status(target);
          if (current.threadId !== queryStatus.threadId) return false;
          return command.name !== "usage" && command.name !== "limits"
            || (current.modelProvider === queryStatus.modelProvider && !current.sessionRestoring);
        }, QUERY_COMMANDS.has(command.name)
          ? command.name === "diff" ? "Diff 无法在本次 QQ 回复中完整展示，本次仅发送此提示。请在原生 Codex 会话查看。"
            : "查询结果无法在本次 QQ 回复中完整展示，本次仅发送此提示。统计可缩小 /metrics 查询范围，或在本机 WebUI 查看；账户信息也可从其他已接入渠道查询。"
          : undefined);
        return;
      }
      if ("kind" in message) {
        await this.reply(message, "此按钮操作不受支持，请重新打开 /help。", () => this.allowed(target, message.actorId));
        return;
      }
      const scope = this.scope(message.actorId);
      if (!scope) { await this.reply(message, "请先用 /workspace 选择已配置的工作区。", () => this.allowed(target, message.actorId)); return; }
      const reservation = this.sources.reserve(scope, message);
      if (reservation.kind !== "accepted") { await this.reply(message, "当前输入无法接纳，请稍后核对任务状态再重试。", () => this.current(scope)); return; }
      const { ticket } = reservation;
      stage = "submit";
      try {
        this.options.service.touchActivity?.(target);
        await this.options.service.submit(target, message.content, () => ticket.isCurrent(), ticket.observer);
      } catch (error) {
        ticket.cancel();
        const { errorType, errorCode, errorReason } = surfaceErrorMetadata(error);
        this.options.logger.warn({ reason: error instanceof UserFacingError ? error.code : "submission-unconfirmed",
          errorType, errorCode, errorReason }, "QQ 任务提交未确认");
        await this.reply(message, error instanceof UserFacingError ? formatSurfaceUserFacingError(error, "QQ")
          : "任务提交未确认；请用 /status 或在本机核对，勿直接重复提交。", () => this.current(scope));
      }
    } catch (error) {
      const { errorType, errorCode, errorReason } = surfaceErrorMetadata(error);
      this.options.logger.warn({ reason: error instanceof UserFacingError ? error.code : "operation-unconfirmed",
        stage, emergencyStop: stop, errorType, errorCode, errorReason }, "QQ 操作未确认");
      await this.reply(message, error instanceof UserFacingError ? formatSurfaceUserFacingError(error, "QQ")
        : "操作未确认。请检查 /status、工作区和模型选择；本机日志可核对受控错误。", () => this.allowed(target, message.actorId));
    } finally { if (!stop && !ownsBusy) this.busy.delete(target.conversationId); }
  }

  private async reply(message: QqMessageInput, content: string, allowed: () => boolean,
    oversizedNotice?: string, keyboard?: QqCommandKeyboard, detail?: string): Promise<void> {
    // A send failure must not recursively send another reply with the same msg_seq.
    if (this.replied.has(message)) throw new Error("QQ 来信回复已尝试，不重复发送");
    const input: QqTextMessage = "kind" in message || detail !== undefined
      ? { mode: "active", recipient: message.actorId, content: detail ?? content }
      : { mode: "passive", recipient: message.actorId, content,
        messageId: message.id, sequence: 1, sourceTimestampMs: message.sentAtMs };
    if (oversizedNotice) {
      try { planText(input); }
      catch (error) {
        if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input") throw error;
        input.content = oversizedNotice;
      }
    }
    this.replied.add(message);
    await this.outbox.deliver(input, {
      ...(detail !== undefined && keyboard ? { interactionControls: { content, keyboard } }
        : keyboard ? { representation: "markdown", keyboard } : { preferMarkdown: true }),
      signal: this.lifetime.signal,
      beforeSend: () => { if (!allowed()) throw new Error("QQ 回复授权失效"); },
      reserve: parts => this.budget.reserve(message.actorId, parts, "kind" in message || detail !== undefined ? "interaction" : undefined),
    }, async () => {});
  }
  private target(actorId: string): ConversationTarget { return { surface: "qq", accountId: this.options.appId, conversationId: `c2c:${actorId}` }; }
  private interactionAuthorization(target: ConversationTarget, request: InteractionRequest): (() => boolean) | undefined {
    if (target.surface !== "qq" || target.accountId !== this.options.appId || !target.conversationId.startsWith("c2c:")) return;
    const actorId = target.conversationId.slice(4);
    if (request.type === "user-input" && request.expectedActorId !== undefined && request.expectedActorId !== actorId) return;
    const scope = this.scope(actorId);
    if (!scope || typeof request.isCurrent !== "function") return;
    // Shared routing proves ancestry. An unbound child Thread is not itself
    // owned by the conversation, but its still-bound ancestor must be.
    const threads = request.relatedThreadIds ?? [request.threadId];
    return () => this.current(scope) && request.isCurrent!() === true
      && threads.some(threadId => this.options.ownsThread(target, threadId));
  }
  private prepareAsyncAnswer(target: ConversationTarget, request: Extract<InteractionRequest, { type: "user-input" }>, message: QqMessageInput): boolean {
    const authorized = this.interactionAuthorization(target, request);
    if (!authorized?.() || this.asyncAnswers.has(request.requestId) || this.asyncAnswers.size >= 128) return false;
    const scope = this.scope(message.actorId);
    if (!scope) return false;
    const reservation = this.sources.reserve(scope, message);
    if (reservation.kind !== "accepted") return false;
    const { ticket } = reservation;
    const remove = () => {
      if (this.asyncAnswers.get(request.requestId)?.ticket === ticket) this.asyncAnswers.delete(request.requestId);
    };
    const failed = async () => {
      await this.outbox.deliver({ mode: "active", recipient: message.actorId,
        content: "问题回答提交未确认；请用 /status 或在本机核对，勿直接重复提交。" }, {
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]),
        beforeSend: () => { if (!authorized()) throw new Error("QQ 问题回复授权失效"); },
        reserve: parts => this.budget.reserve(message.actorId, parts, "interaction"),
      }, async () => {});
    };
    this.asyncAnswers.set(request.requestId, { target, ticket, remove, failed });
    ticket.signal.addEventListener("abort", remove, { once: true });
    return true;
  }
  takeAsyncAnswerSubmission(target: ConversationTarget, requestId: string): (QqTaskTicket & { failed(): Promise<void> }) | undefined {
    const entry = this.asyncAnswers.get(requestId);
    if (!entry || entry.target.surface !== target.surface || entry.target.accountId !== target.accountId
      || entry.target.conversationId !== target.conversationId) return;
    this.asyncAnswers.delete(requestId);
    entry.ticket.signal.removeEventListener("abort", entry.remove);
    if (!entry.ticket.isCurrent()) { entry.ticket.cancel(); return; }
    return { ...entry.ticket, failed: entry.failed };
  }
  private allowed(target: ConversationTarget, actorId: string): boolean {
    return !this.lifetime.signal.aborted && this.options.access.isAllowed({ target, actorId });
  }
  private menuScope(target: ConversationTarget): string {
    const workspaceId = this.options.service.selectedWorkspaceId(target);
    const exists = this.options.service.listWorkspaces().some(value => value.id === workspaceId);
    // The workspace picker must remain reachable when the previous workspace was removed.
    return JSON.stringify([this.menuWorkspaceScope(target), exists
      ? this.options.service.status(target).threadId : "workspace-missing"]);
  }
  private menuWorkspaceScope(target: ConversationTarget): string {
    const workspaceId = this.options.service.selectedWorkspaceId(target);
    const workspace = this.options.service.listWorkspaces().find(value => value.id === workspaceId);
    return JSON.stringify([workspaceId, workspace?.cwd]);
  }
  private scope(actorId: string): QqTaskScope | undefined {
    const target = this.target(actorId);
    const workspaceId = this.options.service.selectedWorkspaceId(target);
    const workspace = this.options.service.listWorkspaces().find(value => value.id === workspaceId);
    return workspace ? { accountId: this.options.appId, actorId, conversationId: target.conversationId, workspaceId, workspaceCwd: workspace.cwd } : undefined;
  }
  private current(scope: QqTaskScope, threadId?: string): boolean {
    const current = this.scope(scope.actorId);
    return this.allowed(this.target(scope.actorId), scope.actorId) && !!current
      && current.workspaceId === scope.workspaceId && current.workspaceCwd === scope.workspaceCwd
      && (!threadId || this.options.ownsThread(this.target(scope.actorId), threadId));
  }
  private supported(event: OutputEvent): boolean {
    return event.target.surface === "qq" && event.target.accountId === this.options.appId
      && event.target.conversationId.startsWith("c2c:") && resolveSurfaceDelivery("qq", event).disposition === "deliver";
  }
  async close(): Promise<void> {
    this.lifetime.abort(); this.sources.close(); this.menus.clear();
    await Promise.all([this.interactions.close(), this.streaming.close(), this.outbox.close()]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled(this.tasks), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("QQ 输入关闭未确认")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
