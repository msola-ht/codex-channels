import type { Logger } from "pino";

import {
  isCriticalOutputEvent,
  type OperationUpdate,
  type OutputEvent,
} from "../../conversation-core/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import type { SurfaceOutputPort } from "../types.js";
import type { FeishuCardDocument } from "./approval-card.js";
import { FeishuMessageError } from "./client.js";
import { encodeFeishuPostContent } from "./message-content.js";
import { formatFeishuOperationLog } from "./operation-format.js";
import { renderFeishuOutput } from "./renderer.js";
import { renderFeishuThreadStatusCard } from "./status-card.js";

const maximumFeishuMessageContentBytes = 20_000;
const maximumFeishuMessageChunks = 5;
const feishuChunkHeaderReserveBytes = 64;
const feishuTruncationNotice = "\n\n[内容过长，已截断]";
const feishuStreamFlushDelayMs = 300;
const maximumFeishuStreamingElementCharacters = 5_000;
const maximumFeishuStreamingCards = 5;
const feishuOperationFlushDelayMs = 750;
const maximumFeishuOperationsPerTurn = 100;

interface FeishuStreamState {
  chatId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  text: string;
  cardText: string;
  sequence: number;
  cardCount: number;
  cardId?: string;
  lastSentText?: string;
  timer?: NodeJS.Timeout;
  failed: boolean;
}

interface FeishuOperationLogState {
  chatId: string;
  order: string[];
  records: Map<string, OperationUpdate>;
  omittedCount: number;
  sequence: number;
  cardId?: string;
  lastText?: string;
  timer?: NodeJS.Timeout;
  failed: boolean;
}

export interface FeishuMessagePort {
  sendText(chatId: string, text: string): Promise<void>;
  sendPost(chatId: string, markdown: string): Promise<void>;
  sendMarkdownCard(chatId: string, markdown: string): Promise<void>;
  sendCard(chatId: string, card: FeishuCardDocument): Promise<string>;
  updateCard(messageId: string, card: FeishuCardDocument): Promise<void>;
  createStreamingCard(
    chatId: string,
    initialText: string,
  ): Promise<{ cardId: string; messageId: string }>;
  updateStreamingCard(
    cardId: string,
    content: string,
    sequence: number,
  ): Promise<void>;
  finishStreamingCard(
    cardId: string,
    sequence: number,
    summary: string,
  ): Promise<void>;
}

