import type { Logger } from "pino";
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
import { parseQqTextEvent, type QqInboundTextMessage } from "./inbound.js";
import { QqTaskSources, type QqTaskScope, type QqTaskSourceReference } from "./task-sources.js";
import { QqTextOutbox } from "./outbox.js";
import { QqSendBudget } from "./send-budget.js";
import type { QqProtocolClient } from "./protocol.js";
import { renderQqTurnCompleted } from "./lifecycle.js";
import { QqBodyStreaming } from "./streaming.js";
import { surfaceErrorMetadata } from "../error-metadata.js";

export interface QqMessageOptions {
  appId: string;
  access: SurfaceAccessPolicy;
  service: Pick<ConversationTurnUseCases, "submit" | "touchActivity"> & Pick<ConversationSessionUseCases, "selectedWorkspaceId" | "listWorkspaces">;
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

const HELP = "QQ 文字任务\n直接发送文字提交到当前工作区。\n/help · /status · /stop\n/workspace [序号、ID 或名称]\n/model [共享模型选择参数]\n/new\n/sessions [页码] [search 关键词]\n/resume [序号、名称或 Session ID]（/r）\n恢复会话不补发旧任务结果；发送新消息后建立新的回传关联。\n暂不支持附件、审批、问题交互或计划任务。结果投递失败请在本机投递箱核对。";

/** Owns one connection generation's input tasks and disposable source authority. */
export class QqMessages implements SurfaceOutputPort {
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
  private readonly admitted = new WeakMap<OutputEvent, QqTaskSourceReference>();
  private readonly replied = new WeakSet<QqInboundTextMessage>();

  constructor(private readonly options: QqMessageOptions, client: QqProtocolClient) {
    this.sources = new QqTaskSources({ accountId: options.appId, isCurrent: (scope, threadId) => this.current(scope, threadId) });
    this.outbox = new QqTextOutbox(client, options.logger);
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
    let checkpointFailed = false;
    const record = async (value: DeliveryCheckpoint) => {
      try { await checkpoint(value); }
      catch (error) { checkpointFailed = true; throw error; }
    };
    try {
      if (event.type === "text.completed") {
        const result = await this.streaming.finish(event, signal, record, authorized);
        if (result.kind === "complete") return;
        if (result.kind === "continue") text = result.text;
      }
      await this.outbox.deliver({ mode: "active", recipient: event.target.conversationId.slice(4), content: text }, {
        signal: AbortSignal.any([signal, this.lifetime.signal]),
        allowResultFile: event.type === "text.completed",
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
    const parsed = parseQqTextEvent(envelope);
    if (parsed.kind !== "supported") {
      if (parsed.kind === "rejected") this.options.logger.warn({ reason: parsed.reason, field: parsed.field }, "QQ 非普通文字事件未处理");
      return;
    }
    const message = parsed.message;
    const target = this.target(message.actorId);
    if (!this.options.access.isAllowed({ target, actorId: message.actorId })) return;
    const now = Date.now();
    if (now < this.lastWall) { this.lastWall = Infinity; return; }
    this.lastWall = now;
    if (message.sentAtMs < this.startedAt || message.sentAtMs > now || now - message.sentAtMs > 60_000) return;
    for (const [key, until] of this.dedup) if (until <= performance.now()) this.dedup.delete(key);
    const key = JSON.stringify([message.actorId, message.id, message.msgIdx]);
    if (this.dedup.has(key)) return;
    if (this.dedup.size >= 4096 || this.tasks.size >= (isEmergencyStopCommand(message.content) ? 40 : 32)) {
      this.options.logger.warn({ reason: "input-capacity" }, "QQ 输入容量已满，未提交或排队"); return;
    }
    this.dedup.set(key, performance.now() + 600_000);
    this.options.actors.rememberActor(target, message.actorId);
    const task = this.process(message, target).catch(() => {
      this.options.logger.warn({ reason: "input-or-reply-failed" }, "QQ 输入处理或回复未确认；不自动重试");
    }).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private async process(message: QqInboundTextMessage, target: ConversationTarget): Promise<void> {
    let command: ReturnType<typeof parseSlashCommand>;
    try { command = parseSlashCommand(message.content); }
    catch { await this.reply(message, "命令格式不受支持。使用 /help 查看 QQ 命令。", () => this.allowed(target, message.actorId)); return; }
    const stop = command?.name === "stop" && !command.argumentsText;
    if (stop) this.sources.cancelTarget(target);
    if (this.busy.has(target.conversationId) && !stop) {
      await this.reply(message, "上一条输入仍在处理中，请稍后重试；/stop 可取消当前准备和任务。", () => this.allowed(target, message.actorId)); return;
    }
    if (!stop) this.busy.add(target.conversationId);
    let stage: "command" | "render" | "reply" | "submit" = "command";
    try {
      if (command) {
        if (!["help", "status", "stop", "workspace", "model", "new", "sessions", "resume"].includes(command.name)
          || (["help", "status", "stop", "new"].includes(command.name) && command.argumentsText.trim())) {
          await this.reply(message, "QQ 暂不支持此命令或参数。使用 /help 查看支持范围。", () => this.allowed(target, message.actorId)); return;
        }
        if (command.name === "help") { await this.reply(message, HELP, () => this.allowed(target, message.actorId)); return; }
        if (((command.name === "workspace" || command.name === "model" || command.name === "resume") && command.argumentsText.trim()) || command.name === "new") this.sources.cancelTarget(target);
        const commandScope = this.scope(message.actorId);
        const result = await this.options.commands.execute(target, command.name as "status" | "stop" | "workspace" | "model" | "new" | "sessions" | "resume", command.argumentsText, message.actorId);
        stage = "render";
        const scope = command.name === "workspace" && command.argumentsText.trim() ? this.scope(message.actorId) : commandScope;
        const text = result.kind === "outcome" ? formatConversationCommandOutcome(result.outcome)
          : renderConversationCommandResult(result.kind === "models" ? { kind: "models", view: "model", state: result.state } : result);
        if (!text) throw new Error("QQ 命令没有可交付结果");
        stage = "reply";
        await this.reply(message, text, () => !!scope && this.current(scope));
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
    } finally { if (!stop) this.busy.delete(target.conversationId); }
  }

  private async reply(message: QqInboundTextMessage, content: string, allowed: () => boolean): Promise<void> {
    // A send failure must not recursively send another reply with the same msg_seq.
    if (this.replied.has(message)) throw new Error("QQ 来信回复已尝试，不重复发送");
    this.replied.add(message);
    await this.outbox.deliver({ mode: "passive", recipient: message.actorId, content,
      messageId: message.id, sequence: 1, sourceTimestampMs: message.sentAtMs }, {
      signal: this.lifetime.signal,
      beforeSend: () => { if (!allowed()) throw new Error("QQ 回复授权失效"); },
      reserve: parts => this.budget.reserve(message.actorId, parts),
    }, async () => {});
  }
  private target(actorId: string): ConversationTarget { return { surface: "qq", accountId: this.options.appId, conversationId: `c2c:${actorId}` }; }
  private allowed(target: ConversationTarget, actorId: string): boolean {
    return !this.lifetime.signal.aborted && this.options.access.isAllowed({ target, actorId });
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
    this.lifetime.abort(); this.sources.close();
    await Promise.all([this.streaming.close(), this.outbox.close()]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled(this.tasks), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("QQ 输入关闭未确认")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
