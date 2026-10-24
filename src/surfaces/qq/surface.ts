import type { Agent } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import { safeInteractionDecision, type InteractionPort } from "../../approval/index.js";
import { isConversationCommandName, type ConversationCommandExecutor, type ConversationTurnUseCases, type Submission, type ThreadQueueSubmissionOrigin } from "../../application/index.js";
import { UserFacingError, conversationTargetKey, type ConversationTarget, type OutputEvent } from "../../conversation-core/index.js";
import type { ConversationActorRegistry, SurfaceAccessPolicy } from "../../policy/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { captureDelivery, checkpointDelivery, DeliveryReceipt } from "../delivery-receipt.js";
import { isEmergencyStopCommand, parseSlashCommand } from "../slash-command.js";
import { AttachmentInputLifecycle, type ReceivedAttachmentInput } from "../attachment-input-lifecycle.js";
import { SurfaceInputBatcher, imageBatchLimitError } from "../surface-input-batcher.js";
import type { StoredManagedImage } from "../managed-image-store.js";
import type { StoredManagedAudio } from "../managed-audio-store.js";
import { videoAttachmentBody, type PreparedVideoAttachment } from "../video-attachment-store.js";
import type { SurfaceAdapter, SurfaceOutputPort } from "../types.js";
import { createQqLedger } from "./ledger.js";
import { QqProtocolClient, QqProtocolError, isQqMarkdownFormatRejection, maximumQqImageBytes, type QqMessageBody } from "./protocol.js";
import { readGeneratedImage } from "../generated-image.js";
import { generatedImageUnavailableText } from "../operation-presentation.js";
import { planQqDelivery, planQqMessage, qqCommandNames, qqHelp, QqConfirmationPreviewError, renderQqCommandResult, renderQqOutput, renderQqPanel, type QqRenderedMessage } from "./rendering.js";
import { QqWebSocketTransport, QqTransportError } from "./transport.js";
import { QqInteractionDeliveryError, QqInteractionPort } from "./interactions.js";
import { QqImageStore, type QqImageReference } from "./image-store.js";
import { QqAudioStore, type QqAudioReference } from "./audio-store.js";
import { QqVideoStore, type QqVideoReference } from "./video-store.js";
import { isSupportedQqAttachmentUrl } from "./media-download.js";
import { formatQuotedInput } from "../quoted-input.js";
import { decodeQqReference } from "./quoted-reference.js";

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
  uploadsDirectory: string;
  videoDirectory: string;
  createNetwork(): QqNetwork;
  access: SurfaceAccessPolicy;
  actors: ConversationActorRegistry;
  service: Pick<ConversationTurnUseCases, "submit" | "prepareAttachmentSubmission">;
  commands: ConversationCommandExecutor;
  logger: Logger;
  onFatal(error: Error): void;
}
// This directory is shared with help; Turn-producing commands capture their exact submission below.
const supportedCommands = new Set<string>(qqCommandNames);

