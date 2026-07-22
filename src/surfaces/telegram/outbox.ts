import type { Api } from "grammy";
import type { Logger } from "pino";

import type { InteractionDecision, InteractionRequest } from "../../approval/types.js";
import type { OperationUpdate, OutputEvent } from "../../conversation-core/events.js";
import type { MessagePhase } from "../../codex-protocol/index.js";
import { BoundedAsyncQueue } from "../../event-bus/bounded-queue.js";
import { TelegramApiExecutor } from "./api-executor.js";
import { splitTelegramText } from "./format.js";

interface StreamState {
  chatId: string;
  turnKey: string;
  text: string;
  messageId: number | undefined;
  phase: MessagePhase | null | undefined;
  completed: boolean;
  timer: NodeJS.Timeout | undefined;
}

interface TypingState {
  activityKeys: Set<string>;
  timer: NodeJS.Timeout;
}

interface OperationLogState {
  chatId: string;
  turnKey: string;
  order: string[];
  records: Map<string, OperationUpdate>;
  omittedCount: number;
  messageId: number | undefined;
  timer: NodeJS.Timeout | undefined;
}

interface OperationGroup {
  record: OperationUpdate;
  count: number;
}

interface OutboxOperation {
  critical: boolean;
  run(): Promise<void>;
}

interface ChatWorker {
  queue: BoundedAsyncQueue<OutboxOperation>;
  done: Promise<void>;
}

export class TelegramOutbox {
  private readonly streams = new Map<string, StreamState>();
  private readonly operationLogs = new Map<string, OperationLogState>();
  private readonly replyToByTurn = new Map<string, number>();
  private readonly typing = new Map<string, TypingState>();
  private readonly lastTypingAt = new Map<string, number>();
  private readonly workers = new Map<string, ChatWorker>();
  private readonly approvalRequestsByOperation = new Map<string, Set<string>>();
  private readonly operationByApprovalRequest = new Map<string, string>();
  private readonly suppressedOperations = new Set<string>();
  private nextActivityId = 1;
  private closed = false;

  constructor(
    private readonly api: Api,
    private readonly logger: Logger,
    private readonly executor = new TelegramApiExecutor(logger),
  ) {}

  setTurnReplyTarget(threadId: string, turnId: string, messageId: number): void {
    if (this.closed) {
      return;
    }
    this.replyToByTurn.set(this.turnKey(threadId, turnId), messageId);
  }