export class FeishuOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
  private readonly threadStatusMessages = new Map<
    string,
    { chatId: string; messageId: string; status: string }
  >();
  private readonly streams = new Map<string, FeishuStreamState>();
  private readonly operationLogs = new Map<string, FeishuOperationLogState>();
  private closed = false;
  private closeFinished = false;

  constructor(
    private readonly accountId: string,
    private readonly messagePort: FeishuMessagePort,
    private readonly logger: Logger,
  ) {
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Feishu",
    });
  }

  handle(event: OutputEvent): void {
    if (
      this.closed
      || event.target.surface !== "feishu"
      || event.target.accountId !== this.accountId
    ) {
      return;
    }
    if (event.type === "text.delta") {
      this.acceptStreamDelta(event);
      return;
    }
    if (event.type === "text.completed" && this.completeStream(event)) {
      return;
    }
    if (event.type === "operation.updated") {
      this.acceptOperationUpdate(event);
      return;
    }
    if (event.type === "turn.completed") {
      this.finishOperationLog(event.threadId, event.turnId);
      this.finishStreamsForTurn(event.threadId, event.turnId);
    }
    if (event.type === "thread.status") {
      this.delivery.enqueue(
        event.target.conversationId,
        () => this.deliverThreadStatus(event),
        true,
      );
      return;
    }
    const text = renderFeishuOutput(event);
    if (text === null) {
      return;
    }
    this.delivery.enqueue(
      event.target.conversationId,
      () => event.type === "text.completed" || event.type === "turn.completed"
        ? this.sendMarkdown(event.target.conversationId, text)
        : this.sendText(event.target.conversationId, text),
      isCriticalOutputEvent(event),
    );
  }

  notifyText(chatId: string, text: string): boolean {
    if (this.closed) {
      return false;
    }
    return this.delivery.enqueue(
      chatId,
      () => this.sendText(chatId, text),
      true,
    );
  }

  notifyMarkdown(chatId: string, markdown: string): boolean {
    if (this.closed) {
      return false;
    }
    return this.delivery.enqueue(
      chatId,
      () => this.sendMarkdown(chatId, markdown),
      true,
    );
  }

  deliverText(chatId: string, text: string): Promise<void> {
    return this.delivery.runOrdered(
      chatId,
      () => this.sendText(chatId, text),
    );
  }

  deliverCard(
    chatId: string,
    card: FeishuCardDocument,
  ): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error("飞书输出队列已经关闭"));
    }
    return this.delivery.runOrdered(
      chatId,
      () => this.messagePort.sendCard(chatId, card),
    );
  }

  updateCard(
    chatId: string,
    messageId: string,
    card: FeishuCardDocument,
  ): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("飞书输出队列已经关闭"));
    }
    return this.delivery.runOrdered(
      chatId,
      () => this.messagePort.updateCard(messageId, card),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [key, state] of this.streams) {
      if (state.timer) {
        clearTimeout(state.timer);
        delete state.timer;
      }
      this.delivery.enqueue(
        state.chatId,
        () => this.flushStream(key, true, false),
        true,
      );
    }
    for (const [key, state] of this.operationLogs) {
      if (state.timer) {
        clearTimeout(state.timer);
        delete state.timer;
      }
      this.delivery.enqueue(
        state.chatId,
        () => this.flushOperationLog(key, true),
        true,
      );
    }
    await this.delivery.close();
    this.closeFinished = true;
    this.threadStatusMessages.clear();
    this.streams.clear();
    this.operationLogs.clear();
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    for (const chunk of splitFeishuText(text)) {
      await this.messagePort.sendText(chatId, chunk);
    }
  }

  private async sendPost(
    chatId: string,
    markdown: string,
    maximumChunks = maximumFeishuMessageChunks,
  ): Promise<void> {
    for (const chunk of splitFeishuPost(markdown, maximumChunks)) {
      await this.messagePort.sendPost(chatId, chunk);
    }
  }

  private async sendMarkdown(
    chatId: string,
    markdown: string,
  ): Promise<void> {
    for (const chunk of splitFeishuMarkdownCards(markdown)) {
      try {
        await this.messagePort.sendMarkdownCard(chatId, chunk);
      } catch (error) {
        if (
          !(error instanceof FeishuMessageError)
          || error.code !== "card-create-failed"
        ) {
          throw error;
        }
        this.logger.warn(
          {
            component: "Feishu",
            fallback: "post",
          },
          "飞书静态 CardKit 创建失败，已降级为富文本",
        );
        await this.sendPost(chatId, chunk, 1);
      }
    }
  }

  private async deliverThreadStatus(
    event: Extract<OutputEvent, { type: "thread.status" }>,
  ): Promise<void> {
    const card = renderFeishuThreadStatusCard(event.status);
    const current = this.threadStatusMessages.get(event.threadId);
    if (
      current
      && current.chatId === event.target.conversationId
    ) {
      if (current.status === event.status) {
        return;
      }
      try {
        await this.messagePort.updateCard(current.messageId, card);
      } catch (error) {
        if (this.threadStatusMessages.get(event.threadId) === current) {
          this.threadStatusMessages.delete(event.threadId);
        }
        throw error;
      }
      if (event.status === "active" && !this.closeFinished) {
        this.threadStatusMessages.set(event.threadId, {
          ...current,
          status: event.status,
        });
      } else {
        this.threadStatusMessages.delete(event.threadId);
      }
      return;
    }
    const messageId = await this.messagePort.sendCard(
      event.target.conversationId,
      card,
    );
    if (event.status === "active" && !this.closeFinished) {
      this.threadStatusMessages.set(event.threadId, {
        chatId: event.target.conversationId,
        messageId,
        status: event.status,
      });
    }
  }

  private acceptStreamDelta(
    event: Extract<OutputEvent, { type: "text.delta" }>,
  ): void {
    const key = streamKey(event.threadId, event.turnId, event.itemId);
    const state = this.streams.get(key) ?? {
      chatId: event.target.conversationId,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      text: "",
      cardText: "",
      sequence: 0,
      cardCount: 0,
      failed: false,
    };
    state.text += event.text;
    state.cardText += event.text;
    this.streams.set(key, state);
    if (!state.timer) {
      state.timer = setTimeout(() => {
        delete state.timer;
        this.delivery.enqueue(
          state.chatId,
          () => this.flushStream(key, false, false),
          false,
        );
      }, feishuStreamFlushDelayMs);
      state.timer.unref();
    }
  }

  private acceptOperationUpdate(
    event: Extract<OutputEvent, { type: "operation.updated" }>,
  ): void {
    const key = operationLogKey(event.threadId, event.turnId);
    const state: FeishuOperationLogState = this.operationLogs.get(key) ?? {
      chatId: event.target.conversationId,
      order: [],
      records: new Map<string, OperationUpdate>(),
      omittedCount: 0,
      sequence: 0,
      failed: false,
    };
    if (!state.records.has(event.operation.itemId)) {
      state.order.push(event.operation.itemId);
      if (state.order.length > maximumFeishuOperationsPerTurn) {
        const removed = state.order.shift();
        if (removed) {
          state.records.delete(removed);
          state.omittedCount += 1;
        }
      }
    }
    state.records.set(event.operation.itemId, event.operation);
    this.operationLogs.set(key, state);
    if (!state.timer) {
      state.timer = setTimeout(() => {
        delete state.timer;
        this.delivery.enqueue(
          state.chatId,
          () => this.flushOperationLog(key, false),
          event.operation.status !== "running",
        );
      }, feishuOperationFlushDelayMs);
      state.timer.unref();
    }
  }

  private finishOperationLog(threadId: string, turnId: string): void {
    const key = operationLogKey(threadId, turnId);
    const state = this.operationLogs.get(key);
    if (!state) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      delete state.timer;
    }
    this.delivery.enqueue(
      state.chatId,
      () => this.flushOperationLog(key, true),
      true,
    );
  }

  private async flushOperationLog(
    key: string,
    terminal: boolean,
  ): Promise<void> {
    const state = this.operationLogs.get(key);
    if (!state) {
      return;
    }
    const markdown = formatFeishuOperationLog(state);
    if (state.failed) {
      if (terminal) {
        this.operationLogs.delete(key);
        await this.sendMarkdown(state.chatId, markdown);
      }
      return;
    }
    try {
      if (!state.cardId) {
        const created = await this.messagePort.createStreamingCard(
          state.chatId,
          markdown,
        );
        state.cardId = created.cardId;
        state.lastText = markdown;
      } else if (state.lastText !== markdown) {
        state.sequence += 1;
        await this.messagePort.updateStreamingCard(
          state.cardId,
          markdown,
          state.sequence,
        );
        state.lastText = markdown;
      }
      if (terminal) {
        state.sequence += 1;
        await this.messagePort.finishStreamingCard(
          state.cardId,
          state.sequence,
          markdown,
        );
        this.operationLogs.delete(key);
      }
    } catch (error) {
      state.failed = true;
      if (terminal) {
        this.operationLogs.delete(key);
        await this.sendMarkdown(state.chatId, markdown);
      }
      throw error;
    }
  }

  private completeStream(
    event: Extract<OutputEvent, { type: "text.completed" }>,
  ): boolean {
    const key = streamKey(event.threadId, event.turnId, event.itemId);
    const state = this.streams.get(key);
    if (!state) {
      return false;
    }
    if (event.text.startsWith(state.text)) {
      state.cardText += event.text.slice(state.text.length);
    } else if (state.cardCount <= 1) {
      state.cardText = event.text;
    } else {
      state.failed = true;
    }
    state.text = event.text;
    if (state.timer) {
      clearTimeout(state.timer);
      delete state.timer;
    }
    this.delivery.enqueue(
      state.chatId,
      () => this.flushStream(key, true, true),
      true,
    );
    return true;
  }

  private finishStreamsForTurn(threadId: string, turnId: string): void {
    for (const [key, state] of this.streams) {
      if (state.threadId !== threadId || state.turnId !== turnId) {
        continue;
      }
      if (state.timer) {
        clearTimeout(state.timer);
        delete state.timer;
      }
      this.delivery.enqueue(
        state.chatId,
        () => this.flushStream(key, true, true),
        true,
      );
    }
  }

  private async flushStream(
    key: string,
    terminal: boolean,
    fallbackPost: boolean,
  ): Promise<void> {
    const state = this.streams.get(key);
    if (!state) {
      return;
    }
    if (state.failed) {
      if (terminal) {
        await this.recoverFailedStream(key, state, fallbackPost);
      }
      return;
    }
    if (!state.cardId && terminal) {
      this.streams.delete(key);
      if (fallbackPost) {
        await this.sendMarkdown(state.chatId, state.text);
      }
      return;
    }
    try {
      await this.rollStreamingCards(state);
      if (state.lastSentText !== state.cardText) {
        state.sequence += 1;
        try {
          await this.messagePort.updateStreamingCard(
            state.cardId!,
            state.cardText,
            state.sequence,
          );
        } catch (error) {
          if (
            !terminal
            && error instanceof FeishuMessageError
            && error.code === "rate-limited"
          ) {
            return;
          }
          throw error;
        }
        state.lastSentText = state.cardText;
      }
    } catch (error) {
      state.failed = true;
      if (terminal) {
        await this.recoverFailedStream(key, state, fallbackPost);
      }
      throw error;
    }
    if (terminal) {
      this.streams.delete(key);
      state.sequence += 1;
      await this.messagePort.finishStreamingCard(
        state.cardId!,
        state.sequence,
        state.cardText,
      );
    }
  }

  private async rollStreamingCards(state: FeishuStreamState): Promise<void> {
    while (
      [...state.cardText].length > maximumFeishuStreamingElementCharacters
    ) {
      const [rawHead, tail] = splitFeishuStreamingContent(state.cardText);
      const reachesCardLimit =
        state.cardCount === maximumFeishuStreamingCards - 1;
      const head = reachesCardLimit
        ? appendFeishuStreamingTruncation(rawHead)
        : rawHead;
      await this.ensureStreamingCard(state, head);
      if (state.lastSentText !== head) {
        state.sequence += 1;
        await this.messagePort.updateStreamingCard(
          state.cardId!,
          head,
          state.sequence,
        );
        state.lastSentText = head;
      }
      state.sequence += 1;
      await this.messagePort.finishStreamingCard(
        state.cardId!,
        state.sequence,
        head,
      );
      delete state.cardId;
      delete state.lastSentText;
      state.sequence = 0;
      state.cardText = tail;
      if (reachesCardLimit) {
        throw new Error("飞书流式卡片数量超过单个结果上限");
      }
    }
    await this.ensureStreamingCard(state, state.cardText);
  }

  private async ensureStreamingCard(
    state: FeishuStreamState,
    initialText: string,
  ): Promise<void> {
    if (state.cardId) {
      return;
    }
    if (state.cardCount >= maximumFeishuStreamingCards) {
      throw new Error("飞书流式卡片数量超过单个结果上限");
    }
    const created = await this.messagePort.createStreamingCard(
      state.chatId,
      initialText,
    );
    state.cardId = created.cardId;
    state.lastSentText = initialText;
    state.cardCount += 1;
  }

  private async recoverFailedStream(
    key: string,
    state: FeishuStreamState,
    fallbackPost: boolean,
  ): Promise<void> {
    this.streams.delete(key);
    let finishError: unknown;
    if (state.cardId) {
      state.sequence += 1;
      try {
        await this.messagePort.finishStreamingCard(
          state.cardId,
          state.sequence,
          state.lastSentText ?? state.cardText,
        );
      } catch (error) {
        finishError = error;
      }
    }
    const remainingMessageBudget =
      maximumFeishuMessageChunks - state.cardCount;
    if (fallbackPost && remainingMessageBudget > 0) {
      await this.sendPost(
        state.chatId,
        state.text,
        remainingMessageBudget,
      );
    }
    if (finishError) {
      throw finishError instanceof Error
        ? finishError
        : new Error("飞书流式卡片结束失败");
    }
  }
}