class QqCommandReplyError extends Error {
  constructor(readonly authorized: () => boolean, previewTooLarge = false) {
    super(previewTooLarge
      ? "QQ 无法在单条文字中完整展示确认预览；未发送确认令牌，未执行确认操作，请在原生客户端操作。"
      : "命令已返回结果，但 QQ 回复未确认送达；请先核对会话状态，不要重复执行写操作。较长查询请缩小范围或在原生客户端查看。");
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
    this.output = { admitLive: event => this.current?.output.admitLive?.(event), handle: () => {}, deliver: (event, signal, checkpoint, authorized) => {
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
  private readonly images: QqImageStore;
  private readonly audios: QqAudioStore;
  private readonly videos: QqVideoStore;
  private readonly attachmentInputs = new AttachmentInputLifecycle();
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, Set<Promise<Submission>>>();
  private readonly queueOrigins = new Map<string, {
    target: ConversationTarget; actor: string; grant: string; deadline: number; turnId?: string;
  }>();
  private readonly inputTails = new Map<string, { job: Promise<void>; cancellation: AbortController }>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly generationId = randomUUID();
  private readonly observedMilestones = new Set<"first-input" | "first-submission" | "first-reply">();
  private stopping: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: CreateQqSurfaceOptions) {
    this.accountId = options.appId;
    this.network = options.createNetwork();
    this.images = new QqImageStore(options.uploadsDirectory, this.network.fetchImpl,
      () => options.logger.warn({ reason: "qq-image-cleanup-failed" }, "QQ 图片暂存清理失败"));
    this.audios = new QqAudioStore(join(options.uploadsDirectory, "audio"), this.network.fetchImpl,
      () => options.logger.warn({ reason: "qq-audio-cleanup-failed" }, "QQ 音频暂存清理失败"));
    this.videos = new QqVideoStore(options.videoDirectory, this.network.fetchImpl,
      () => options.logger.warn({ reason: "qq-video-cleanup-failed" }, "QQ 视频暂存清理失败"));
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
        let grant: string | undefined;
        try { grant = await this.waitForTurnGrant(target, actor, request.threadId, request.turnId, signal); }
        catch { throw new QqInteractionDeliveryError("turn-association-unconfirmed"); }
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
      admitLive: event => this.observeQueueOrigin(event),
      handle: () => {},
      deliver: (event, signal, checkpoint, authorized) => captureDelivery(() => {
        this.queue.enqueue(event.target.conversationId, async queueSignal => {
          const combined = AbortSignal.any([signal, queueSignal, this.controller.signal]);
          combined.throwIfAborted();
          if (!authorized || !authorized()) throw new Error("QQ 可靠输出缺少有效归属授权");
          const actor = this.actor(event.target);
          if (!("threadId" in event) || !("turnId" in event) || typeof event.turnId !== "string") throw new Error("QQ 输出缺少轮次归属");
          const grant = await this.waitForTurnGrant(event.target, actor, event.threadId, event.turnId, combined);
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
    await this.images.start();
    await this.audios.start();
    await this.videos.start();
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
    this.queueOrigins.clear();
    this.controller.abort();
    for (const input of this.inputTails.values()) input.cancellation.abort();
    this.attachmentInputs.close();
    this.images.close();
    this.audios.close();
    this.client.close();
    const results = await Promise.allSettled([
      this.transport.stop(), this.queue.close(), waitBounded(this.interactions.close(), undefined, 5_000),
      waitBounded(this.videos.close(), undefined, 5_000),
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
    const allowed = (): boolean => this.allowed(target, message.actor);
    const mediaKind = message.supported ? message.audio ? "audio" : message.video ? "video" : message.images.length > 0 ? "image" : undefined : undefined;
    const receipt = mediaKind
      ? this.attachmentInputs.receive(target, allowed, mediaKind,
        () => this.options.service.prepareAttachmentSubmission?.(target, allowed, mediaKind)) : undefined;
    const stop = message.supported && !mediaKind && isEmergencyStopCommand(message.text)
      ? this.attachmentInputs.receiveStop(target) : undefined;
    const previousInput = this.inputTails.get(target.conversationId);
    const cancelledInputs = !!stop && (stop.cancelled || !!previousInput && !previousInput.cancellation.signal.aborted);
    if (stop) previousInput?.cancellation.abort();
    // Commands and interaction replies bypass slow media preparation; ordinary
    // messages retain receipt order, including the first Thread's creation.
    const ordinary = message.supported && (mediaKind !== undefined || !message.text.trim().startsWith("/"));
    const inputCancellation = ordinary
      ? previousInput && !previousInput.cancellation.signal.aborted ? previousInput.cancellation : new AbortController()
      : undefined;
    const job = Promise.resolve().then(async () => {
      try {
        if (ordinary) await previousInput?.job;
        if (inputCancellation?.signal.aborted) throw new UserFacingError("input.authorization-changed", "输入已取消，当前消息未提交。");
        await this.process(target, message, receipt, cancelledInputs, inputCancellation?.signal);
        await this.ledger.handled(message.id);
      }
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
      receipt?.dispose();
      stop?.();
      if (this.inputTails.get(target.conversationId)?.job === job) this.inputTails.delete(target.conversationId);
      this.jobs.delete(job);
    });
    if (inputCancellation) this.inputTails.set(target.conversationId, { job, cancellation: inputCancellation });
    this.jobs.add(job);
  }

  private async process(target: ConversationTarget, message: Inbound, receipt?: ReceivedAttachmentInput,
    cancelledInputs = false, inputSignal?: AbortSignal): Promise<void> {
    if (!this.allowed(target, message.actor)) throw new Error("QQ 输入已取消");
    if (!message.supported) {
      await this.notify(target, message.actor, message.id, "QQ 当前支持默认聊天中的文字、PNG/JPEG/非动画 GIF 图片、带可信 WAV 的 PCM 语音、单个 MP4 视频及原生引用上下文；混合媒体、不受支持的附件、地址、消息类型或引用结构未提交。");
      return;
    }
    this.observeMilestone("first-input", "QQ 本运行代次首条授权完整输入已接收；尚不代表已提交模型");
    if (message.audio || message.video) {
      if (!receipt) throw new UserFacingError(message.audio ? "audio.unavailable" : "video.unavailable", "QQ 附件输入不可用，当前消息未提交。");
      await this.submitMedia(target, message, receipt);
      return;
    }
    if (message.images.length > 0) {
      if (!receipt) throw new UserFacingError("image.unavailable", "QQ 图片输入不可用，当前消息未提交。");
      await this.submitImages(target, message, receipt);
      return;
    }
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
      let authorizeReply: (() => void) | undefined;
      const result = await this.options.commands.execute(target, command.name, command.argumentsText, message.actor,
        () => this.allowed(target, message.actor), authorize => { authorizeReply = authorize; },
        async submission => { await this.associateSubmission(target, message, submission); },
        origin => this.captureQueueOrigin(target, message, origin));
      if (cancelledInputs && result.kind === "outcome" && result.outcome.type === "turn.stop-requested") result.outcome.stopped = true;
      const replyAllowed = (): boolean => {
        if (!authorizeReply) return false;
        try { authorizeReply(); return true; } catch { return false; }
      };
      try {
        const rendered = renderQqCommandResult(result);
        if (rendered) await this.notify(target, message.actor, message.id, rendered, replyAllowed);
      } catch (error) {
        // The command returned; a failed reply must neither imply failed execution nor lose its binding guard.
        throw new QqCommandReplyError(replyAllowed, error instanceof QqConfirmationPreviewError);
      }
      return;
    }
    await this.submit(target, message, () => this.options.service.submit(target, formatQuotedInput(message.text, message.quotedText),
      () => !inputSignal?.aborted && this.allowed(target, message.actor)));
  }
  private async submitMedia(target: ConversationTarget, message: Inbound, receipt: ReceivedAttachmentInput): Promise<Submission> {
    const scope = await receipt.prepare();
    let audio: StoredManagedAudio | undefined;
    let video: PreparedVideoAttachment | undefined;
    let submitted = false;
    const kind = message.audio ? "audio" : "video";
    const current = (): void => {
      scope.signal.throwIfAborted();
      if (!this.allowed(target, message.actor)) throw new UserFacingError(`${kind}.unavailable`, "QQ 附件输入授权已失效，当前消息未提交。");
    };
    try {
      current();
      scope.captureTarget();
      let result: Submission;
      if (message.audio) {
        audio = await this.audios.download(message.audio, scope.signal, current);
        current();
        const text = formatQuotedInput(message.text.trim() ? message.text : "请听取这段语音并根据内容协助我。", message.quotedText);
        result = await this.submit(target, message, () => scope.submit({ text, localAudios: [{ path: audio!.path }] }));
      } else if (message.video) {
        video = await this.videos.download(message.video, { target, actorId: message.actor }, scope.signal, current);
        current();
        const text = formatQuotedInput([
          ...(message.text.trim() ? ["用户说明：", message.text, ""] : []), videoAttachmentBody(video),
        ].join("\n"), message.quotedText);
        result = await this.submit(target, message, () => scope.submit(text));
      } else throw new Error("QQ 附件类型缺失");
      submitted = true;
      return result;
    } catch (error) {
      if (scope.signal.aborted && !scope.mayHaveSubmitted) {
        throw new UserFacingError(`${kind}.unavailable`, "QQ 附件输入已取消或超时，当前消息未提交。");
      }
      throw error;
    } finally {
      // Paths may already be referenced by App Server even when its acknowledgment was lost.
      if (video) {
        if (submitted || scope.mayHaveSubmitted) this.videos.retain(video);
        else await this.videos.discard(video);
      }
      if (audio && !submitted && !scope.mayHaveSubmitted) await this.audios.discard(audio);
    }
  }
  private async submitImages(target: ConversationTarget, message: Inbound, receipt: ReceivedAttachmentInput): Promise<Submission> {
    const scope = await receipt.prepare();
    const downloaded: StoredManagedImage[] = [];
    const current = (): void => {
      scope.signal.throwIfAborted();
      if (!this.allowed(target, message.actor)) throw new UserFacingError("image.unavailable", "QQ 图片输入授权已失效，当前消息未提交。");
    };
    // No aggregation key: one QQ message, including all its images, is one submission.
    const inputs = new SurfaceInputBatcher((_target, input) => {
      current();
      return this.submit(target, message, () => scope.submit(input));
    });
    try {
      current();
      const limit = imageBatchLimitError(message.images.map(image => image.size === undefined ? {} : { bytes: image.size }), 4, 20 * 1024 * 1024);
      if (limit) throw limit;
      scope.captureTarget();
      for (const reference of message.images) {
        current();
        downloaded.push(await this.images.download(reference, scope.signal, current));
        const actualLimit = imageBatchLimitError(downloaded, 4, 20 * 1024 * 1024);
        if (actualLimit) throw actualLimit;
      }
      current();
      const currentText = message.text.trim() ? message.text : message.images.length === 1
        ? "请查看这张图片并根据图片内容协助我。" : "请查看这些图片并根据图片内容协助我。";
      const result = await inputs.enqueue({ target, actorId: message.actor, sequence: 0,
        text: formatQuotedInput(currentText, message.quotedText), localImages: downloaded });
      return result.submission;
    } catch (error) {
      if (scope.signal.aborted && !scope.mayHaveSubmitted) {
        throw new UserFacingError("image.unavailable", "QQ 图片输入已取消或超时，当前消息未提交。");
      }
      throw error;
    } finally {
      await inputs.close();
      await Promise.all(downloaded.map(image => this.images.discard(image)));
    }
  }
  private async submit(target: ConversationTarget, message: Inbound, operation: () => Promise<Submission>): Promise<Submission> {
    return this.associateSubmission(target, message, Promise.resolve().then(operation));
  }
  private captureQueueOrigin(target: ConversationTarget, message: Inbound, origin: ThreadQueueSubmissionOrigin): void {
    if (!this.allowed(target, message.actor)) throw new Error("QQ Queue 来源已失效");
    const deadline = performance.now() + this.ledger.remainingMs(message.id, message.actor);
    for (const [key, entry] of this.queueOrigins) {
      if (entry.deadline <= performance.now() || !this.allowed(entry.target, entry.actor)) this.queueOrigins.delete(key);
    }
    const key = JSON.stringify([origin.threadId, origin.clientId]);
    if (this.queueOrigins.has(key) || this.queueOrigins.size >= 500
      || [...this.queueOrigins.values()].some(entry => entry.grant === message.id)) {
      throw new Error("QQ Queue 来源登记冲突或容量已满");
    }
    this.queueOrigins.set(key, { target: { ...target }, actor: message.actor, grant: message.id, deadline });
  }
  private observeQueueOrigin(event: OutputEvent): void {
    if (event.type !== "user.message.identity") return;
    const key = JSON.stringify([event.threadId, event.clientId]);
    const origin = this.queueOrigins.get(key);
    if (!origin) return;
    if (origin.deadline <= performance.now() || !this.allowed(origin.target, origin.actor)) {
      this.queueOrigins.delete(key);
      return;
    }
    if (conversationTargetKey(origin.target) !== conversationTargetKey(event.target)
      || origin.turnId !== undefined && origin.turnId !== event.turnId) {
      this.options.logger.warn({ reason: "qq-queue-origin-conflict" }, "QQ Queue 消费身份与原来源冲突，未关联新轮次");
      return;
    }
    if (origin.turnId !== undefined) return;
    origin.turnId = event.turnId;
    // Publish a pending handle synchronously, before the next final output can be admitted.
    // Its asynchronous ledger write never blocks the App Server Reader.
    const association = this.trackSubmission(origin.target, this.ledger.associateQueuedTurn(origin.grant, origin.actor,
      event.threadId, event.turnId, () => {
        if (!this.allowed(origin.target, origin.actor) || origin.deadline <= performance.now()) {
          throw new Error("QQ Queue 原回复来源已失效");
        }
      }).then(() => ({ threadId: event.threadId, turnId: event.turnId, steered: false })));
    const job = association.then(() => {}, () => {
      this.options.logger.warn({ reason: "qq-queue-association-unconfirmed" }, "QQ Queue 轮次关联未确认，结果保留待核对");
    }).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
  }
  private async associateSubmission(target: ConversationTarget, message: Inbound, operation: Promise<Submission>): Promise<Submission> {
    // Output awaits only the actual submission/association, never downloads,
    // earlier input work or a command reply queued behind it.
    const submission = operation
      .then(async result => {
        await this.ledger.associate(message.id, result.threadId, result.turnId, result.steered);
        this.observeMilestone("first-submission", "QQ 本运行代次首次会话提交已返回并登记；尚不代表模型完成");
        return result;
      });
    return this.trackSubmission(target, submission);
  }
  private async trackSubmission(target: ConversationTarget, submission: Promise<Submission>): Promise<Submission> {
    const entries = this.pending.get(target.conversationId) ?? new Set<Promise<Submission>>();
    entries.add(submission);
    this.pending.set(target.conversationId, entries);
    try { return await submission; }
    finally {
      entries.delete(submission);
      if (!entries.size) this.pending.delete(target.conversationId);
    }
  }
  private async waitForTurnGrant(target: ConversationTarget, actor: string, threadId: string, turnId: string,
    signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted();
    const current = (): string | undefined => this.ledger.forTurn(actor, threadId, turnId);
    const grant = current();
    if (grant) return grant;
    const waiting = [...(this.pending.get(target.conversationId) ?? [])];
    if (!waiting.length) return undefined;
    return new Promise((resolve, reject) => {
      let settled = false;
      let remaining = waiting.length;
      const finish = (associated?: string, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(associated);
      };
      const abort = (): void => finish(undefined, new Error("QQ 轮次关联等待已取消或超时"));
      const timeout = setTimeout(abort, 15_000);
      signal.addEventListener("abort", abort, { once: true });
      const completed = (): void => {
        if (settled) return;
        const associated = current();
        remaining--;
        if (associated || remaining === 0) finish(associated);
      };
      for (const submission of waiting) void submission.then(completed, completed);
    });
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
    const plan = planQqDelivery(result, remaining);
    if (plan.kind === "file") {
      this.options.logger.info({ reason: "qq-output-plan", remaining, messageCount: 1, formats: ["file"] }, "QQ 完整输出计划已生成");
      await this.sendMedia(target, actor, grant, { kind: "file", bytes: plan.bytes }, signal, authorized);
      return;
    }
    const messages = plan.messages;
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
    await this.sendMedia(target, actor, grant, { kind: "image", ...image }, signal, authorized);
  }
  private async sendMedia(target: ConversationTarget, actor: string, grant: string,
    media: { kind: "image"; bytes: Buffer; format: "png" | "jpeg" } | { kind: "file"; bytes: Buffer },
    signal: AbortSignal, authorized?: () => boolean): Promise<void> {
    signal.throwIfAborted();
    if (!this.allowed(target, actor) || authorized?.() === false) throw new Error("QQ 附件发送授权已失效");
    const reservation = await this.ledger.reserve(grant, actor, 1);
    const remainingMs = this.ledger.remainingMs(grant, actor);
    const sendSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remainingMs))]);
    const beforeSend = (): void => {
      sendSignal.throwIfAborted();
      if (!this.allowed(target, actor) || authorized?.() === false || Date.now() >= reservation.expiresAt) throw new Error("QQ 附件回复依据已失效");
      this.ledger.remainingMs(grant, actor);
    };
    if (media.kind === "file") DeliveryReceipt.current()?.markContentIncomplete();
    const uploadInput = { userOpenid: actor, bytes: media.bytes, signal: sendSignal, beforeSend };
    const uploaded = await checkpointDelivery(`qq.c2c.upload-${media.kind}`, () => media.kind === "image"
      ? this.client.uploadC2CImage({ ...uploadInput, format: media.format })
      : this.client.uploadC2CFile(uploadInput));
    await checkpointDelivery(`qq.c2c.${media.kind}`, () => this.client.sendC2CMessage({ userOpenid: actor,
      msgId: reservation.msgId, msgSeq: reservation.msgSeq,
      message: { kind: media.kind, fileInfo: uploaded.fileInfo }, signal: sendSignal,
      beforeSend: () => {
        beforeSend();
        if (performance.now() >= uploaded.expiresAt) throw new Error("QQ 附件上传凭据已过期");
      },
    }));
    if (media.kind === "file") DeliveryReceipt.current()?.confirmCompleteContent();
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

interface Inbound {
  id: string; msgId: string; actor: string; createdAt: number; text: string; quotedText?: string;
  images: QqImageReference[]; audio?: QqAudioReference; video?: QqVideoReference; supported: boolean;
}
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
  const images: QqImageReference[] = [];
  let audio: QqAudioReference | undefined;
  let video: QqVideoReference | undefined;
  let supportedAttachments = value.attachments === undefined;
  if (Array.isArray(value.attachments) && value.attachments.length <= 4) {
    supportedAttachments = true;
    for (const attachment of value.attachments) {
      if (!record(attachment) || typeof attachment.url !== "string"
        || (attachment.size !== undefined && (!Number.isSafeInteger(attachment.size) || Number(attachment.size) <= 0))) {
        supportedAttachments = false;
        break;
      }
      if (attachment.content_type === "voice" && value.attachments.length === 1
        && typeof attachment.voice_wav_url === "string" && isSupportedQqAttachmentUrl(attachment.voice_wav_url)
        && (attachment.asr_refer_text === undefined || typeof attachment.asr_refer_text === "string")) {
        audio = { wavUrl: attachment.voice_wav_url };
      } else if (attachment.content_type === "video/mp4" && value.attachments.length === 1
        && isSupportedQqAttachmentUrl(attachment.url) && attachment.voice_wav_url === undefined && attachment.asr_refer_text === undefined) {
        video = { url: attachment.url, ...(attachment.size === undefined ? {} : { size: attachment.size as number }) };
      } else if ((attachment.content_type === "image/png" || attachment.content_type === "image/jpeg" || attachment.content_type === "image/gif")
        && isSupportedQqAttachmentUrl(attachment.url) && attachment.voice_wav_url === undefined && attachment.asr_refer_text === undefined) {
        images.push({ url: attachment.url, mimeType: attachment.content_type,
          ...(attachment.size === undefined ? {} : { size: attachment.size as number }) });
      } else { supportedAttachments = false; break; }
    }
  }
  const reference = decodeQqReference(value, extensions, indexes[0]!.slice(8));
  const id = createHash("sha256").update(JSON.stringify([value.id, value.author.user_openid, indexes[0]])).digest("hex");
  return { id, msgId: value.id, actor: value.author.user_openid, createdAt: Date.parse(value.timestamp), text, images,
    ...(audio === undefined ? {} : { audio }), ...(video === undefined ? {} : { video }),
    ...(reference.supported && reference.quotedText !== undefined ? { quotedText: reference.quotedText } : {}),
    supported: typeof value.content === "string"
      && (text.trim().length > 0 || images.length > 0 || audio !== undefined || video !== undefined) && Buffer.byteLength(text, "utf8") <= 32_000
      && supportedAttachments
      && reference.supported };
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
