import type { Agent } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { safeInteractionDecision, type InteractionPort } from "../../approval/index.js";
import { isConversationCommandName, type ConversationCommandExecutor, type ConversationTurnUseCases } from "../../application/index.js";
import { UserFacingError, type ConversationTarget } from "../../conversation-core/index.js";
import type { ConversationActorRegistry, SurfaceAccessPolicy } from "../../policy/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { captureDelivery, checkpointDelivery } from "../delivery-receipt.js";
import { parseSlashCommand } from "../slash-command.js";
import type { SurfaceAdapter, SurfaceOutputPort } from "../types.js";
import { createQqLedger } from "./ledger.js";
import { QqProtocolClient, QqProtocolError, isQqMarkdownFormatRejection, maximumQqImageBytes, type QqMessageBody } from "./protocol.js";
import { readGeneratedImage } from "../generated-image.js";
import { generatedImageUnavailableText } from "../operation-presentation.js";
import { planQqMessage, qqCommandNames, qqHelp, renderQqCommandResult, renderQqOutput, renderQqPanel, type QqRenderedMessage } from "./rendering.js";
import { QqWebSocketTransport, QqTransportError } from "./transport.js";
import { QqInteractionDeliveryError, QqInteractionPort } from "./interactions.js";

export interface QqNetwork {
  fetchImpl: typeof fetch;
  agentForUrl(url: string, signal: AbortSignal): Agent | undefined;
  releaseAgent(agent: Agent): Promise<void>;
  close(): Promise<void>;
}

export interface CreateQqSurfaceOptions {
  appId: string;
  appSecret: string;
  directory: string;
  createNetwork(): QqNetwork;
  access: SurfaceAccessPolicy;
  actors: ConversationActorRegistry;
  service: Pick<ConversationTurnUseCases, "submit">;
  commands: ConversationCommandExecutor;
  logger: Logger;
  onFatal(error: Error): void;
}
// Commands which can start a Turn need their own verified submission association.
const supportedCommands = new Set<string>(qqCommandNames);

class QqCommandReplyError extends Error {
  constructor(readonly authorized: () => boolean) {
    super("命令已返回结果，但 QQ 回复未确认送达；请先核对会话状态，不要重复执行写操作。较长查询请缩小范围或在原生客户端查看。");
  }
}

export class QqSurface implements SurfaceAdapter {
  readonly surface = "qq";
  readonly accountId: string;
  readonly interactions: InteractionPort = {
    request: (target, request) => this.closed || !this.current ? Promise.resolve(safeInteractionDecision(request)) : this.current.interactions.request(target, request),
    resolved: requestId => this.current?.interactions.resolved(requestId),
    cancelAll: () => this.current?.interactions.cancelAll(),
  };
  readonly output: SurfaceOutputPort;
  private current: QqGeneration | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly options: CreateQqSurfaceOptions) {
    this.accountId = options.appId;
    this.output = { handle: () => {}, deliver: (event, signal, checkpoint, authorized) => {
      if (this.closed || !this.current?.output.deliver) return Promise.reject(new Error("QQ 当前连接不可用"));
      return this.current.output.deliver(event, signal, checkpoint, authorized);
    } };
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("QQ 已关闭"));
    return this.starting ??= this.begin().finally(() => { this.starting = undefined; });
  }
  private async begin(): Promise<void> {
    await this.current?.stop();
    if (this.closed) throw new Error("QQ 已关闭");
    const generation = new QqGeneration(this.options);
    this.current = generation;
    try { await generation.start(); }
    catch (error) { await generation.stop(); throw error; }
    if (this.closed) { await generation.stop(); throw new Error("QQ 已关闭"); }
  }
  stop(): Promise<void> {
    this.closed = true;
    return this.stopping ??= (async () => {
      await waitBounded(Promise.all([
        this.current?.stop(), this.starting?.catch(() => {}),
      ]), undefined, 5_000);
    })();
  }
  deliverConfigurationChange(): Promise<void> { return Promise.reject(new Error("QQ 配置通知没有被动回复依据")); }
}