function streamKey(threadId: string, turnId: string, itemId: string): string {
  return JSON.stringify([threadId, turnId, itemId]);
}

function operationLogKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function splitFeishuStreamingContent(text: string): [string, string] {
  const characters = [...text];
  const reservedEnd = maximumFeishuStreamingElementCharacters - 4;
  let end = reservedEnd;
  for (
    let index = reservedEnd;
    index >= Math.floor(reservedEnd * 0.75);
    index -= 1
  ) {
    if (characters[index - 1] === "\n") {
      end = index;
      break;
    }
  }
  const rawHead = characters.slice(0, end).join("");
  const rawTail = characters.slice(end).join("");
  const fenceLanguage = openFenceLanguage(rawHead);
  if (fenceLanguage === null) {
    return [rawHead, rawTail];
  }
  return [
    `${rawHead.endsWith("\n") ? rawHead : `${rawHead}\n`}\`\`\``,
    `\`\`\`${fenceLanguage}\n${rawTail}`,
  ];
}

function splitFeishuMarkdownCards(markdown: string): string[] {
  const chunks: string[] = [];
  let remaining = markdown;
  while (
    [...remaining].length > maximumFeishuStreamingElementCharacters
    && chunks.length < maximumFeishuMessageChunks - 1
  ) {
    const [head, tail] = splitFeishuStreamingContent(remaining);
    chunks.push(head);
    remaining = tail;
  }
  if ([...remaining].length > maximumFeishuStreamingElementCharacters) {
    const [head] = splitFeishuStreamingContent(remaining);
    chunks.push(appendFeishuStreamingTruncation(head));
  } else {
    chunks.push(remaining);
  }
  return chunks;
}

