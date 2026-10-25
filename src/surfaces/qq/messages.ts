import { randomUUID } from "node:crypto";
import type { ChannelFileMediaType } from "../bounded-local-file.js";
import type { Logger } from "pino";
import type { InteractionRequest } from "../../approval/index.js";
import { parseThreadQueueOperation, type ConversationCommandExecutor, type ConversationCommandResult, type ConversationSessionUseCases, type ConversationTurnUseCases, type ScheduledTaskConfirmation } from "../../application/index.js";
import { UserFacingError, type ConversationTarget, type OutputEvent, type UserMessageIdentity } from "../../conversation-core/index.js";
import type { ConversationActorRegistry, SurfaceAccessPolicy } from "../../policy/index.js";
import type { DeliveryCheckpoint } from "../delivery-receipt.js";
import type { SurfaceOutputPort, SurfaceDeliverySource, SurfaceNotificationDeliverySource, SurfaceScheduledTaskSubmissionContext, SurfaceAsyncAnswerSubmission, SurfaceConfigurationChange, OperationUpdateDisplay } from "../types.js";
import { formatSurfaceConfigurationChange } from "../configuration-change-format.js";
import { parseSlashCommand, isEmergencyStopCommand } from "../slash-command.js";
import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { formatConversationCommandOutcome } from "../conversation-command-outcome-format.js";
import { resolveSurfaceDelivery } from "../delivery-policy.js";
import { isSupportedPersistentOutput } from "../persistent-output.js";
import { shouldHideTurnCompleted } from "../lifecycle-presentation.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";
import { parseQqTextEvent } from "./inbound.js";
import { parseQqButtonEvent } from "./button-inbound.js";
import type { QqMessageInput } from "./message-input.js";
import { QqTaskSources, type QqTaskScope, type QqTaskTicket } from "./task-sources.js";
import { QqQueueSources, type QqQueueTicket } from "./queue-sources.js";
import { QqTextOutbox, planText } from "./outbox.js";
import { QqSendBudget } from "./send-budget.js";
import { QQ_TEXT_PART_BYTES, QqProtocolError, type QqProtocolClient, type QqTextMessage, type QqCommandKeyboard, type QqReplyAnchor } from "./protocol.js";
import { isQqLifecycleNotification, QqLifecycleNotifications, renderQqTurnCompleted } from "./lifecycle.js";
import { QqBodyStreaming } from "./streaming.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import { QqCommandMenuController } from "./command-menu-controller.js";
import { QqScheduleMenu } from "./schedule-menu.js";
import { QqPrivilegedManagementMenu } from "./privileged-management-menu.js";
import { planQqMessageMarkdown, qqLiteralMarkdown } from "./message-markdown.js";
import { QqInteractions } from "./interactions.js";
import { isQqExtensionOperation, isQqTaskCommand } from "./extension-commands.js";
import type { QqImageStore } from "./image-store.js";
import { generatedImageUnavailableText, isGeneratedImageUnavailable, isSubagentOutput, shouldDisplayOperation } from "../operation-presentation.js";
import { formatQuotedInput } from "../quoted-input.js";
import { textAttachmentBody } from "../text-attachment-store.js";
import type { QqFileInput } from "./file-input.js";
import type { QqMediaInput } from "./media-input.js";
import { videoAttachmentBody, type PreparedVideoAttachment } from "../video-attachment-store.js";
import { qqConversationActor, qqConversationRecipient } from "./addressing.js";
import { QqTaskProgress, isQqTaskProgressEvent, type QqTaskProgressEvent } from "./task-progress.js";

export interface QqMessageOptions {
  groupPairing?: { accept(input: { groupOpenId: string; memberOpenId: string; content: string; sentAtMs: number }): boolean };
  appId: string;
  access: SurfaceAccessPolicy;
  service: Pick<ConversationTurnUseCases, "submit" | "touchActivity" | "prepareAttachmentSubmission"> & Pick<ConversationSessionUseCases, "selectedWorkspaceId" | "listWorkspaces" | "status">;
  commands: ConversationCommandExecutor;
  actors: ConversationActorRegistry;
  ownsThread(target: ConversationTarget, threadId: string): boolean;
  logger: Logger;
  operationUpdateDisplay?: OperationUpdateDisplay;
  displaySettings?: import("../types.js").SurfaceMessageDisplaySettings;
  reasoningEnabled?: boolean;
  planUpdatesEnabled?: boolean;
  images?: Pick<QqImageStore, "prepare">;
  files?: Pick<QqFileInput, "prepare">;
  media?: Pick<QqMediaInput, "prepare" | "retain" | "discard">;
  autoCompactPercent?: (provider: string | null | undefined, model: string | null | undefined) => number | null;
  startupNotification?: {
    recipients(): readonly string[];
    text(target: ConversationTarget, signal: AbortSignal): Promise<string>;
  };
  configurationNotification?: {
    recipients(): readonly string[];
  };
}

const QUERY_COMMANDS = new Set(["usage", "limits", "metrics", "diff"]);
const EXTENSION_COMMANDS = new Set(["skill", "agents", "plugin", "mcp", "hooks", "release"]);

/** Owns one connection generation's input tasks and disposable source authority. */
export class QqMessages implements SurfaceOutputPort {
  readonly interactions: QqInteractions;
  private readonly lifetime = new AbortController();
  private readonly startedAt = Date.now();
  private lastWall = this.startedAt;
  private readonly dedup = new Map<string, number>();
  private readonly busy = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private configurationNotifications = 0;
  private readonly sources: QqTaskSources;
  private readonly queueSources: QqQueueSources;
  private readonly scheduledSources: QqTaskSources;
  private readonly outbox: QqTextOutbox;
  private readonly streaming: QqBodyStreaming;
  private readonly budget = new QqSendBudget();
  private readonly notifications = new QqLifecycleNotifications();
  private readonly progress: QqTaskProgress;
  private readonly observed = new WeakSet<OutputEvent>();
  private readonly menus: QqCommandMenuController;
  private readonly schedules: QqScheduleMenu;
  private readonly management: QqPrivilegedManagementMenu;
  private readonly admitted = new WeakMap<OutputEvent, SurfaceDeliverySource>();
  private readonly notificationSources = new Map<string, { source: SurfaceNotificationDeliverySource; scope: QqTaskScope; queryScope: string; until: number }>();
  private readonly replied = new WeakSet<QqMessageInput>();
  private callbackTimes: number[] = [];
  private callbackStopTimes: number[] = [];
  private readonly pendingCallbacks = new Map<string, Set<AbortController>>();
  private readonly asyncAnswers = new Map<string, { target: ConversationTarget; ticket: QqTaskTicket; remove: () => void; failed: () => Promise<void> }>();