class QqGeneration implements SurfaceAdapter {
  readonly surface = "qq";
  readonly accountId: string;
  readonly output: SurfaceOutputPort;
  readonly interactions: QqInteractionPort;
  private readonly client: QqProtocolClient;
  private readonly network: QqNetwork;
  private readonly transport: QqWebSocketTransport;
  private readonly ledger: ReturnType<typeof createQqLedger>;
  private readonly queue: ConversationDeliveryQueue;
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, Set<Promise<void>>>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly generationId = randomUUID();
  private readonly observedMilestones = new Set<"first-input" | "first-submission" | "first-reply">();
  private stopping: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: CreateQqSurfaceOptions) {
    this.accountId = options.appId;
    this.network = options.createNetwork();
    this.client = new QqProtocolClient({ appId: options.appId, appSecret: options.appSecret, fetchImpl: this.network.fetchImpl });
    this.ledger = createQqLedger(options.directory, options.appId, () => this.fatal(new Error("QQ 传输登记不可用")));
    this.queue = new ConversationDeliveryQueue(options.logger, { component: "qq", capacity: 32, maximumPendingOperations: 256, errorMetadata: () => ({ reason: "qq-delivery-failed" }) });
    this.interactions = new QqInteractionPort({
      allowed: (target, actor) => target.surface === "qq" && target.accountId === this.accountId && this.allowed(target, actor),
      rejected: reason => this.options.logger.warn({ surface: "qq", accountId: this.accountId,
        generationId: this.generationId, reason }, "QQ 交互已安全拒绝或取消，请在原生客户端核对"),
      send: async (target, request, result, signal, authorized) => {
        const actor = this.actor(target);
        if (typeof request.turnId !== "string") throw new QqInteractionDeliveryError("missing-turn-grant");
        let grant = this.ledger.forTurn(actor, request.threadId, request.turnId);
        if (!grant) {
          const waiting = [...(this.pending.get(target.conversationId) ?? [])];
          if (waiting.length) {
            try { await waitBounded(Promise.allSettled(waiting), signal, 15_000); }
            catch { throw new QqInteractionDeliveryError("turn-association-unconfirmed"); }
          }
          grant = this.ledger.forTurn(actor, request.threadId, request.turnId);
        }
        if (!grant) throw new QqInteractionDeliveryError("missing-turn-grant");
        const originalGrant = grant;
        const current = (): boolean => {
          if (!this.allowed(target, actor)) return false;
          try { this.ledger.remaining(originalGrant, actor); return true; } catch { return false; }
        };
        if (!current()) throw new QqInteractionDeliveryError("grant-expired");
        await this.queue.runOrdered(target.conversationId, queueSignal => this.send(target, actor, originalGrant,
          result, AbortSignal.any([signal, queueSignal, this.controller.signal]), () => authorized() && current()), signal);
        return { current, remainingMs: this.ledger.remainingMs(originalGrant, actor) };
      },
    });
    this.transport = new QqWebSocketTransport({ client: this.client,
      agentForUrl: (url, signal) => this.network.agentForUrl(url, signal),
      releaseAgent: agent => this.network.releaseAgent(agent),
      onDispatch: (envelope, signal) => this.receive(envelope, signal),
      onStatus: status => this.options.logger.info({ surface: "qq", accountId: this.accountId, generationId: this.generationId,
        stage: "connection", status }, "QQ 连接阶段变化；连接就绪不代表消息收发已验证"),
    });
    void this.transport.finished.catch(error => this.fatal(error));
    this.output = {
      handle: () => {},
      deliver: (event, signal, checkpoint, authorized) => captureDelivery(() => {
        this.queue.enqueue(event.target.conversationId, async queueSignal => {
          const combined = AbortSignal.any([signal, queueSignal, this.controller.signal]);
          combined.throwIfAborted();
          if (!authorized || !authorized()) throw new Error("QQ 可靠输出缺少有效归属授权");
          const actor = this.actor(event.target);
          if (!("threadId" in event) || !("turnId" in event) || typeof event.turnId !== "string") throw new Error("QQ 输出缺少轮次归属");
          let grant = this.ledger.forTurn(actor, event.threadId, event.turnId);
          if (!grant) {
            const waiting = [...(this.pending.get(event.target.conversationId) ?? [])];
            if (waiting.length) await waitBounded(Promise.allSettled(waiting), combined, 15_000);
            grant = this.ledger.forTurn(actor, event.threadId, event.turnId);
          }
          if (!grant) throw new Error("QQ 输出回复来源未确认");
          if (event.type === "operation.updated" && event.operation.kind === "imageGeneration" && event.operation.status === "completed") {
            if (event.operation.imagePath !== undefined) {
              await this.sendGeneratedImage(event.target, actor, grant, event.operation.imagePath, combined, authorized);
            } else {
              await this.send(event.target, actor, grant, renderQqPanel(generatedImageUnavailableText), combined, authorized);
            }
            return;
          }
          const result = renderQqOutput(event);
          await this.send(event.target, actor, grant, result, combined, authorized);
        }, true);
      }, signal, checkpoint, { requireConfirmation: true }),
    };
  }

  async start(): Promise<void> {
    this.controller.signal.throwIfAborted();
    await this.ledger.open();
    if (this.ledger.unconfirmedCount > 0) this.options.logger.warn({
      reason: "qq-unconfirmed-input", count: this.ledger.unconfirmedCount,
    }, "QQ 保留了未确认输入登记，请核对原生会话；不会自动重新执行");
    this.controller.signal.throwIfAborted();
    await this.transport.start();
    this.controller.signal.throwIfAborted();
  }
  stop(): Promise<void> { return this.stopping ??= this.close(); }
  deliverConfigurationChange(): Promise<void> { return Promise.reject(new Error("QQ 配置通知没有被动回复依据")); }

  private async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    this.client.close();
    const results = await Promise.allSettled([
      this.transport.stop(), this.queue.close(), waitBounded(this.interactions.close(), undefined, 5_000),
      waitBounded(Promise.allSettled([...this.jobs]).then(() => this.ledger.close()), undefined, 5_000),
      waitBounded(this.network.close(), undefined, 5_000),
    ]);
    if (results.some(result => result.status === "rejected")) throw new Error("QQ 关闭未全部确认");
  }

  private async receive(envelope: { t: string; d: unknown }, admissionSignal: AbortSignal): Promise<void> {
    admissionSignal.throwIfAborted();
    if (this.closed || envelope.t !== "C2C_MESSAGE_CREATE") return;
    let message: Inbound;
    try { message = decodeMessage(envelope.d); }
    catch {
      this.options.logger.warn({ reason: "qq-invalid-message" }, "QQ 消息字段不受支持，未提交");
      return;
    }
    const target: ConversationTarget = { surface: "qq", accountId: this.accountId, conversationId: `c2c:${message.actor}` };
    if (!this.allowed(target, message.actor)) return;
    if (this.jobs.size >= 32) throw new Error("QQ 接收容量已满");
    if (!await this.ledger.claim(message.id, message.msgId, message.actor, message.createdAt)) {
      this.options.logger.info({ reason: "qq-replay-or-expired" }, "QQ 输入重复或时间窗口无效，未提交");
      return;
    }
    admissionSignal.throwIfAborted();
    this.controller.signal.throwIfAborted();
    this.options.actors.rememberActor(target, message.actor);
    const job = Promise.resolve().then(async () => {
      try { await this.process(target, message); await this.ledger.handled(message.id); }
      catch (error) {
        const replyFailure = error instanceof QqCommandReplyError;
        this.options.logger.warn({ reason: replyFailure ? "qq-command-reply-unconfirmed" : "qq-input-failed" },
          replyFailure ? "QQ 命令已返回结果，但回复未确认送达，不自动重试" : "QQ 输入未确认完成，不自动重试");
        if (!this.ledger.available) return;
        if (this.allowed(target, message.actor)) {
          const text = replyFailure || error instanceof UserFacingError ? error.message : "请求未确认完成，请先核对会话状态；不会自动重复执行。";
          await this.notify(target, message.actor, message.id, text, replyFailure ? error.authorized : undefined).catch(() => {});
        }
      }
    }).finally(() => {
      this.jobs.delete(job);
    });
    this.jobs.add(job);
  }

  private async process(target: ConversationTarget, message: Inbound): Promise<void> {
    if (!this.allowed(target, message.actor)) throw new Error("QQ 输入已取消");
    if (!message.supported) {
      await this.notify(target, message.actor, message.id, "QQ 当前仅支持完整纯文本输入，附件和混合消息未提交。");
      return;
    }
    this.observeMilestone("first-input", "QQ 本运行代次首条授权完整文本已接收；尚不代表已提交模型");
    const interactionReply = this.interactions.handleText(target, message.actor, message.text);
    if (interactionReply !== null) {
      await this.notify(target, message.actor, message.id, interactionReply);
      return;
    }
    const command = parseSlashCommand(message.text);
    if (command) {
      if (command.name === "help") { await this.notify(target, message.actor, message.id, qqHelp); return; }
      if (!supportedCommands.has(command.name) || !isConversationCommandName(command.name)) {
        await this.notify(target, message.actor, message.id, "当前 QQ 切片不支持该命令，请发送 /help。");
        return;
      }
      if (command.name === "limits" && command.argumentsText.trim()) {
        await this.notify(target, message.actor, message.id, "QQ 当前仅支持 /limits 查询，账户额度操作请在原生客户端处理。");
        return;
      }
      let authorizeReply: (() => void) | undefined;
      const result = await this.options.commands.execute(target, command.name, command.argumentsText, message.actor,
        () => this.allowed(target, message.actor), authorize => { authorizeReply = authorize; });
      const replyAllowed = (): boolean => {
        if (!authorizeReply) return false;
        try { authorizeReply(); return true; } catch { return false; }
      };
      try {
        const rendered = renderQqCommandResult(result);
        if (rendered) await this.notify(target, message.actor, message.id, rendered, replyAllowed);
      } catch {
        // The command returned; a failed reply must neither imply failed execution nor lose its binding guard.
        throw new QqCommandReplyError(replyAllowed);
      }
      return;
    }
    // Only submission/association is awaited by output, never a command reply queued behind it.
    const submission = this.options.service.submit(target, message.text, () => this.allowed(target, message.actor))
      .then(async result => {
        await this.ledger.associate(message.id, result.threadId, result.turnId, result.steered);
        this.observeMilestone("first-submission", "QQ 本运行代次首次会话提交已返回并登记；尚不代表模型完成");
      });
    const entries = this.pending.get(target.conversationId) ?? new Set<Promise<void>>();
    entries.add(submission);
    this.pending.set(target.conversationId, entries);
    try { await submission; }
    finally {
      entries.delete(submission);
      if (!entries.size) this.pending.delete(target.conversationId);
    }
  }
  private notify(target: ConversationTarget, actor: string, grant: string, text: string | QqRenderedMessage, authorized?: () => boolean): Promise<void> {
    const result = typeof text === "string" ? renderQqPanel(text) : text;
    return this.queue.runOrdered(target.conversationId, signal => this.send(target, actor, grant,
      result, signal, authorized), this.controller.signal);
  }
  private async send(target: ConversationTarget, actor: string, grant: string, result: QqRenderedMessage, signal: AbortSignal,
    authorized?: () => boolean): Promise<void> {
    signal.throwIfAborted();
    if (!this.allowed(target, actor)) throw new Error("QQ 发送授权已失效");
    const remaining = this.ledger.remaining(grant, actor);
    const messages = planQqMessage(result, remaining);
    this.options.logger.info({ reason: "qq-output-plan", remaining, messageCount: messages.length,
      formats: messages.map(message => message.kind) }, "QQ 完整输出计划已生成");
    try {
      await this.sendMessages(target, actor, grant, messages, signal, authorized,
        messages.length === 1 && messages[0]?.kind === "markdown");
    } catch (error) {
      // Only a single, explicitly rejected Markdown operation may fall back. Reserve a new sequence
      // without reclaiming the rejected attempt; unknown or partly delivered output never retries.
      if (messages.length !== 1 || messages[0]?.kind !== "markdown" || !isQqMarkdownFormatRejection(error)) throw error;
      this.options.logger.warn({ reason: "markdown-rejected", ...(error instanceof QqProtocolError
        ? { httpStatus: error.httpStatus, bizCode: error.bizCode } : {}) }, "QQ Markdown 被明确拒绝，将使用完整纯文本");
      await this.sendMessages(target, actor, grant, planQqMessage(result, this.ledger.remaining(grant, actor), true), signal, authorized, false);
    }
    this.observeMilestone("first-reply", "QQ 本运行代次首个完整回复已获平台确认；不代表客户端已读或模型轮次完成");
  }
  private observeMilestone(stage: "first-input" | "first-submission" | "first-reply", message: string): void {
    if (this.observedMilestones.has(stage)) return;
    this.observedMilestones.add(stage);
    this.options.logger.info({ surface: "qq", accountId: this.accountId, generationId: this.generationId, stage }, message);
  }
  private async sendGeneratedImage(target: ConversationTarget, actor: string, grant: string, path: string,
    signal: AbortSignal, authorized: () => boolean): Promise<void> {
    const current = (): void => {
      signal.throwIfAborted();
      if (!this.allowed(target, actor) || !authorized()) throw new Error("QQ 图片发送授权已失效");
      if (this.ledger.remaining(grant, actor) < 1) throw new Error("QQ 图片回复额度不足");
    };
    current();
    const image = await readGeneratedImage(path, maximumQqImageBytes);
    current();
    const reservation = await this.ledger.reserve(grant, actor, 1);
    const remainingMs = this.ledger.remainingMs(grant, actor);
    const sendSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remainingMs))]);
    const beforeSend = (): void => {
      sendSignal.throwIfAborted();
      if (!this.allowed(target, actor) || !authorized() || Date.now() >= reservation.expiresAt) throw new Error("QQ 图片回复依据已失效");
      this.ledger.remainingMs(grant, actor);
    };
    const uploaded = await checkpointDelivery("qq.c2c.upload-image", () => this.client.uploadC2CImage({
      userOpenid: actor, bytes: image.bytes, format: image.format, signal: sendSignal, beforeSend,
    }));
    await checkpointDelivery("qq.c2c.image", () => this.client.sendC2CMessage({ userOpenid: actor,
      msgId: reservation.msgId, msgSeq: reservation.msgSeq,
      message: { kind: "image", fileInfo: uploaded.fileInfo }, signal: sendSignal,
      beforeSend: () => {
        beforeSend();
        if (performance.now() >= uploaded.expiresAt) throw new Error("QQ 图片上传凭据已过期");
      },
    }));
    this.observeMilestone("first-reply", "QQ 本运行代次首个完整回复已获平台确认；不代表客户端已读或模型完成");
  }
  private async sendMessages(target: ConversationTarget, actor: string, grant: string, messages: QqMessageBody[],
    signal: AbortSignal, authorized: (() => boolean) | undefined, allowFormatRejection: boolean): Promise<void> {
    signal.throwIfAborted();
    if (!this.allowed(target, actor) || authorized?.() === false) throw new Error("QQ 发送授权已失效");
    // Reserve the complete result before the first side effect, including Unicode boundary overhead.
    const reservation = await this.ledger.reserve(grant, actor, messages.length);
    const remaining = this.ledger.remainingMs(grant, actor);
    if (remaining <= 0) throw new Error("QQ 回复窗口已过期");
    const sendSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))]);
    const beforeSend = (): void => {
      sendSignal.throwIfAborted();
      if (Date.now() >= reservation.expiresAt || !this.allowed(target, actor) || authorized?.() === false) {
        throw new Error("QQ 发送依据已失效");
      }
      this.ledger.remainingMs(grant, actor);
    };
    for (const [index, message] of messages.entries()) {
      beforeSend();
      await checkpointDelivery(`qq.c2c.${message.kind}`, () => this.client.sendC2CMessage({ userOpenid: actor,
        msgId: reservation.msgId, msgSeq: reservation.msgSeq + index, message, signal: sendSignal, beforeSend }),
      allowFormatRejection ? isQqMarkdownFormatRejection : undefined);
    }
  }
  private allowed(target: ConversationTarget, actor: string): boolean {
    return !this.closed && this.ledger.available && this.options.access.isAllowed({ target, actorId: actor });
  }
  private fatal(error: unknown): void {
    if (this.closed) return;
    const fields = error instanceof QqProtocolError
      ? { operation: error.operation, reason: error.reason, httpStatus: error.httpStatus, bizCode: error.bizCode, traceId: error.traceId }
      : error instanceof QqTransportError ? { reason: error.reason, closeCode: error.closeCode }
      : { reason: "transport-storage-unavailable" };
    this.options.logger.error(fields, "QQ 运行代次失败，将关闭后恢复");
    this.options.onFatal(new Error("QQ 运行代次失败"));
    void this.stop().catch(() => this.options.logger.warn({ reason: "qq-close-failed" }, "QQ 关闭未完成"));
  }
  private actor(target: ConversationTarget): string {
    const actor = target.conversationId.startsWith("c2c:") ? target.conversationId.slice(4) : "";
    if (!actor || !this.allowed(target, actor)) throw new Error("QQ 输出目标未授权");
    return actor;
  }
}