  handle(event: OutputEvent): void {
    if (this.closed) {
      return;
    }
    const chatId = event.target.conversationId;
    switch (event.type) {
      case "turn.started":
        this.startTyping(chatId, this.turnActivityKey(event.threadId, event.turnId));
        return;
      case "user.message": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.enqueue(chatId, async () => {
          const messageId = await this.send(chatId, formatCliInput(event.text));
          if (messageId !== undefined) {
            this.replyToByTurn.set(turnKey, messageId);
          }
        }, true);
        return;
      }
      case "text.delta": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        const key = this.streamKey(turnKey, event.itemId);
        const existing = this.streams.get(key);
        if (!existing) {
          this.sealOperationLog(chatId, turnKey);
        }
        const state = existing ?? this.createStream(chatId, turnKey);
        state.text += event.text;
        if (event.phase !== undefined) {
          state.phase = event.phase;
        }
        this.streams.set(key, state);
        if (!state.timer) {
          state.timer = setTimeout(() => {
            state.timer = undefined;
            this.enqueue(chatId, () => this.flush(chatId, key, false), false);
          }, 1_000);
          state.timer.unref();
        }
        return;
      }
      case "text.completed": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.sealOperationLog(chatId, turnKey);
        const key = this.streamKey(turnKey, event.itemId);
        const state = this.streams.get(key) ?? this.createStream(chatId, turnKey);
        state.text = event.text;
        state.completed = true;
        if (event.phase !== undefined) {
          state.phase = event.phase;
        }
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        this.streams.set(key, state);
        this.enqueue(chatId, () => this.flush(chatId, key, true), true);
        return;
      }
      case "operation.updated": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        const operationKey = this.operationKey(turnKey, event.operation.itemId);
        if (this.suppressedOperations.has(operationKey)) {
          return;
        }
        const heldForApproval = this.approvalRequestsByOperation.has(operationKey);
        const state = this.operationLogs.get(turnKey) ?? this.createOperationLog(chatId, turnKey);
        if (!state.records.has(event.operation.itemId)) {
          state.order.push(event.operation.itemId);
          if (state.order.length > 100) {
            const removed = state.order.shift();
            if (removed) {
              state.records.delete(removed);
              state.omittedCount += 1;
            }
          }
        }
        state.records.set(event.operation.itemId, event.operation);
        if (!heldForApproval && !state.timer) {
          state.timer = setTimeout(() => {
            state.timer = undefined;
            this.enqueue(
              chatId,
              () => this.flushOperationLog(state, false),
              event.operation.status !== "running",
            );
          }, 750);
          state.timer.unref();
        }
        this.operationLogs.set(turnKey, state);
        return;
      }
      case "turn.completed": {
        const turnKey = this.turnKey(event.threadId, event.turnId);
        this.sealOperationLog(chatId, turnKey);
        const keys = this.streamKeysForTurn(event.threadId, event.turnId);
        for (const key of keys) {
          const stream = this.streams.get(key);
          if (stream?.timer) {
            clearTimeout(stream.timer);
            stream.timer = undefined;
          }
        }
        this.stopTyping(chatId, this.turnActivityKey(event.threadId, event.turnId));
        this.enqueue(chatId, async () => {
          for (const key of keys) {
            await this.flush(chatId, key, true);
          }
          const replyTo = this.replyToByTurn.get(turnKey);
          if (event.error) {
            await this.send(chatId, `Codex 任务失败：${event.error}`, replyTo);
          } else if (!new Set(["completed", "success"]).has(event.status)) {
            await this.send(chatId, `Codex 任务状态：${event.status}`, replyTo);
          }
          this.replyToByTurn.delete(turnKey);
          this.clearApprovalOperationsForTurn(turnKey);
        }, true);
        return;
      }
      case "warning":
        this.enqueue(chatId, async () => {
          await this.send(chatId, `Codex 警告：${event.message}`);
        }, true);
        return;
      case "connection.lost":
        this.clearThreadOutput(chatId, event.threadId);
        this.enqueue(chatId, async () => {
          await this.send(chatId, `Codex 警告：${event.message}`);
        }, true);
        return;
      case "thread.status":
        return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [key, state] of this.streams) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if (state.completed) {
        this.enqueue(state.chatId, () => this.flush(state.chatId, key, true), true);
      }
    }
    for (const [key, state] of this.operationLogs) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      if ([...state.records.values()].every((record) => record.status !== "running")) {
        this.operationLogs.delete(key);
        this.enqueue(state.chatId, () => this.flushOperationLog(state, true), true);
      }
    }
    for (const state of this.typing.values()) {
      clearTimeout(state.timer);
    }
    for (const worker of this.workers.values()) {
      worker.queue.close();
    }
    const workers = Promise.allSettled([...this.workers.values()].map((worker) => worker.done));
    await waitAtMost(workers, 5_000);
    this.streams.clear();
    this.operationLogs.clear();
    this.replyToByTurn.clear();
    this.typing.clear();
    this.lastTypingAt.clear();
    this.workers.clear();
    this.approvalRequestsByOperation.clear();
    this.operationByApprovalRequest.clear();
    this.suppressedOperations.clear();
  }

  showTyping(chatId: string): void {
    if (this.closed) {
      return;
    }
    const now = Date.now();
    if (now - (this.lastTypingAt.get(chatId) ?? 0) < 1_000) {
      return;
    }
    this.lastTypingAt.set(chatId, now);
    this.enqueue(chatId, async () => {
      await this.executor.call(
        { chatId, operation: "sendChatAction", critical: false },
        () => this.api.sendChatAction(chatId, "typing"),
      );
    }, false);
  }

  beginTyping(chatId: string): () => void {
    if (this.closed) {
      return () => undefined;
    }
    const activityKey = `request:${this.nextActivityId++}`;
    this.startTyping(chatId, activityKey);
    return () => this.stopTyping(chatId, activityKey);
  }

  prepareInteraction(chatId: string, request: InteractionRequest): void {
    if (this.closed) {
      return;
    }
    this.holdApprovalOperation(chatId, request);
    for (const [turnKey, state] of this.operationLogs) {
      if (state.chatId === chatId) {
        this.sealOperationLogBeforeInteraction(chatId, turnKey, state);
      }
    }
    for (const [key, state] of this.streams) {
      if (state.chatId !== chatId || !state.text.trim()) {
        continue;
      }
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      this.enqueue(chatId, () => this.flush(chatId, key, state.completed), true);
    }
  }

  finishInteraction(
    chatId: string,
    request: InteractionRequest,
    decision: InteractionDecision,
  ): void {
    if (this.closed || request.type !== "approval") {
      return;
    }
    const operationKey = this.operationByApprovalRequest.get(request.requestId);
    if (!operationKey) {
      return;
    }
    this.operationByApprovalRequest.delete(request.requestId);
    const requestIds = this.approvalRequestsByOperation.get(operationKey);
    requestIds?.delete(request.requestId);
    const rejected = decision.type !== "approval" || !decision.approved;
    const turnKey = this.turnKey(request.threadId, request.turnId);
    const state = this.operationLogs.get(turnKey);
    if (rejected) {
      this.suppressApprovalOperation(operationKey, turnKey, request.itemId, state);
    }
    if (requestIds && requestIds.size > 0) {
      return;
    }
    this.approvalRequestsByOperation.delete(operationKey);

    if (this.suppressedOperations.has(operationKey)) {
      return;
    }

    if (state?.records.has(request.itemId)) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      this.enqueue(chatId, () => this.flushOperationLog(state, false), true);
    }
  }

  runOrdered<T>(chatId: string, run: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Telegram Outbox 已关闭"));
    }
    return new Promise<T>((resolve, reject) => {
      const accepted = this.enqueue(chatId, async () => {
        try {
          resolve(await run());
        } catch (error) {
          reject(error);
        }
      }, true);
      if (!accepted) {
        reject(new Error("Telegram Outbox 已满，交互请求未入队"));
      }
    });
  }

  private enqueue(chatId: string, run: () => Promise<void>, critical: boolean): boolean {
    let worker = this.workers.get(chatId);
    if (!worker) {
      const queue = new BoundedAsyncQueue<OutboxOperation>(200);
      worker = { queue, done: this.runWorker(chatId, queue) };
      this.workers.set(chatId, worker);
    }
    const accepted = worker.queue.push({ critical, run }, critical);
    if (!accepted) {
      this.logger.warn({ chatId, critical }, "Telegram Outbox 已满，输出未入队");
    }
    return accepted;
  }

  private async runWorker(
    chatId: string,
    queue: BoundedAsyncQueue<OutboxOperation>,
  ): Promise<void> {
    while (true) {
      const operation = await queue.shift();
      if (!operation) {
        return;
      }
      try {
        await operation.run();
      } catch (error) {
        this.logger.warn(
          { error: safeErrorMessage(error), chatId, critical: operation.critical },
          "Telegram 输出失败",
        );
      }
    }
  }

  private async flush(chatId: string, key: string, final: boolean): Promise<void> {
    const state = this.streams.get(key);
    if (!state) {
      return;
    }
    if (!state.text.trim()) {
      if (final) {
        this.streams.delete(key);
      }
      return;
    }
    const text = state.text.trimEnd();
    const [first, ...rest] = splitTelegramText(text);
    if (!first) {
      return;
    }
    if (state.messageId) {
      try {
        await this.executor.call(
          { chatId, operation: "editMessageText", critical: final },
          () => this.api.editMessageText(chatId, state.messageId!, first),
        );
      } catch (error) {
        if (isMessageNotModified(error)) {
          // The authoritative final text is already visible.
        } else if (final) {
          state.messageId = await this.sendFirstChunk(chatId, state, first);
        } else {
          throw error;
        }
      }
    } else {
      state.messageId = await this.sendFirstChunk(chatId, state, first);
    }
    if (final) {
      for (const chunk of rest) {
        await this.sendMessage(chatId, chunk);
      }
      this.streams.delete(key);
    }
  }

  private createStream(chatId: string, turnKey: string): StreamState {
    return {
      chatId,
      turnKey,
      text: "",
      messageId: undefined,
      phase: undefined,
      completed: false,
      timer: undefined,
    };
  }

  private createOperationLog(chatId: string, turnKey: string): OperationLogState {
    return {
      chatId,
      turnKey,
      order: [],
      records: new Map(),
      omittedCount: 0,
      messageId: undefined,
      timer: undefined,
    };
  }

  private holdApprovalOperation(chatId: string, request: InteractionRequest): void {
    if (request.type !== "approval") {
      return;
    }
    const turnKey = this.turnKey(request.threadId, request.turnId);
    const operationKey = this.operationKey(turnKey, request.itemId);
    const requestIds = this.approvalRequestsByOperation.get(operationKey) ?? new Set<string>();
    requestIds.add(request.requestId);
    this.approvalRequestsByOperation.set(operationKey, requestIds);
    this.operationByApprovalRequest.set(request.requestId, operationKey);

    const state = this.operationLogs.get(turnKey);
    if (state?.chatId === chatId && state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  private sealOperationLogBeforeInteraction(
    chatId: string,
    turnKey: string,
    state: OperationLogState,
  ): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const heldIds = state.order.filter((itemId) => this.isOperationHeld(turnKey, itemId));
    if (heldIds.length === 0) {
      this.operationLogs.delete(turnKey);
      this.enqueue(chatId, () => this.flushOperationLog(state, true), true);
      return;
    }

    const visibleIds = state.order.filter((itemId) => !this.isOperationHeld(turnKey, itemId));
    const heldState: OperationLogState = {
      ...state,
      order: heldIds,
      records: new Map(heldIds.flatMap((itemId) => {
        const record = state.records.get(itemId);
        return record ? [[itemId, record] as const] : [];
      })),
      omittedCount: 0,
      messageId: undefined,
      timer: undefined,
    };
    this.operationLogs.set(turnKey, heldState);

    if (visibleIds.length > 0) {
      const visibleState: OperationLogState = {
        ...state,
        order: visibleIds,
        records: new Map(visibleIds.flatMap((itemId) => {
          const record = state.records.get(itemId);
          return record ? [[itemId, record] as const] : [];
        })),
        timer: undefined,
      };
      this.enqueue(chatId, () => this.flushOperationLog(visibleState, true), true);
    }
  }

  private suppressApprovalOperation(
    operationKey: string,
    turnKey: string,
    itemId: string,
    state: OperationLogState | undefined,
  ): void {
    this.suppressedOperations.add(operationKey);
    if (!state) {
      return;
    }
    state.records.delete(itemId);
    state.order = state.order.filter((candidate) => candidate !== itemId);
    if (state.records.size === 0 && state.messageId === undefined) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      this.operationLogs.delete(turnKey);
    }
  }

  private sealOperationLog(chatId: string, turnKey: string): void {
    const state = this.operationLogs.get(turnKey);
    if (!state) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.operationLogs.delete(turnKey);
    this.enqueue(chatId, () => this.flushOperationLog(state, true), true);
  }

  private async flushOperationLog(state: OperationLogState, final: boolean): Promise<void> {
    if (state.records.size === 0) {
      return;
    }
    const { chatId, turnKey } = state;
    const text = formatOperationLog(state);
    if (state.messageId) {
      try {
        await this.executor.call(
          { chatId, operation: "editMessageText", critical: final },
          () => this.api.editMessageText(
            chatId,
            state.messageId!,
            text,
            operationEditOptions(),
          ),
        );
      } catch (error) {
        if (!isMessageNotModified(error)) {
          if (!final) {
            throw error;
          }
          state.messageId = await this.sendOperationMessage(
            chatId,
            text,
            this.replyToByTurn.get(turnKey),
          );
        }
      }
    } else {
      state.messageId = await this.sendOperationMessage(
        chatId,
        text,
        this.replyToByTurn.get(turnKey),
      );
    }
    if (final && this.operationLogs.get(turnKey) === state) {
      this.operationLogs.delete(turnKey);
    }
  }

  private startTyping(chatId: string, activityKey: string): void {
    const current = this.typing.get(chatId);
    if (current) {
      current.activityKeys.add(activityKey);
      return;
    }
    const timer = setTimeout(() => this.refreshTyping(chatId), 400);
    timer.unref();
    this.typing.set(chatId, { activityKeys: new Set([activityKey]), timer });
  }

  private refreshTyping(chatId: string): void {
    const state = this.typing.get(chatId);
    if (!state || state.activityKeys.size === 0 || this.closed) {
      return;
    }
    this.showTyping(chatId);
    const timer = setTimeout(() => this.refreshTyping(chatId), 4_000);
    timer.unref();
    state.timer = timer;
  }

  private stopTyping(chatId: string, activityKey: string): void {
    const state = this.typing.get(chatId);
    if (!state) {
      return;
    }
    state.activityKeys.delete(activityKey);
    if (state.activityKeys.size === 0) {
      clearTimeout(state.timer);
      this.typing.delete(chatId);
    }
  }

  private async send(chatId: string, text: string, replyTo?: number): Promise<number | undefined> {
    let firstMessageId: number | undefined;
    for (const chunk of splitTelegramText(text)) {
      const messageId = await this.sendMessage(
        chatId,
        chunk,
        firstMessageId === undefined ? replyTo : undefined,
      );
      firstMessageId ??= messageId;
    }
    return firstMessageId;
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}:${turnId}`;
  }

  private streamKey(turnKey: string, itemId: string): string {
    return `${turnKey}:${itemId}`;
  }

  private streamKeysForTurn(threadId: string, turnId: string): string[] {
    const prefix = `${this.turnKey(threadId, turnId)}:`;
    return [...this.streams.keys()].filter((key) => key.startsWith(prefix));
  }

  private turnActivityKey(threadId: string, turnId: string): string {
    return `turn:${this.turnKey(threadId, turnId)}`;
  }

  private operationKey(turnKey: string, itemId: string): string {
    return `${turnKey}:${itemId}`;
  }

  private isOperationHeld(turnKey: string, itemId: string): boolean {
    return this.approvalRequestsByOperation.has(this.operationKey(turnKey, itemId));
  }

  private clearApprovalOperationsForTurn(turnKey: string): void {
    const prefix = `${turnKey}:`;
    for (const [requestId, operationKey] of this.operationByApprovalRequest) {
      if (operationKey.startsWith(prefix)) {
        this.operationByApprovalRequest.delete(requestId);
      }
    }
    for (const operationKey of this.approvalRequestsByOperation.keys()) {
      if (operationKey.startsWith(prefix)) {
        this.approvalRequestsByOperation.delete(operationKey);
      }
    }
    for (const operationKey of this.suppressedOperations) {
      if (operationKey.startsWith(prefix)) {
        this.suppressedOperations.delete(operationKey);
      }
    }
  }

  private async sendFirstChunk(chatId: string, state: StreamState, text: string): Promise<number> {
    const replyTo = state.phase === "commentary"
      ? undefined
      : this.replyToByTurn.get(state.turnKey);
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, replyOptions(replyTo)),
    );
    if (replyTo !== undefined) {
      this.replyToByTurn.delete(state.turnKey);
    }
    return message.message_id;
  }

  private async sendMessage(chatId: string, text: string, replyTo?: number): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, replyOptions(replyTo)),
    );
    return message.message_id;
  }

  private async sendOperationMessage(chatId: string, text: string, replyTo?: number): Promise<number> {
    const message = await this.executor.call(
      { chatId, operation: "sendMessage", critical: true },
      () => this.api.sendMessage(chatId, text, operationSendOptions(replyTo)),
    );
    return message.message_id;
  }

  private clearThreadOutput(chatId: string, threadId: string): void {
    for (const [key, stream] of this.streams) {
      if (stream.turnKey.startsWith(`${threadId}:`)) {
        if (stream.timer) {
          clearTimeout(stream.timer);
        }
        this.streams.delete(key);
      }
    }
    for (const [key, state] of this.operationLogs) {
      if (state.turnKey.startsWith(`${threadId}:`)) {
        if (state.timer) {
          clearTimeout(state.timer);
        }
        this.operationLogs.delete(key);
      }
    }
    for (const key of this.replyToByTurn.keys()) {
      if (key.startsWith(`${threadId}:`)) {
        this.replyToByTurn.delete(key);
      }
    }
    const prefix = `${threadId}:`;
    for (const [requestId, operationKey] of this.operationByApprovalRequest) {
      if (operationKey.startsWith(prefix)) {
        this.operationByApprovalRequest.delete(requestId);
      }
    }
    for (const operationKey of this.approvalRequestsByOperation.keys()) {
      if (operationKey.startsWith(prefix)) {
        this.approvalRequestsByOperation.delete(operationKey);
      }
    }
    for (const operationKey of this.suppressedOperations) {
      if (operationKey.startsWith(prefix)) {
        this.suppressedOperations.delete(operationKey);
      }
    }
    const typing = this.typing.get(chatId);
    if (typing) {
      clearTimeout(typing.timer);
      this.typing.delete(chatId);
    }
  }

}

function formatOperationLog(state: OperationLogState): string {
  const records = state.order
    .map((itemId) => state.records.get(itemId))
    .filter((record): record is OperationUpdate => record !== undefined);
  let visible = records.slice(-20);
  let omitted = state.omittedCount + records.length - visible.length;
  let text = renderOperationRecords(visible, omitted);
  while (Array.from(text).length > 3_900 && visible.length > 1) {
    visible = visible.slice(1);
    omitted += 1;
    text = renderOperationRecords(visible, omitted);
  }
  return text;
}

function renderOperationRecords(records: OperationUpdate[], omitted: number): string {
  const lines = ["<b>操作过程</b>"];
  if (omitted > 0) {
    lines.push("", `<i>已省略较早的 ${omitted} 项操作</i>`);
  }
  for (const { record, count } of groupOperations(records)) {
    const countLabel = count > 1 ? ` (×${count})` : "";
    lines.push("", `${operationIcon(record)} <b>${operationTitle(record)}${countLabel}</b>`);
    if (record.detail) {
      const detail = escapeTelegramHtml(
        record.detail.replaceAll("[REDACTED]", "[已隐藏]"),
      );
      lines.push(record.kind === "command"
        ? `<pre><code class="language-shell">${detail}</code></pre>`
        : `<blockquote>${detail}</blockquote>`);
    }
  }
  return lines.join("\n");
}

function groupOperations(records: OperationUpdate[]): OperationGroup[] {
  const groups: OperationGroup[] = [];
  for (const record of records) {
    const previous = groups.at(-1);
    if (previous && operationGroupKey(previous.record) === operationGroupKey(record)) {
      previous.count += 1;
      previous.record = record;
    } else {
      groups.push({ record, count: 1 });
    }
  }
  return groups;
}

function operationGroupKey(record: OperationUpdate): string {
  return JSON.stringify([
    record.kind,
    record.action ?? null,
    record.detail ?? null,
    record.status,
  ]);
}

function operationIcon(record: OperationUpdate): string {
  const icon = ({
    command: "💻",
    fileChange: "🔧",
    mcpTool: "🔌",
    dynamicTool: "🧰",
    subagent: "🤖",
    webSearch: "🌐",
    imageView: "🖼️",
    imageGeneration: "🎨",
    sleep: "⏳",
    plan: "📋",
    contextCompaction: "🗜️",
    reviewMode: "🔍",
  } as const)[record.kind];
  const statusIcon = ({
    running: "⏳",
    completed: "",
    failed: "❌",
    declined: "🚫",
  } as const)[record.status];
  return statusIcon ? `${icon} ${statusIcon}` : icon;
}

function operationTitle(record: OperationUpdate): string {
  switch (record.kind) {
    case "command":
      return "运行命令";
    case "fileChange":
      return "修改文件";
    case "mcpTool":
      return "调用 MCP 工具";
    case "dynamicTool":
      return "调用工具";
    case "subagent":
      return ({
        spawnAgent: "启动子代理",
        sendInput: "向子代理发送任务",
        resumeAgent: "恢复子代理",
        wait: "等待子代理",
        closeAgent: "关闭子代理",
        started: "子代理已启动",
        interacted: "子代理正在交互",
        interrupted: "子代理已中断",
      } as Record<string, string>)[record.action ?? ""] ?? "子代理活动";
    case "webSearch":
      return "搜索网页";
    case "imageView":
      return "查看图片";
    case "imageGeneration":
      return "生成图片";
    case "sleep":
      return "等待";
    case "plan":
      return "更新计划";
    case "contextCompaction":
      return "压缩上下文";
    case "reviewMode":
      return record.action === "exited" ? "退出审查模式" : "进入审查模式";
  }
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatCliInput(text: string): string {
  const quote = text
    .trim()
    .split("\n")
    .map((line) => `│ ${line}`)
    .join("\n");
  return `CLI 输入\n\n${quote}`;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replyOptions(replyTo?: number): Parameters<Api["sendMessage"]>[2] {
  return replyTo === undefined
    ? {}
    : {
        reply_parameters: {
          message_id: replyTo,
          allow_sending_without_reply: true,
        },
      };
}

function operationSendOptions(replyTo?: number): Parameters<Api["sendMessage"]>[2] {
  return {
    ...replyOptions(replyTo),
    parse_mode: "HTML",
  };
}

function operationEditOptions(): Parameters<Api["editMessageText"]>[3] {
  return { parse_mode: "HTML" };
}

function isMessageNotModified(error: unknown): boolean {
  return safeErrorMessage(error).toLowerCase().includes("message is not modified");
}

async function waitAtMost<T>(operation: Promise<T>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