  constructor(private readonly options: QqMessageOptions, private readonly client: QqProtocolClient) {
    this.progress = new QqTaskProgress({ reasoningEnabled: options.reasoningEnabled ?? false,
      ...(options.displaySettings ? { displaySettings: options.displaySettings } : {}),
      planUpdatesEnabled: options.planUpdatesEnabled ?? true, operationUpdates: options.operationUpdateDisplay ?? "compact" });
    this.sources = new QqTaskSources({ accountId: options.appId, isCurrent: (scope, threadId) => this.current(scope, threadId) });
    this.queueSources = new QqQueueSources({ accountId: options.appId, isCurrent: (scope, threadId) => this.current(scope, threadId) });
    this.scheduledSources = new QqTaskSources({ accountId: options.appId, isCurrent: (scope, threadId) => this.scheduledCurrent(scope, threadId) });
    this.schedules = new QqScheduleMenu({ commands: options.commands, scope: target => this.scheduleScope(target),
      allowed: (target, actorId) => this.allowed(target, actorId), signal: this.lifetime.signal });
    this.management = new QqPrivilegedManagementMenu({ commands: options.commands, scope: target => this.extensionQueryScope(target),
      allowed: (target, actorId) => this.allowed(target, actorId), signal: this.lifetime.signal });
    this.menus = new QqCommandMenuController({
      commands: options.commands,
      scope: target => this.menuScope(target),
      workspaceScope: target => this.menuWorkspaceScope(target),
      selectionScope: target => this.options.service.status(target).selectionScope,
      readyThread: target => this.readyThread(target),
      queryScope: target => this.extensionQueryScope(target),
      allowed: (target, actorId) => this.allowed(target, actorId),
      beforeMutation: (target, preserveRevert) => { this.cancelCallbacks(target); this.management.cancel(target); this.menus.cancelManagement(target); if (!preserveRevert) this.menus.cancelRevert(target); this.cancelSources(target); this.interactions.cancelTarget(target); },
      signal: this.lifetime.signal,
    });
    this.outbox = new QqTextOutbox(client, options.logger);
    this.interactions = new QqInteractions({
      logger: options.logger,
      authorize: (target, request) => this.interactionAuthorization(target, request),
      prepareAsyncAnswer: (target, request, message) => this.prepareAsyncAnswer(target, request, message),
      send: async (target, content, interactionControls, signal, current, request) => {
        const source = this.interactionReplySources.get(request);
        if (source && !(await this.deliverySource.await(source, signal))) throw new Error("QQ 交互来源未确认");
        await this.outbox.deliver({ mode: "active", recipient: qqConversationRecipient(target.conversationId), content }, {
          signal: AbortSignal.any([signal, this.lifetime.signal]), interactionControls,
          groupReply: this.groupReply(source),
          beforeSend: () => { if (!current() || source && !this.deliverySource.current(source)) throw new Error("QQ 交互授权失效"); },
          reserve: parts => this.budget.reserve(qqConversationRecipient(target.conversationId), parts, "interaction"),
        }, async () => {});
      },
    });
    this.streaming = new QqBodyStreaming(client, this.sources, this.budget,
      () => options.logger.warn({ reason: "body-stream-unconfirmed" }, "QQ 正文流未确认；最终正文仍由共享投递核对"),
      frames => options.logger.info({ frames }, "QQ 正文流结束帧与完整结果已确认"));
  }

  readonly deliverySource = {
    capture: (event: OutputEvent) => this.admitted.get(event),
    await: (reference: SurfaceDeliverySource, signal: AbortSignal) => reference.kind === "notification"
      ? Promise.resolve(!signal.aborted && this.notificationCurrent(reference)) : this.sourceRegistry(reference).awaitSource(reference, signal),
    current: (reference: SurfaceDeliverySource) => reference.kind === "notification" ? this.notificationCurrent(reference) : this.sourceRegistry(reference).isCurrent(reference),
    release: (reference: SurfaceDeliverySource): void => {
      if (reference.kind !== "notification") return;
      const entry = this.notificationSources.get(reference.sourceToken);
      if (entry && JSON.stringify(entry.source) === JSON.stringify(reference)) this.notificationSources.delete(reference.sourceToken);
    },
  };

  observeUserMessageIdentity(identity: Readonly<UserMessageIdentity>): void { this.queueSources.observeIdentity(identity); }

  observeQueueChanged(target: ConversationTarget, threadId: string): void {
    if (target.surface === "qq" && target.accountId === this.options.appId && this.readyThread(target) === threadId) {
      this.menus.invalidateQueueSelections(target);
    }
  }

  prepareScheduledTaskSubmission(context: SurfaceScheduledTaskSubmissionContext): SurfaceAsyncAnswerSubmission {
    const { target, actorId, workspaceId, workspaceCwd, threadId, runId } = context;
    if (target.surface !== "qq" || target.accountId !== this.options.appId || qqConversationActor(target.conversationId) !== actorId
      || !this.allowed(target, actorId)) {
      throw new UserFacingError("scheduled-task.forbidden", "QQ 计划任务目标未获授权。");
    }
    const reservation = this.scheduledSources.reserveScheduled({ accountId: target.accountId,
      conversationId: target.conversationId, actorId, workspaceId, workspaceCwd }, runId, threadId);
    if (reservation.kind !== "accepted") throw new UserFacingError("scheduled-task.state.invalid", "QQ 计划任务来源无法准备，请从本机运行记录核对。");
    return reservation.ticket;
  }

  async presentScheduledTaskConfirmation(target: ConversationTarget, actorId: string, preview: ScheduledTaskConfirmation): Promise<void> {
    const panel = this.schedules.present(target, actorId, preview);
    const recipient = qqConversationRecipient(target.conversationId);
    const task = this.outbox.deliver({ mode: "active", recipient, content: panel.detail ?? panel.content }, {
      interactionControls: { content: panel.content, keyboard: panel.keyboard,
        ...(panel.markdownDetail === undefined ? {} : { markdownContent: panel.markdownDetail }) },
      signal: AbortSignal.any([this.lifetime.signal, panel.signal ?? this.lifetime.signal]),
      beforeSend: () => { if (!panel.isCurrent()) throw new Error("QQ 计划任务预览授权失效"); },
      reserve: parts => this.budget.reserve(recipient, parts, "interaction"),
    }, async () => {}).then(() => { panel.delivered?.(); }).catch(error => {
      this.schedules.cancel(target); throw error;
    }).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
    await task;
  }

  private sourceRegistry(reference: { generation: string }): QqTaskSources | QqQueueSources {
    return reference.generation === this.queueSources.generation ? this.queueSources
      : reference.generation === this.scheduledSources.generation ? this.scheduledSources : this.sources;
  }

  private readonly interactionReplySources = new WeakMap<InteractionRequest, SurfaceDeliverySource>();

  private groupReply(source?: SurfaceDeliverySource): QqReplyAnchor | undefined {
    return source && source.kind !== "notification" && !source.conversationId.startsWith("c2c:")
      ? this.sourceRegistry(source).replyAnchor(source) : undefined;
  }

  private inputGroupReply(message: QqMessageInput): QqReplyAnchor | undefined {
    if (message.conversationId.startsWith("c2c:")) return undefined;
    return "kind" in message
      ? message.eventId ? { eventId: message.eventId, sourceTimestampMs: message.sentAtMs } : undefined
      : { messageId: message.id, sourceTimestampMs: message.sentAtMs };
  }

  private cancelSources(target: ConversationTarget): void {
    this.progress.cancelTarget(target);
    this.sources.cancelTarget(target);
    this.queueSources.cancelTarget(target);
    this.menus.cancelQueue(target);
    this.schedules.cancel(target);
  }