interface Inbound { id: string; msgId: string; actor: string; createdAt: number; text: string; supported: boolean }
function decodeMessage(value: unknown): Inbound {
  if (!record(value) || !record(value.author) || !identifier(value.id) || !identifier(value.author.user_openid)
    || typeof value.timestamp !== "string"
    || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value.timestamp)
    || !Number.isFinite(Date.parse(value.timestamp))) throw new Error("QQ 消息身份或时间无效");
  const scene = value.message_scene;
  if (!record(scene) || scene.source !== "default" || !Array.isArray(scene.ext)
    || scene.ext.length > 16 || !scene.ext.every(entry => typeof entry === "string" && entry.length <= 1024)) throw new Error("QQ 消息场景缺失或不支持");
  const extensions = scene.ext as string[];
  const indexes = extensions.filter(entry => entry.startsWith("msg_idx="));
  if (indexes.length !== 1 || !identifier(indexes[0]!.slice(8))) throw new Error("QQ 消息去重身份缺失");
  const text = typeof value.content === "string" ? value.content : "";
  const id = createHash("sha256").update(JSON.stringify([value.id, value.author.user_openid, indexes[0]])).digest("hex");
  return { id, msgId: value.id, actor: value.author.user_openid, createdAt: Date.parse(value.timestamp), text,
    supported: text.trim().length > 0 && Buffer.byteLength(text, "utf8") <= 32_000
      && (value.attachments === undefined || Array.isArray(value.attachments) && value.attachments.length === 0)
      && value.message_type === 0 && value.ark_data === undefined && value.msg_elements === undefined
      && !extensions.some(entry => entry.startsWith("ref_msg_idx=")) };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/\s/u.test(value)
    && ![...value].some(character => { const code = character.codePointAt(0)!; return code < 32 || code >= 127 && code <= 159; });
}
async function waitBounded<T>(promise: Promise<T>, signal: AbortSignal | undefined, milliseconds: number): Promise<T> {
  const timeout = AbortSignal.timeout(milliseconds);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("QQ 操作等待已取消或超时"));
    combined.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => combined.removeEventListener("abort", abort));
  });
}