function openFenceLanguage(text: string): string | null {
  let language: string | null = null;
  for (const line of text.split("\n")) {
    const match = /^```([A-Za-z0-9_-]*)\s*$/u.exec(line);
    if (match) {
      language = language === null ? (match[1] ?? "") : null;
    }
  }
  return language;
}

function appendFeishuStreamingTruncation(text: string): string {
  const characters = [...text];
  const notice = [...feishuTruncationNotice];
  const closingFence = text.endsWith("\n```") ? [..."\n```"] : [];
  const contentLimit =
    maximumFeishuStreamingElementCharacters
    - notice.length
    - closingFence.length;
  const content = closingFence.length > 0
    ? characters.slice(0, Math.min(contentLimit, characters.length - 4))
    : characters.slice(0, contentLimit);
  return [
    ...content,
    ...closingFence,
    ...notice,
  ].join("");
}

function splitFeishuText(text: string): string[] {
  return splitFeishuContent(
    text,
    (value) => Buffer.byteLength(value, "utf8"),
  );
}

function splitFeishuPost(
  markdown: string,
  maximumChunks = maximumFeishuMessageChunks,
): string[] {
  return splitFeishuContent(
    markdown,
    (value) => Buffer.byteLength(encodeFeishuPostContent(value), "utf8"),
    maximumChunks,
  );
}

function splitFeishuContent(
  text: string,
  measureBytes: (value: string) => number,
  maximumChunks = maximumFeishuMessageChunks,
): string[] {
  if (measureBytes(text) <= maximumFeishuMessageContentBytes) {
    return [text];
  }
  const payloadLimit =
    maximumFeishuMessageContentBytes - feishuChunkHeaderReserveBytes;
  const payloads: string[] = [];
  const characters = [...text];
  let offset = 0;
  while (
    offset < characters.length
    && payloads.length < maximumChunks
  ) {
    const end = findLargestFittingEnd(
      characters,
      offset,
      payloadLimit,
      measureBytes,
    );
    if (end === offset) {
      throw new Error("飞书消息分片上限不足以容纳单个字符");
    }
    payloads.push(characters.slice(offset, end).join(""));
    offset = end;
  }
  if (offset < characters.length) {
    const lastIndex = payloads.length - 1;
    payloads[lastIndex] = appendWithinByteLimit(
      payloads[lastIndex]!,
      feishuTruncationNotice,
      payloadLimit,
      measureBytes,
    );
  }
  return payloads.map(
    (payload, index) => `（${index + 1}/${payloads.length}）\n${payload}`,
  );
}

function findLargestFittingEnd(
  characters: readonly string[],
  offset: number,
  byteLimit: number,
  measureBytes: (value: string) => number,
): number {
  let low = offset + 1;
  let high = characters.length;
  let best = offset;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(offset, middle).join("");
    if (measureBytes(candidate) <= byteLimit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function appendWithinByteLimit(
  text: string,
  suffix: string,
  byteLimit: number,
  measureBytes: (value: string) => number,
): string {
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${suffix}`;
    if (measureBytes(candidate) <= byteLimit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, best).join("")}${suffix}`;
}