  admitLive(event: OutputEvent): void {
    if (event.target.surface !== "qq" || event.target.accountId !== this.options.appId) return;
    if (event.type === "subagent.completed") {
      if (!event.parentTurnId) return;
      const source = this.scheduledSources.capture(event.target, event.parentThreadId, event.parentTurnId)
        ?? this.queueSources.capture(event.target, event.parentThreadId, event.parentTurnId)
        ?? this.sources.capture(event.target, event.parentThreadId, event.parentTurnId);
      if (source) this.admitted.set(event, source);
      return;
    }
    if (this.supported(event) && isQqLifecycleNotification(event)
      && !(event.type === "operation.updated" && event.operation.kind !== "contextCompaction")) {
      const actorId = qqConversationActor(event.target.conversationId);
      const threadId = "threadId" in event ? event.threadId ?? null : null;
      if (!actorId || this.admitted.has(event) || (event.type === "mcp.oauth.completed" && !threadId)) return;
      const scope = this.scope(actorId, event.target.conversationId);
      if (!scope || !this.current(scope, event.type === "conversation.idle.released" ? undefined : threadId ?? undefined)) return;
      if (event.type === "conversation.idle.released" && this.options.service.status(event.target).threadId !== undefined) return;
      for (const [token, entry] of this.notificationSources) if (entry.until <= performance.now()) this.notificationSources.delete(token);
      if (this.notificationSources.size >= 128) throw new Error("QQ 通知来源容量已满");
      const identity = { kind: "notification" as const, generation: this.sources.generation, sourceToken: randomUUID(),
        accountId: event.target.accountId, conversationId: event.target.conversationId };
      const source: SurfaceNotificationDeliverySource = Object.freeze(event.type === "mcp.oauth.completed"
        ? { ...identity, eventType: event.type, serverName: event.name, threadId: threadId! }
        : { ...identity, eventType: event.type, threadId });
      this.notificationSources.set(source.sourceToken, { source, scope,
        queryScope: this.notificationScope(source, event.target), until: performance.now() + 600_000 });
      this.admitted.set(event, source);
      return;
    }
    if ((!this.supported(event) && event.type !== "turn.started") || !("threadId" in event) || !("turnId" in event)) return;
    const source = this.scheduledSources.capture(event.target, event.threadId, event.turnId)
      ?? this.queueSources.capture(event.target, event.threadId, event.turnId)
      ?? this.sources.capture(event.target, event.threadId, event.turnId);
    if (source) this.admitted.set(event, source);
  }
  observe(event: OutputEvent): void {
    if (this.observed.has(event)) return;
    this.observed.add(event);
    const source = this.admitted.get(event);
    if (source || event.type === "connection.lost" || event.type === "conversation.idle.released") this.progress.observe(event);
    if (source?.kind === "notification") return;
    if (source?.generation === this.sources.generation && event.target.conversationId.startsWith("c2c:")) {
      const streaming = this.displaySettings(event.target).streamingEnabled;
      if (event.type === "turn.started" && streaming) this.streaming.started(source);
      // Completion may supply a phase that was absent on the original deltas.
      // Always reconcile the existing Item stream, including late commentary.
      if (event.type === "text.completed" || (streaming && event.type === "text.delta" && event.phase !== "commentary")) this.streaming.observe(event, source);
    }
    if (source && event.type === "turn.completed") this.sourceRegistry(source).terminal(source);
  }
  retains(event: OutputEvent): boolean {
    return !(event.type === "turn.completed" && this.shouldSettleLiveCompletion(event))
      && event.type !== "text.delta" && this.supported(event) && this.admitted.has(event);
  }
  liveCompletionDisplay(event: Extract<OutputEvent, { type: "turn.completed" }>): "off" | "brief" | "detailed" {
    const mode = this.displaySettings(event.target).completion;
    return mode === "off" && !shouldHideTurnCompleted(event, mode) ? "detailed" : mode;
  }
  shouldSettleLiveCompletion(event: Extract<OutputEvent, { type: "turn.completed" }>): boolean {
    return this.liveCompletionDisplay(event) === "off";
  }
  async settleLiveCompletion(event: Extract<OutputEvent, { type: "turn.completed" }>, signal: AbortSignal,
    authorized: () => boolean, source?: SurfaceDeliverySource): Promise<void> {
    try {
      signal.throwIfAborted();
      const owner = source ?? this.admitted.get(event);
      if (this.lifetime.signal.aborted || !authorized() || !this.supportsDelivery(event) || !owner || owner.kind === "notification"
        || owner.accountId !== event.target.accountId || owner.conversationId !== event.target.conversationId
        || owner.threadId !== event.threadId || owner.turnId !== event.turnId || !this.sourceRegistry(owner).isCurrent(owner)) {
        throw new Error("QQ 完成收尾来源已失效");
      }
      await this.streaming.cancelTurn(event.target.conversationId, event.threadId, event.turnId);
    } finally { this.discardLiveCompletion(event); }
  }
  discardLiveCompletion(event: Extract<OutputEvent, { type: "turn.completed" }>): void {
    if (event.target.surface !== "qq" || event.target.accountId !== this.options.appId) return;
    this.streaming.discardTurn(event.target.conversationId, event.threadId, event.turnId);
  }
  async handle(event: OutputEvent, _context?: { liveAdmitted: true }, signal?: AbortSignal): Promise<void> {
    this.observe(event);
    if (event.type === "text.delta") {
      if (this.admitted.has(event) && this.displaySettings(event.target).streamingEnabled) await this.streaming.update(event, signal);
      return;
    }
    if (isQqLifecycleNotification(event) && this.supported(event) && this.admitted.get(event)?.kind === "notification") {
      const source = this.admitted.get(event)!;
      try {
        await this.deliverNotification(event, signal ?? this.lifetime.signal, async () => {},
          () => this.deliverySource.current(source));
      } finally { this.deliverySource.release(source); }
      return;
    }
    if (this.supported(event)) throw new Error("QQ 任务结果必须通过共享持久投递");
  }
  async deliverSnapshot(event: OutputEvent, signal: AbortSignal, authorized: () => boolean): Promise<void> {
    if (isQqTaskProgressEvent(event) && this.supported(event)) {
      await this.deliverProgress(event, signal, async () => {}, authorized, this.admitted.get(event));
      return;
    }
    if (!this.supported(event) || !isQqLifecycleNotification(event)) throw new Error("QQ 状态类型不受支持");
    const source = this.admitted.get(event);
    try { await this.deliverNotification(event, signal, async () => {}, authorized); }
    finally { if (source) this.deliverySource.release(source); }
  }
  private async deliverProgress(event: QqTaskProgressEvent, signal: AbortSignal,
    checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized: () => boolean, source?: SurfaceDeliverySource, retained = false): Promise<void> {
    if (signal.aborted || !authorized()) throw new Error("QQ 过程通知来源已失效");
    const run = this.progress.prepare(event, retained);
    if (!run) {
      if (retained) throw new Error("QQ 持久过程结果没有可发送表示");
      return;
    }
    const threadId = event.type === "subagent.completed" ? event.parentThreadId : event.threadId;
    const turnId = event.type === "subagent.completed" ? event.parentTurnId : event.turnId;
    if (!threadId || !turnId) throw new Error("QQ 过程通知缺少原任务来源");
    const recipient = qqConversationRecipient(event.target.conversationId);
    await run(async presentation => {
      await this.outbox.deliver({ mode: "active", recipient, content: presentation.text }, {
        signal: AbortSignal.any([signal, this.lifetime.signal]), preferMarkdown: true, markdownContent: presentation.markdown,
        groupReply: this.groupReply(source),
        beforeSend: () => { if (!authorized()) throw new Error("QQ 过程通知来源已失效"); },
        reserve: parts => this.budget.reserve(recipient, parts,
          { key: JSON.stringify([event.target.conversationId, threadId, turnId]), status: false, progress: true }),
      }, checkpoint);
    });
  }
  private async deliverNotification(event: Parameters<QqLifecycleNotifications["render"]>[0], signal: AbortSignal,
    checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized: () => boolean, retained = false): Promise<void> {
    const content = this.notifications.render(event, retained);
    if (content === null) return;
    const recipient = qqConversationRecipient(event.target.conversationId);
    await this.outbox.deliver({ mode: "active", recipient, content }, {
      signal: AbortSignal.any([signal, this.lifetime.signal]), preferMarkdown: true,
      beforeSend: () => { if (!authorized()) throw new Error("QQ 通知授权失效"); },
      reserve: parts => this.budget.reserve(recipient, parts, "interaction"),
    }, checkpoint);
  }
  async deliver(event: OutputEvent, signal: AbortSignal, checkpoint: (value: DeliveryCheckpoint) => Promise<void>, authorized?: () => boolean, source?: SurfaceDeliverySource, context?: { completion: "brief" | "detailed" }): Promise<void> {
    if (!isSupportedPersistentOutput(event) || !this.supportsDelivery(event) || !authorized) throw new Error("QQ 输出未获授权或类型不受支持");
    // The classifier selects only some operation updates; its false branch does
    // not exclude image delivery or compaction from the OutputEvent union.
    const progressEvent = isQqTaskProgressEvent(event) ? event : undefined;
    if (progressEvent) {
      await this.deliverProgress(progressEvent, signal, checkpoint, authorized, source, true);
      return;
    }
    if (isQqLifecycleNotification(event) && !(event.type === "operation.updated" && event.operation.kind !== "contextCompaction")) {
      await this.deliverNotification(event, signal, checkpoint, authorized, true);
      return;
    }
    if (event.type === "operation.updated" && event.operation.kind === "imageGeneration") {
      const recipient = qqConversationRecipient(event.target.conversationId);
      const beforeSend = (): undefined => { if (authorized() !== true) throw new Error("QQ 图片授权失效"); };
      const bounded = AbortSignal.any([signal, this.lifetime.signal]);
      const reserve = () => this.budget.reserve(recipient, 1,
        { key: JSON.stringify([event.target.conversationId, event.threadId, event.turnId]), status: false });
      if (isGeneratedImageUnavailable(event.operation)) {
        await this.outbox.deliver({ mode: "active", recipient, content: generatedImageUnavailableText },
          { signal: bounded, beforeSend, reserve, groupReply: this.groupReply(source) }, checkpoint);
      } else if (event.operation.imagePath) {
        await this.outbox.deliverImage(recipient, event.operation.imagePath, { signal: bounded, beforeSend, reserve, groupReply: this.groupReply(source) }, checkpoint);
      } else throw new Error("QQ 图片结果缺少内容");
      return;
    }
    if (event.type !== "text.completed" && event.type !== "turn.completed") throw new Error("QQ 输出类型不受支持");
    // Durable events are decoded/enriched copies. Resolve the original owner
    // passed by dispatch, never WeakMap identity or the latest input in a Turn.
    if (source && (source.kind === "notification" || source.accountId !== event.target.accountId
      || source.conversationId !== event.target.conversationId || source.threadId !== event.threadId
      || source.turnId !== event.turnId || !this.sourceRegistry(source).isCurrent(source))) {
      throw new Error("QQ 引用来源与输出不匹配");
    }
    const referenceMessageId = source ? this.sourceRegistry(source).replyReference(source) : undefined;
    const completion = event.type === "turn.completed"
      ? renderQqTurnCompleted(event, this.displaySettings(event.target).presentationDetail === "detailed", this.options.autoCompactPercent, context?.completion ?? "detailed") : undefined;
    let text = event.type === "text.completed" ? event.text : completion!.text;
    let markdownStart: number | undefined;
    let checkpointFailed = false;
    const record = async (value: DeliveryCheckpoint) => {
      try { await checkpoint(value); }
      catch (error) { checkpointFailed = true; throw error; }
    };
    try {
      if (event.type === "text.completed") {
        const result = await this.streaming.finish(event, signal, record, authorized);
        if (result.kind === "complete") return;
        if (result.kind === "continue") { text = result.text; markdownStart = result.markdownStart; }
      }
      // Preselect the complete plan. A continuation's partial first block stays
      // literal; later full blocks may resume Markdown without changing old text.
      await this.outbox.deliver({ mode: "active", recipient: qqConversationRecipient(event.target.conversationId), content: text,
        ...(referenceMessageId === undefined ? {} : { referenceMessageId }) }, {
        signal: AbortSignal.any([signal, this.lifetime.signal]),
        groupReply: this.groupReply(source),
        preferMarkdown: true,
        ...(completion ? { markdownContent: completion.markdown } : {}),
        ...(markdownStart !== undefined ? { markdownStart } : {}),
        allowResultFile: event.type === "text.completed" && (event.phase !== "commentary" || markdownStart !== undefined),
        beforeSend: () => { if (authorized() !== true) throw new Error("QQ 输出授权失效"); },
        reserve: parts => this.budget.reserve(qqConversationRecipient(event.target.conversationId), parts,
          { key: JSON.stringify([event.target.conversationId, event.threadId, event.turnId]), status: event.type === "turn.completed",
            progress: event.type === "text.completed" && event.phase === "commentary" }),
      }, record);
    } catch (error) {
      if (event.type === "text.completed" && event.phase !== "commentary" && !checkpointFailed && !signal.aborted && authorized()) {
        try {
          await this.outbox.deliver({ mode: "active", recipient: qqConversationRecipient(event.target.conversationId),
            content: "正文未完整送达或发送结果未确认；这不等于任务执行失败。请在本机 WebUI 投递箱核对，完整内容可在原生 Codex 会话查看。人工重试可能重复已收到的内容。" }, {
            signal: AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(10_000)]),
            groupReply: this.groupReply(source),
            preferMarkdown: true,
            beforeSend: () => { if (authorized() !== true) throw new Error("QQ 输出授权失效"); },
            reserve: parts => this.budget.reserve(qqConversationRecipient(event.target.conversationId), parts,
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

  deliverConfigurationChange(change: SurfaceConfigurationChange): Promise<void> {
    // Capture before returning: bootstrap restores the restart intersection as
    // soon as configurationChanged returns, before any asynchronous send runs.
    const recipients = [...new Set(this.options.configurationNotification?.recipients() ?? [])];
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("QQ 配置通知代次已关闭"));
    if (!recipients.length) return Promise.resolve();
    if (this.configurationNotifications >= 8) return Promise.reject(new Error("QQ 配置通知容量已满"));
    const content = formatSurfaceConfigurationChange(change, "qq");
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(60_000)]);
    this.configurationNotifications++;
    const task = (async () => {
      let failed = false;
      for (const actorId of recipients) {
        signal.throwIfAborted();
        try {
          await this.outbox.deliver({ mode: "active", recipient: actorId, content }, {
            signal, preferMarkdown: true,
            beforeSend: () => {
              if (!this.allowed(this.target(actorId), actorId)) throw new Error("QQ 配置通知授权失效");
            },
            reserve: parts => this.budget.reserve(actorId, parts, "interaction"),
          }, async () => {});
        } catch {
          failed = true;
          if (signal.aborted) throw new Error("QQ 配置通知已取消");
          this.options.logger.warn({ reason: "configuration-notification-unconfirmed" }, "QQ 配置通知未完整确认，不自动重试");
        }
      }
      if (failed) throw new Error("QQ 配置通知未全部确认");
    })().finally(() => {
      this.configurationNotifications--;
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return task;
  }

  async sendChannelImage(conversationId: string, imagePath: string, isCurrent: () => boolean, signal?: AbortSignal, format?: "markdown"): Promise<void> {
    const actorId = qqConversationActor(conversationId);
    if (!actorId) throw new Error("QQ 图片目标不受支持");
    const recipient = qqConversationRecipient(conversationId);
    const scope = this.scope(actorId, conversationId);
    if (!scope || !this.current(scope) || isCurrent() !== true) throw new Error("QQ 图片目标未获授权");
    const target = this.target(actorId, conversationId);
    const context = this.extensionQueryScope(target);
    await this.outbox.deliverImage(recipient, imagePath, { signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
      beforeSend: () => { if (isCurrent() !== true || !this.current(scope) || this.extensionQueryScope(target) !== context) throw new Error("QQ 图片目标已变化"); },
      reserve: () => this.budget.reserve(recipient, 1, "interaction", format === "markdown" ? 120_000 : 45_000),
    }, async () => {}, format);
  }

  async sendChannelFile(conversationId: string, filePath: string, fileName: string, isCurrent: () => boolean, mediaType?: ChannelFileMediaType, signal?: AbortSignal): Promise<void> {
    const actorId = qqConversationActor(conversationId);
    if (!actorId) throw new Error("QQ 文件目标不受支持");
    const recipient = qqConversationRecipient(conversationId);
    const scope = this.scope(actorId, conversationId);
    if (!scope || !this.current(scope) || isCurrent() !== true) throw new Error("QQ 文件目标未获授权");
    const target = this.target(actorId, conversationId);
    const context = this.extensionQueryScope(target);
    await this.outbox.deliverFile(recipient, filePath, fileName, { signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
      beforeSend: () => { if (isCurrent() !== true || !this.current(scope) || this.extensionQueryScope(target) !== context) throw new Error("QQ 文件目标已变化"); },
      reserve: () => this.budget.reserve(recipient, 1, "interaction", 120_000),
    }, async () => {}, mediaType);
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
    // Pairing is local operator discovery only, never conversation permission.
    // Reserve the command even outside an active pairing to prevent replay as a task.
    const message = parsed.message;
    if (!message.conversationId.startsWith("c2c:") && /^\/qq-pair(?:\s|$)/u.test(message.content.trim())) {
      const recipient = qqConversationRecipient(message.conversationId);
      if (typeof recipient !== "string" && !message.images?.length && !message.file && !message.media && message.quotedText === undefined) {
        this.options.groupPairing?.accept({ groupOpenId: recipient.groupOpenId, memberOpenId: message.actorId,
          content: message.content.trim(), sentAtMs: message.sentAtMs });
      }
      return;
    }
    this.admit(message);
  }

  private admit(message: QqMessageInput): void {
    const target = this.target(message.actorId, message.conversationId);
    if (!this.options.access.isAllowed({ target, actorId: message.actorId })) return;
    const now = Date.now();
    if (now < this.lastWall) { this.lastWall = Infinity; return; }
    this.lastWall = now;
    if (message.sentAtMs < this.startedAt || message.sentAtMs > now || now - message.sentAtMs > 60_000) return;
    for (const [key, until] of this.dedup) if (until <= performance.now()) this.dedup.delete(key);
    const callback = "kind" in message;
    const key = JSON.stringify([target.conversationId, callback ? "interaction" : "text", message.actorId, message.id,
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

  private async executeQueue(message: QqMessageInput, target: ConversationTarget, input: string, guard: () => void): Promise<ConversationCommandResult> {
    const operation = parseThreadQueueOperation(input);
    const scope = this.scope(message.actorId, target.conversationId);
    const context = this.extensionQueryScope(target);
    let ticket: QqQueueTicket | undefined;
    const observed: { attempted: boolean; outcome?: "not-submitted" | "confirmed" | "unknown" } = { attempted: false };
    const assertCurrent = () => {
      guard();
      if (!scope || !this.current(scope) || this.extensionQueryScope(target) !== context
        || ticket && !ticket.isCurrent()) throw new UserFacingError("command.selection.expired", "队列操作已取消或上下文变化，请重新打开 Queue。");
    };
    assertCurrent();
    if (operation.type === "add" || operation.type === "start") {
      const reserved = this.queueSources.reserve(scope!, message);
      if (reserved.kind !== "accepted") throw new UserFacingError("queue.failed", "当前队列输入无法接纳，请核对状态后重试。");
      ticket = reserved.ticket;
    }
    try {
      return await this.options.commands.execute(target, "queue", input, message.actorId, assertCurrent, undefined, {
        ...(ticket ? { submission: {
          prepared: ticket.observer.prepared,
          requestAttempted: () => { observed.attempted = true; return ticket.observer.requestAttempted(); },
          confirmed: ticket.observer.confirmed,
          settled: value => { observed.outcome = value.outcome; return ticket.observer.settled(value); },
        } } : {}),
        deleted: value => {
          assertCurrent();
          this.queueSources.deleted(value.threadId, value.queuedSubmissionId);
        },
      });
    } catch (error) {
      ticket?.cancel();
      if (observed.attempted && observed.outcome !== "confirmed" && observed.outcome !== "not-submitted"
        && (!(error instanceof UserFacingError) || error.code === "queue.failed")) {
        throw new UserFacingError("queue.failed", "Queue 提交结果未确认", { reason: "submission-unconfirmed" });
      }
      throw error;
    }
  }

  private async process(message: QqMessageInput, target: ConversationTarget, ownsBusy = false): Promise<void> {
    const images = "images" in message ? message.images : undefined;
    const file = "file" in message ? message.file : undefined;
    const media = "media" in message ? message.media : undefined;
    if ((images?.length || file || media) && message.content.trimStart().startsWith("/")) {
      await this.reply(message, "附件消息不执行斜杠命令或交互回答，请单独发送命令；附件可附上普通文字需求。", () => this.allowed(target, message.actorId));
      return;
    }
    // Response tokens remain usable while ordinary submit is preparing. They
    // never enter task submission, including unknown tokens after restart.
    const response = media ? undefined : this.interactions.respond(target, message);
    if (response !== undefined) {
      await this.reply(message, response, () => this.allowed(target, message.actorId));
      return;
    }
    let command: ReturnType<typeof parseSlashCommand>;
    try { command = media ? null : parseSlashCommand(message.content); }
    catch { await this.reply(message, "命令格式不受支持。使用 /help 查看 QQ 命令。", () => this.allowed(target, message.actorId)); return; }
    const stop = command?.name === "stop" && !command.argumentsText;
    if (stop) { this.cancelCallbacks(target); this.management.cancel(target); this.menus.cancelRevert(target); this.menus.cancelManagement(target); this.cancelSources(target); this.interactions.cancelTarget(target); }
    if (this.busy.has(target.conversationId) && !stop && !ownsBusy) {
      await this.reply(message, "上一条输入仍在处理中，请稍后重试；/stop 可取消当前准备和任务。", () => this.allowed(target, message.actorId)); return;
    }
    if (!stop && !ownsBusy) this.busy.add(target.conversationId);
    let stage: "command" | "render" | "reply" | "submit" = "command";
    let commandTicket: QqTaskTicket | undefined;
    try {
      if (command) {
        if (command.name === "release" || command.name === "limits" && command.argumentsText.trim()) {
          const panel = await this.management.open(target, message.actorId, command.name, command.argumentsText);
          stage = "reply";
          try {
            await this.reply(message, panel.content, () => this.allowed(target, message.actorId) && panel.isCurrent(),
              undefined, panel.keyboard, panel.detail, panel.markdownDetail, panel.signal);
          } catch (error) { this.management.cancel(target); throw error; }
          panel.delivered?.();
          return;
        }
        if (command.name === "schedule" || command.name === "help" && command.argumentsText.trim() === "schedule") {
          const panel = await this.schedules.open(target, message.actorId, command.name === "schedule" ? command.argumentsText : "");
          stage = "reply";
          try {
            await this.reply(message, panel.content, () => this.allowed(target, message.actorId) && panel.isCurrent(),
              undefined, panel.keyboard, panel.detail, panel.markdownDetail, panel.signal);
          } catch (error) { this.schedules.cancel(target); throw error; }
          panel.delivered?.();
          return;
        }
        if (command.name === "queue") {
          const fixed = this.extensionQueryScope(target);
          const guard = () => {
            if (!this.allowed(target, message.actorId) || this.extensionQueryScope(target) !== fixed) {
              throw new UserFacingError("command.selection.expired", "队列上下文已变化，请重新打开 Queue。");
            }
          };
          const result = await this.executeQueue(message, target, command.argumentsText, guard);
          guard();
          const menu = this.menus.fromResult(target, message.actorId, result);
          stage = "reply";
          const current = () => {
            try { guard(); return !menu || menu.isCurrent(); } catch { return false; }
          };
          if (menu) {
            await this.reply(message, menu.content, current, undefined, menu.keyboard, menu.detail, menu.markdownDetail);
            menu.delivered?.();
          } else {
            const text = result.kind === "outcome" ? formatConversationCommandOutcome(result.outcome) : renderConversationCommandResult(result);
            if (!text) throw new Error("QQ Queue 没有可交付结果");
            await this.reply(message, text, current);
          }
          return;
        }
        const taskCommand = isQqTaskCommand(command.name, command.argumentsText);
        if (!["help", "status", "stop", "workspace", "model", "new", "sessions", "resume", "rename", "archived", "archive", "unarchive", "pin", "unpin", "compact", "fork", "revert", "review", "effort", "fast", "plan", "goal", "permissions", "autoreview", "whoami", ...QUERY_COMMANDS, ...EXTENSION_COMMANDS].includes(command.name)
          || (["status", "stop", "new", "usage", "limits", "diff", "archive", "pin", "unpin", "compact", "fork", "permissions", "whoami"].includes(command.name) && command.argumentsText.trim())
          || (command.name === "goal" && !["", "clear"].includes(command.argumentsText.trim()))
          || (EXTENSION_COMMANDS.has(command.name) && command.name !== "hooks" && !taskCommand && !isQqExtensionOperation(command.name, command.argumentsText))) {
          await this.reply(message, "QQ 暂不支持此命令或参数。使用 /help 查看支持范围。", () => this.allowed(target, message.actorId)); return;
        }
        if (command.name === "whoami") {
          const identity = message.actorId.length > 8 ? `${message.actorId.slice(0, 4)}…${message.actorId.slice(-4)}` : "已隐藏";
          await this.reply(message, `## QQ 身份\n- App ID：${this.options.appId}\n- OpenID（脱敏）：${identity}\n\nOpenID 是当前应用下的身份标识，不是 QQ 号码。`, () => this.allowed(target, message.actorId));
          return;
        }
        if (command.name === "help" || command.name === "revert" || command.name === "hooks") {
          const menu = await (command.name === "help" ? this.menus.open(target, message.actorId, command.argumentsText,
            (input, guard) => this.executeQueue(message, target, input, guard))
            : command.name === "hooks" ? this.menus.hooks(target, message.actorId, command.argumentsText)
            : this.menus.revert(target, message.actorId, command.argumentsText));
          stage = "reply";
          await this.reply(message, menu.content, () => this.allowed(target, message.actorId) && menu.isCurrent(), undefined, menu.keyboard, menu.detail, menu.markdownDetail);
          menu.delivered?.();
          return;
        }
        if (((command.name === "workspace" || command.name === "model" || command.name === "resume" || command.name === "unarchive") && command.argumentsText.trim()) || command.name === "new" || command.name === "archive" || command.name === "fork") {
          this.cancelCallbacks(target); this.management.cancel(target); this.menus.cancelRevert(target); this.menus.cancelManagement(target); this.cancelSources(target); this.interactions.cancelTarget(target);
        }
        const commandScope = this.scope(message.actorId, target.conversationId);
        if (taskCommand) {
          if (!commandScope) { await this.reply(message, "请先用 /workspace 选择已配置的工作区。", () => this.allowed(target, message.actorId)); return; }
          const reservation = this.sources.reserve(commandScope, message);
          if (reservation.kind !== "accepted") { await this.reply(message, "当前输入无法接纳，请稍后核对任务状态再重试。", () => this.current(commandScope)); return; }
          commandTicket = reservation.ticket;
        }
        const extensionScope = !taskCommand && EXTENSION_COMMANDS.has(command.name) ? this.extensionQueryScope(target) : undefined;
        const hasSelectionMenu = extensionScope !== undefined || ["status", "limits", "workspace", "model", "sessions", "resume", "archived", "effort", "fast", "autoreview", "goal"].includes(command.name);
        const menuScope = hasSelectionMenu ? this.menuScope(target) : undefined;
        const menuWorkspaceScope = hasSelectionMenu ? this.menuWorkspaceScope(target) : undefined;
        const queryStatus = QUERY_COMMANDS.has(command.name) ? this.options.service.status(target) : undefined;
        const queryCurrent = () => {
          if (!queryStatus) return true;
          const current = this.options.service.status(target);
          return current.threadId === queryStatus.threadId
            && (command.name !== "usage" && command.name !== "limits"
              || current.modelProvider === queryStatus.modelProvider && !current.sessionRestoring);
        };
        const fixedScope = !taskCommand && ["effort", "fast", "plan", "goal", "permissions", "autoreview"].includes(command.name) ? this.menuScope(target) : undefined;
        const goalThread = command.name === "goal" ? this.readyThread(target) : undefined;
        if (command.name === "goal" && !goalThread) {
          await this.reply(message, "请先选择并等待当前会话恢复完成，再查询或清除目标。QQ 暂不支持创建目标。", () => this.allowed(target, message.actorId));
          return;
        }
        const assertCurrent = () => {
          if (commandTicket && !commandTicket.isCurrent()) throw new UserFacingError("command.selection.expired", "任务准备已取消、过期或失权，请核对任务状态。");
          if (extensionScope !== undefined && this.extensionQueryScope(target) !== extensionScope) throw new UserFacingError("command.selection.expired", "查询上下文已变化，请重新打开扩展查询。");
          if (fixedScope !== undefined && this.menuScope(target) !== fixedScope
            || goalThread !== undefined && this.readyThread(target) !== goalThread) throw new UserFacingError("command.selection.expired", "菜单已失效，请重新发送 /help 打开菜单。");
        };
        const result = await this.options.commands.execute(target, command.name as "status" | "stop" | "workspace" | "model" | "new" | "sessions" | "resume" | "rename" | "archived" | "archive" | "unarchive" | "pin" | "unpin" | "compact" | "fork" | "review" | "usage" | "limits" | "metrics" | "diff" | "effort" | "fast" | "plan" | "goal" | "permissions" | "autoreview" | "skill" | "agents" | "plugin" | "mcp" | "hooks" | "release", command.argumentsText, message.actorId, assertCurrent, commandTicket?.observer);
        const sessionReplyScope = taskCommand || ["rename", "archive", "unarchive", "pin", "unpin", "compact", "fork"].includes(command.name)
          ? this.menuScope(target) : undefined;
        stage = "render";
        const scope = command.name === "workspace" && command.argumentsText.trim() ? this.scope(message.actorId, target.conversationId) : commandScope;
        let menu = taskCommand ? undefined : this.menus.fromResult(target, message.actorId, result);
        if (menu && QUERY_COMMANDS.has(command.name)) {
          // Adding buttons must preserve the original query's complete-result
          // budget and oversized notice, including passive reply limits.
          try {
            const query = renderConversationCommandResult(result)!;
            const queryParts = planText("kind" in message || !message.conversationId.startsWith("c2c:")
              ? { mode: "active", recipient: qqConversationRecipient(message.conversationId), content: query }
              : { mode: "passive", recipient: qqConversationRecipient(message.conversationId), content: query,
                messageId: message.id, sequence: 1, sourceTimestampMs: message.sentAtMs });
            if (!message.conversationId.startsWith("c2c:") && queryParts.length > 5) throw new QqProtocolError("message", "invalid-input");
            if (planText({ mode: "active", recipient: qqConversationRecipient(message.conversationId),
              content: menu.detail ?? menu.content }).length > (message.conversationId.startsWith("c2c:") ? 7 : 4)) menu = undefined;
          } catch (error) {
            if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input") throw error;
            menu = undefined;
          }
        }
        if (menu) {
          const panel = menu;
          stage = "reply";
          await this.reply(message, panel.content, () => {
            const sameContext = result.kind === "models" && command.argumentsText.trim()
              ? this.menuWorkspaceScope(target) === menuWorkspaceScope && !!result.state.selectionScope
                && result.state.selectionScope === this.options.service.status(target).selectionScope
              : this.menuScope(target) === menuScope;
            return sameContext && panel.isCurrent() && queryCurrent() && this.allowed(target, message.actorId)
              && (extensionScope === undefined || this.extensionQueryScope(target) === extensionScope);
          }, undefined, panel.keyboard, panel.detail, panel.markdownDetail);
          panel.delivered?.();
          return;
        }
        const text = result.kind === "collaboration-mode" ? `协作模式：${result.state.mode === "plan" ? "Plan" : "Default"}${result.state.pending ? "（下一次 Turn 生效）" : ""}\n下一条普通消息按此模式处理；再次发送 /plan 可切换模式。`
          : result.kind === "outcome" && result.outcome.type === "goal.cleared" ? "已清除当前会话目标。清除不等于停止正在运行的任务；如需停止，请使用 /stop。"
          : result.kind === "outcome" ? formatConversationCommandOutcome(result.outcome)
          : renderConversationCommandResult(result);
        if (!text) throw new Error("QQ 命令没有可交付结果");
        stage = "reply";
        await this.reply(message, text, () => {
          if (!scope || !this.current(scope)) return false;
          if (commandTicket?.signal.aborted) return false;
          if (fixedScope !== undefined && this.menuScope(target) !== fixedScope
            || goalThread !== undefined && this.readyThread(target) !== goalThread) return false;
          if (sessionReplyScope !== undefined && this.menuScope(target) !== sessionReplyScope) return false;
          if (result.kind === "outcome" && result.outcome.type === "thread.forked"
            && this.options.service.status(target).threadId !== result.outcome.threadId) return false;
          return queryCurrent();
        }, QUERY_COMMANDS.has(command.name)
          ? command.name === "diff" ? "Diff 无法在本次 QQ 回复中完整展示，本次仅发送此提示。请在原生 Codex 会话查看。"
            : "查询结果无法在本次 QQ 回复中完整展示，本次仅发送此提示。统计可缩小 /metrics 查询范围，或在本机 WebUI 查看；账户信息也可从其他已接入渠道查询。"
          : undefined, undefined, undefined, undefined, undefined, result.kind === "artifacts");
        return;
      }
      if ("kind" in message) {
        await this.reply(message, "此按钮操作不受支持，请重新打开 /help。", () => this.allowed(target, message.actorId));
        return;
      }
      const scope = this.scope(message.actorId, target.conversationId);
      if (!scope) { await this.reply(message, "请先用 /workspace 选择已配置的工作区。", () => this.allowed(target, message.actorId)); return; }
      const reservation = this.sources.reserve(scope, message, media ? 120_000 : 30_000);
      if (reservation.kind !== "accepted") { await this.reply(message, "当前输入无法接纳，请稍后核对任务状态再重试。", () => this.current(scope)); return; }
      const { ticket } = reservation;
      stage = "submit";
      try {
        this.options.service.touchActivity?.(target);
        if (media) {
          const prepare = this.options.service.prepareAttachmentSubmission;
          if (!prepare) throw new UserFacingError("input.authorization-changed", "音视频提交准备不可用");
          const prepared = prepare.call(this.options.service, target, () => ticket.isCurrent(), media.kind === "voice" ? "audio" : "video", ticket.observer);
          let video: PreparedVideoAttachment | undefined;
          try {
            // QQ ordinary input has no outer batching wait. Capture synchronously
            // before initialization, download or any other asynchronous boundary.
            prepared.captureTarget();
            const signal = AbortSignal.any([ticket.signal, prepared.signal, this.lifetime.signal]);
            const assertCurrent = () => {
              signal.throwIfAborted();
              if (!ticket.isCurrent()) throw new UserFacingError("input.authorization-changed", "音视频准备已取消或失权");
            };
            assertCurrent();
            if (media.kind === "voice" && media.referenceText) {
              await prepared.submit(formatQuotedInput([message.content, media.referenceText].filter(Boolean).join("\n\n"), message.quotedText));
            } else {
              if (!this.options.media) throw new UserFacingError("input.authorization-changed", "音视频准备不可用");
              const file = await this.options.media.prepare(media, { target, actorId: message.actorId }, signal, assertCurrent);
              if ("attachment" in file) {
                video = file;
                assertCurrent();
                await prepared.submit(formatQuotedInput([message.content, videoAttachmentBody(file)].filter(Boolean).join("\n\n"), message.quotedText));
              } else {
                assertCurrent();
                await prepared.submit({ text: formatQuotedInput(message.content, message.quotedText), localAudios: [{ path: file.path }] });
              }
            }
          } finally {
            try {
              if (video) {
                if (prepared.mayHaveSubmitted) this.options.media!.retain(video);
                else await this.options.media!.discard(video);
              }
            } finally { prepared.dispose(); }
          }
          return;
        }
        if (!images?.length && !file) {
          await this.options.service.submit(target, formatQuotedInput(message.content, message.quotedText), () => ticket.isCurrent(), ticket.observer);
          return;
        }
        const prepare = this.options.service.prepareAttachmentSubmission;
        if (!prepare) throw new UserFacingError("input.authorization-changed", "附件提交准备不可用");
        const prepared = prepare.call(this.options.service, target, () => ticket.isCurrent(), images?.length ? "image" : "file", ticket.observer);
        try {
          prepared.captureTarget();
          const signal = AbortSignal.any([ticket.signal, prepared.signal, this.lifetime.signal]);
          const attachmentScope = this.extensionQueryScope(target);
          const assertAttachmentsCurrent = () => {
            signal.throwIfAborted();
            if (!ticket.isCurrent() || this.extensionQueryScope(target) !== attachmentScope) {
              throw new UserFacingError(file ? "input.authorization-changed" : "image.download-failed", "附件准备已取消或上下文变化");
            }
          };
          if (images?.length && !this.options.images) throw new UserFacingError("image.download-failed", "图片准备不可用");
          if (file && !this.options.files) throw new UserFacingError("attachment.download-failed", "文本附件准备不可用");
          const preparedFile = file ? await this.options.files!.prepare(file, signal, assertAttachmentsCurrent) : undefined;
          const currentText = preparedFile
            ? [message.content, `附件文件名：${JSON.stringify(preparedFile.fileName)}`, textAttachmentBody(preparedFile)].filter(Boolean).join("\n\n")
            : message.content;
          const text = formatQuotedInput(currentText, message.quotedText);
          const input = images?.length
            ? await this.options.images!.prepare(images, text, signal, assertAttachmentsCurrent) : text;
          assertAttachmentsCurrent();
          await prepared.submit(input);
        } finally { prepared.dispose(); }
      } catch (error) {
        ticket.cancel();
        const { errorType, errorCode, errorReason } = surfaceErrorMetadata(error);
        this.options.logger.warn({ reason: error instanceof UserFacingError ? error.code : "submission-unconfirmed",
          errorType, errorCode, errorReason }, "QQ 任务提交未确认");
        await this.reply(message, error instanceof UserFacingError ? media?.kind === "voice" && error.code === "audio.unsupported"
          ? "QQ 语音仅接收平台转换后的 WAV 文件，请重新发送语音或文字"
          : media?.kind === "voice" && error.code === "audio.unavailable"
            ? error.details.reason === "length-mismatch" ? "QQ 语音文件实际大小与 HTTP 声明不一致，请重新发送"
              : "QQ 语音文件准备失败、已取消或授权变化，请核对后重新发送"
            : formatSurfaceUserFacingError(error, "QQ")
          : "任务提交未确认；请用 /status 或在本机核对，勿直接重复提交。", () => this.current(scope));
      }
    } catch (error) {
      if (stage === "command") commandTicket?.cancel();
      const { errorType, errorCode, errorReason, selectionFields } = surfaceErrorMetadata(error);
      this.options.logger.warn({ reason: error instanceof UserFacingError ? error.code : "operation-unconfirmed",
        stage, emergencyStop: stop, errorType, errorCode, errorReason, selectionFields }, "QQ 操作未确认");
      await this.reply(message, error instanceof UserFacingError ? formatSurfaceUserFacingError(error, "QQ")
        : commandTicket ? "任务提交未确认；请用 /status 或在本机核对，勿直接重复提交。"
        : command?.name === "schedule" ? "计划任务操作未确认；请用 /schedule 或 /schedule runs <任务 ID> 核对，勿直接重复提交。"
        : "操作未确认。请检查 /status、工作区和模型选择；本机日志可核对受控错误。", () => this.allowed(target, message.actorId));
    } finally { if (!stop && !ownsBusy) this.busy.delete(target.conversationId); }
  }

  private async reply(message: QqMessageInput, content: string, allowed: () => boolean,
    oversizedNotice?: string, keyboard?: QqCommandKeyboard, detail?: string, markdownDetail?: string, cancellation?: AbortSignal, preserveLiteral = false): Promise<void> {
    // A send failure must not recursively send another reply with the same msg_seq.
    if (this.replied.has(message)) throw new Error("QQ 来信回复已尝试，不重复发送");
    const recipient = qqConversationRecipient(message.conversationId);
    const activeMenu = keyboard !== undefined && detail === undefined && Buffer.byteLength(content) > QQ_TEXT_PART_BYTES;
    // Group plans choose representation first; Outbox binds the original
    // passive anchor and shared sequence after the complete part count is known.
    const input: QqTextMessage = "kind" in message || typeof recipient !== "string" || detail !== undefined || activeMenu
      ? { mode: "active", recipient, content: detail ?? content }
      : { mode: "passive", recipient, content,
        messageId: message.id, sequence: 1, sourceTimestampMs: message.sentAtMs };
    if (!("kind" in message)) input.referenceMessageId = message.msgIdx;
    if (oversizedNotice) {
      try {
        const parts = planText(input);
        if (typeof recipient !== "string" && parts.length > 5) throw new QqProtocolError("message", "invalid-input");
      }
      catch (error) {
        if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input") throw error;
        input.content = oversizedNotice;
      }
    }
    this.replied.add(message);
    // Diff is source text, not authored Markdown. Only render a complete fenced
    // candidate; otherwise retain the original text without interpreting it.
    if (preserveLiteral) {
      const candidate = qqLiteralMarkdown(input.content);
      const plan = candidate === undefined ? undefined : planQqMessageMarkdown({ ...input, content: candidate });
      if (plan && plan.length <= planText(input).length) {
        input.content = candidate!;
        preserveLiteral = false;
      }
    }
    await this.outbox.deliver(input, {
      groupReply: this.inputGroupReply(message),
      ...(detail !== undefined && keyboard ? { interactionControls: { content, keyboard, ...(markdownDetail !== undefined ? { markdownContent: markdownDetail } : {}) } }
        : keyboard ? { representation: "markdown", keyboard } : { preferMarkdown: !preserveLiteral }),
      signal: cancellation ? AbortSignal.any([this.lifetime.signal, cancellation]) : this.lifetime.signal,
      beforeSend: () => { if (!allowed()) throw new Error("QQ 回复授权失效"); },
      reserve: parts => this.budget.reserve(recipient, parts, "kind" in message || detail !== undefined || activeMenu ? "interaction" : undefined),
    }, async () => {});
  }
  private target(actorId: string, conversationId = `c2c:${actorId}`): ConversationTarget { return { surface: "qq", accountId: this.options.appId, conversationId }; }
  private interactionAuthorization(target: ConversationTarget, request: InteractionRequest): (() => boolean) | undefined {
    if (target.surface !== "qq" || target.accountId !== this.options.appId) return;
    const actorId = qqConversationActor(target.conversationId);
    if (!actorId) return;
    if (request.type === "user-input" && request.expectedActorId !== undefined && request.expectedActorId !== actorId) return;
    const scope = this.scope(actorId, target.conversationId);
    if (!scope || typeof request.isCurrent !== "function") return;
    // Shared routing proves ancestry. An unbound child Thread is not itself
    // owned by the conversation, but its still-bound ancestor must be.
    const threads = request.relatedThreadIds ?? [request.threadId];
    if (!target.conversationId.startsWith("c2c:") && request.turnId) {
      const source = this.queueSources.capture(target, request.threadId, request.turnId)
        ?? this.sources.capture(target, request.threadId, request.turnId);
      if (source) this.interactionReplySources.set(request, source);
    }
    return () => this.current(scope) && request.isCurrent!() === true
      && threads.some(threadId => this.options.ownsThread(target, threadId));
  }
  private prepareAsyncAnswer(target: ConversationTarget, request: Extract<InteractionRequest, { type: "user-input" }>, message: QqMessageInput): boolean {
    const authorized = this.interactionAuthorization(target, request);
    if (!authorized?.() || this.asyncAnswers.has(request.requestId) || this.asyncAnswers.size >= 128) return false;
    const scope = this.scope(message.actorId, target.conversationId);
    if (!scope) return false;
    const reservation = this.sources.reserve(scope, message);
    if (reservation.kind !== "accepted") return false;
    const { ticket } = reservation;
    const remove = () => {
      if (this.asyncAnswers.get(request.requestId)?.ticket === ticket) this.asyncAnswers.delete(request.requestId);
    };
    const failed = async () => {
      const recipient = qqConversationRecipient(target.conversationId);
      await this.outbox.deliver({ mode: "active", recipient,
        content: "问题回答提交未确认；请用 /status 或在本机核对，勿直接重复提交。" }, {
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000)]),
        groupReply: this.inputGroupReply(message),
        beforeSend: () => { if (!authorized()) throw new Error("QQ 问题回复授权失效"); },
        reserve: parts => this.budget.reserve(recipient, parts, "interaction"),
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
  private readyThread(target: ConversationTarget): string | undefined {
    const status = this.options.service.status(target);
    return status.sessionRestoring === false ? status.threadId : undefined;
  }
  private notificationCurrent(reference: SurfaceNotificationDeliverySource): boolean {
    const entry = this.notificationSources.get(reference.sourceToken);
    if (!entry) return false;
    const target = this.target(entry.scope.actorId, entry.scope.conversationId);
    return entry.until > performance.now() && JSON.stringify(entry.source) === JSON.stringify(reference)
      && this.current(entry.scope, reference.eventType === "mcp.oauth.completed" ? reference.threadId : undefined)
      && (reference.eventType !== "conversation.idle.released" || this.options.service.status(target).threadId === undefined)
      && this.notificationScope(reference, target) === entry.queryScope;
  }
  private notificationScope(reference: SurfaceNotificationDeliverySource, target: ConversationTarget): string {
    return reference.eventType === "mcp.oauth.completed" ? this.extensionQueryScope(target) : this.menuScope(target);
  }
  private extensionQueryScope(target: ConversationTarget): string {
    const status = this.options.service.status(target);
    return JSON.stringify([this.menuScope(target), status.modelProvider, status.selectionScope, status.sessionRestoring]);
  }
  private menuWorkspaceScope(target: ConversationTarget): string {
    const workspaceId = this.options.service.selectedWorkspaceId(target);
    const workspace = this.options.service.listWorkspaces().find(value => value.id === workspaceId);
    return JSON.stringify([workspaceId, workspace?.cwd]);
  }
  private scope(actorId: string, conversationId = `c2c:${actorId}`): QqTaskScope | undefined {
    const target = this.target(actorId, conversationId);
    const workspaceId = this.options.service.selectedWorkspaceId(target);
    const workspace = this.options.service.listWorkspaces().find(value => value.id === workspaceId);
    return workspace ? { accountId: this.options.appId, actorId, conversationId: target.conversationId, workspaceId, workspaceCwd: workspace.cwd } : undefined;
  }
  private current(scope: QqTaskScope, threadId?: string): boolean {
    const current = this.scope(scope.actorId, scope.conversationId);
    return this.allowed(this.target(scope.actorId, scope.conversationId), scope.actorId) && !!current
      && current.workspaceId === scope.workspaceId && current.workspaceCwd === scope.workspaceCwd
      && (!threadId || this.options.ownsThread(this.target(scope.actorId, scope.conversationId), threadId));
  }
  private scheduledCurrent(scope: QqTaskScope, threadId?: string): boolean {
    const target = this.target(scope.actorId, scope.conversationId);
    const workspace = this.options.service.listWorkspaces().find(value => value.id === scope.workspaceId);
    return scope.accountId === this.options.appId && scope.conversationId === target.conversationId
      && this.allowed(target, scope.actorId) && workspace?.cwd === scope.workspaceCwd
      && !!threadId && this.options.ownsThread(target, threadId);
  }
  private scheduleScope(target: ConversationTarget): string {
    const status = this.options.service.status(target);
    return JSON.stringify([this.extensionQueryScope(target), status.model, status.effort, status.serviceTier,
      status.modelPending, status.effortPending, status.fastModePending, status.executionContext]);
  }
  private supported(event: OutputEvent): boolean {
    if (!this.supportsDelivery(event)) return false;
    const settings = this.displaySettings(event.target);
    if (isSubagentOutput(event) && !settings.subagentsEnabled) return false;
    if (event.type === "turn.reasoning" && !settings.reasoningEnabled) return false;
    if (event.type === "plan.updated" && !settings.planUpdatesEnabled) return false;
    if (event.type === "operation.updated" && isQqTaskProgressEvent(event)
      && !shouldDisplayOperation(event.operation, settings.operationUpdates)) return false;
    return true;
  }
  private displaySettings(target: ConversationTarget) {
    return this.options.displaySettings?.(target) ?? {
      operationUpdates: this.options.operationUpdateDisplay ?? "compact",
      planUpdatesEnabled: this.options.planUpdatesEnabled ?? true,
      reasoningEnabled: this.options.reasoningEnabled ?? false,
      completion: "detailed" as const,
      presentationDetail: "basic" as const,
      streamingEnabled: true,
      subagentsEnabled: true,
    };
  }
  private supportsDelivery(event: OutputEvent): boolean {
    return event.target.surface === "qq" && event.target.accountId === this.options.appId
      && !!qqConversationActor(event.target.conversationId) && resolveSurfaceDelivery("qq", event).disposition === "deliver";
  }
  async close(): Promise<void> {
    this.progress.close();
    this.lifetime.abort(); this.sources.close(); this.queueSources.close(); this.scheduledSources.close(); this.schedules.close(); this.management.close(); this.menus.clear(); this.notificationSources.clear();
    await Promise.all([this.interactions.close(), this.streaming.close(), this.outbox.close()]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled(this.tasks), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("QQ 输入关闭未确认")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
