import type { Agent } from "node:http";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { safeInteractionDecision, type InteractionPort } from "../../approval/index.js";
import { isConversationCommandName, type ConversationCommandExecutor, type ConversationTurnUseCases } from "../../application/index.js";
import { UserFacingError, type ConversationTarget, type OutputEvent } from "../../conversation-core/index.js";
import type { ConversationActorRegistry, SurfaceAccessPolicy } from "../../policy/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { captureDelivery, checkpointDelivery } from "../delivery-receipt.js";
import { parseSlashCommand } from "../slash-command.js";
import type { SurfaceAdapter, SurfaceOutputPort } from "../types.js";
import { createQqLedger } from "./ledger.js";
import { QqProtocolClient, QqProtocolError } from "./protocol.js";
import { QqWebSocketTransport, QqTransportError } from "./transport.js";

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
const supportedCommands = new Set(["status", "stop", "workspace", "sessions", "resume", "new", "model", "effort", "fast", "usage", "limits"]);
const help = "QQ 单聊文本模式\n/status /stop /workspace /sessions /resume /new /model /effort /fast /usage /limits\n审批、问题、流式、附件、计划任务暂不支持；审批请求安全拒绝，请在原生客户端处理。";

export class QqSurface implements SurfaceAdapter {
  readonly surface = "qq";
  readonly accountId: string;
  readonly interactions: InteractionPort = { request: (_target, request) => Promise.resolve(safeInteractionDecision(request)) };
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
  readonly interactions: InteractionPort = { request: (_target, request) => Promise.resolve(safeInteractionDecision(request)) };
  private readonly client: QqProtocolClient;
  private readonly network: QqNetwork;
  private readonly transport: QqWebSocketTransport;
  private readonly ledger: ReturnType<typeof createQqLedger>;
  private readonly queue: ConversationDeliveryQueue;
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, Set<Promise<void>>>();
  private readonly jobs = new Set<Promise<void>>();
  private stopping: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: CreateQqSurfaceOptions) {
    this.accountId = options.appId;
    this.network = options.createNetwork();
    this.client = new QqProtocolClient({ appId: options.appId, appSecret: options.appSecret, fetchImpl: this.network.fetchImpl });
    this.ledger = createQqLedger(options.directory, options.appId, () => this.fatal(new Error("QQ 传输登记不可用")));
    this.queue = new ConversationDeliveryQueue(options.logger, { component: "qq", capacity: 32, maximumPendingOperations: 256, errorMetadata: () => ({ reason: "qq-delivery-failed" }) });
    this.transport = new QqWebSocketTransport({ client: this.client,
      agentForUrl: (url, signal) => this.network.agentForUrl(url, signal),
      releaseAgent: agent => this.network.releaseAgent(agent),
      onDispatch: (envelope, signal) => this.receive(envelope, signal),
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
          const text = outputText(event);
          await this.send(event.target, actor, grant, text, combined, authorized);
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
      this.transport.stop(), this.queue.close(),
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
        this.options.logger.warn({ reason: "qq-input-failed" }, "QQ 输入未确认完成，不自动重试");
        if (!this.ledger.available) return;
        if (this.allowed(target, message.actor)) {
          const text = error instanceof UserFacingError ? error.message : "请求未确认完成，请先核对会话状态；不会自动重复执行。";
          await this.notify(target, message.actor, message.id, text).catch(() => {});
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
    const command = parseSlashCommand(message.text);
    if (command) {
      if (command.name === "help") { await this.notify(target, message.actor, message.id, help); return; }
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
      const text = renderConversationCommandResult(result);
      if (text) await this.notify(target, message.actor, message.id, text, () => {
        if (!authorizeReply) return false;
        try { authorizeReply(); return true; } catch { return false; }
      });
      return;
    }
    // Only submission/association is awaited by output, never a command reply queued behind it.
    const submission = this.options.service.submit(target, message.text, () => this.allowed(target, message.actor))
      .then(result => this.ledger.associate(message.id, result.threadId, result.turnId, result.steered));
    const entries = this.pending.get(target.conversationId) ?? new Set<Promise<void>>();
    entries.add(submission);
    this.pending.set(target.conversationId, entries);
    try { await submission; }
    finally {
      entries.delete(submission);
      if (!entries.size) this.pending.delete(target.conversationId);
    }
  }
  private notify(target: ConversationTarget, actor: string, grant: string, text: string, authorized?: () => boolean): Promise<void> {
    return this.queue.runOrdered(target.conversationId, signal => this.send(target, actor, grant, text, signal, authorized), this.controller.signal);
  }
  private async send(target: ConversationTarget, actor: string, grant: string, text: string, signal: AbortSignal, authorized?: () => boolean): Promise<void> {
    signal.throwIfAborted();
    if (!this.allowed(target, actor)) throw new Error("QQ 发送授权已失效");
    if (!text || Buffer.byteLength(text, "utf8") > 12_000) throw new Error("QQ 完整结果超过文本预算，保留待核对");
    // Sequential full Unicode chunks. A partial success never confirms the whole receipt.
    const chunks: string[] = [];
    let chunk = "";
    for (const character of text) {
      if (Buffer.byteLength(chunk + character, "utf8") > 3_000) { chunks.push(chunk); chunk = ""; }
      chunk += character;
    }
    if (chunk) chunks.push(chunk);
    // Reserve the complete result before the first side effect, including Unicode boundary overhead.
    const reservation = await this.ledger.reserve(grant, actor, chunks.length);
    const remaining = reservation.expiresAt - Date.now();
    if (remaining <= 0) throw new Error("QQ 回复窗口已过期");
    const sendSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    const beforeSend = (): void => {
      sendSignal.throwIfAborted();
      if (Date.now() >= reservation.expiresAt || !this.allowed(target, actor) || authorized?.() === false) {
        throw new Error("QQ 发送依据已失效");
      }
    };
    for (const [index, content] of chunks.entries()) {
      beforeSend();
      await checkpointDelivery("qq.c2c.text", () => this.client.sendC2CText({ userOpenid: actor,
        msgId: reservation.msgId, msgSeq: reservation.msgSeq + index, content, signal: sendSignal, beforeSend }));
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
function outputText(event: OutputEvent): string {
  if (event.type === "text.completed") return event.text;
  if (event.type === "operation.updated") return ["操作未完成", event.operation.kind, event.operation.detail ?? ""].filter(Boolean).join("\n");
  if (event.type === "turn.completed") return event.status === "completed" ? "本轮已完成。" : "本轮已结束，请通过 /status 核对状态。";
  throw new Error("QQ 尚不支持此类结果");
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
