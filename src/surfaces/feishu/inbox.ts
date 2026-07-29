import type { ConversationTarget } from "../../conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";
import { surfaceErrorMetadata } from "../error-metadata.js";

import type { FeishuMessageEvent } from "./message-event.js";
import {
  parseFeishuFileContent,
  parseFeishuAudioContent,
  parseFeishuImageContent,
  parseFeishuPostContent,
  parseFeishuTextContent,
} from "./inbound-content.js";

const DEFAULT_CAPACITY = 100;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_DEDUPLICATION_CAPACITY = 1_000;
const DEFAULT_DEDUPLICATION_TTL_MS = 10 * 60_000;
const DEFAULT_MAXIMUM_EVENT_AGE_MS = 5 * 60_000;

interface FeishuInboxMessageBase {
  target: ConversationTarget;
  actorId: string;
  eventId: string | undefined;
  messageId: string;
  createdAtMs: number;
  parentId?: string;
}

export type FeishuInboxMessage = FeishuInboxMessageBase & (
  | { kind: "text"; text: string }
  | { kind: "image"; imageKeys: readonly string[]; text?: string }
  | { kind: "file"; fileKey: string; fileName: string }
  | { kind: "audio"; fileKey: string; durationMs?: number }
);

export interface FeishuInboxProcessingError {
  target: ConversationTarget;
  messageId: string;
  errorType: string;
}

export type FeishuInboxIgnoredReason =
  | "account-mismatch"
  | "non-user"
  | "unsupported-chat"
  | "unsupported-message"
  | "invalid-timestamp"
  | "invalid-content"
  | "empty-text"
  | "stale"
  | "duplicate"
  | "unauthorized"
  | "closed";

export type FeishuInboxReceiveResult =
  | { status: "accepted" }
  | { status: "ignored"; reason: FeishuInboxIgnoredReason }
  | { status: "retry"; reason: "overloaded" };

export interface FeishuInboxOptions {
  accountId: string;
  access: SurfaceAccessPolicy;
  actorRegistry?: ConversationActorRegistry;
  handle(message: FeishuInboxMessage): Promise<void>;
  handleImageBatch?(messages: readonly Extract<
    FeishuInboxMessage,
    { kind: "image" }
  >[]): Promise<void>;
  handleError(error: FeishuInboxProcessingError): void;
  handleCloseTimeout(pendingCount: number): void;
  capacity?: number;
  closeTimeoutMs?: number;
  deduplicationCapacity?: number;
  deduplicationTtlMs?: number;
  maximumEventAgeMs?: number;
  inputQuietWindowMs?: number;
  now?: () => number;
}

interface ConversationWorker {
  queue: FeishuInboxMessage[];
  done: Promise<void>;
  revision: number;
}

export class FeishuInbox {
  private readonly capacity: number;
  private readonly closeTimeoutMs: number;
  private readonly deduplicationCapacity: number;
  private readonly deduplicationTtlMs: number;
  private readonly maximumEventAgeMs: number;
  private readonly inputQuietWindowMs: number;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>();
  private readonly workers = new Map<string, ConversationWorker>();
  private pendingCount = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: FeishuInboxOptions) {
    this.capacity = positiveInteger(options.capacity ?? DEFAULT_CAPACITY, "容量");
    this.closeTimeoutMs = positiveInteger(
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      "关闭超时",
    );
    this.deduplicationCapacity = positiveInteger(
      options.deduplicationCapacity ?? DEFAULT_DEDUPLICATION_CAPACITY,
      "去重容量",
    );
    this.deduplicationTtlMs = positiveInteger(
      options.deduplicationTtlMs ?? DEFAULT_DEDUPLICATION_TTL_MS,
      "去重有效期",
    );
    this.maximumEventAgeMs = positiveInteger(
      options.maximumEventAgeMs ?? DEFAULT_MAXIMUM_EVENT_AGE_MS,
      "事件最大年龄",
    );
    this.inputQuietWindowMs = nonNegativeInteger(
      options.inputQuietWindowMs ?? 0,
      "输入聚合静默窗口",
    );
    this.now = options.now ?? Date.now;
  }

  receive(event: FeishuMessageEvent): FeishuInboxReceiveResult {
    if (this.closed) {
      return { status: "ignored", reason: "closed" };
    }
    if (event.appId !== undefined && event.appId !== this.options.accountId) {
      return { status: "ignored", reason: "account-mismatch" };
    }
    if (event.senderType !== "user") {
      return { status: "ignored", reason: "non-user" };
    }
    if (event.chatType !== "p2p") {
      return { status: "ignored", reason: "unsupported-chat" };
    }
    if (
      event.messageType !== "text"
      && event.messageType !== "image"
      && event.messageType !== "file"
      && event.messageType !== "audio"
      && event.messageType !== "post"
    ) {
      return { status: "ignored", reason: "unsupported-message" };
    }

    const createdAtMs = parseTimestamp(event.createTime);
    if (createdAtMs === undefined) {
      return { status: "ignored", reason: "invalid-timestamp" };
    }
    const now = this.now();
    if (now - createdAtMs > this.maximumEventAgeMs) {
      return { status: "ignored", reason: "stale" };
    }

    const text = event.messageType === "text"
      ? parseFeishuTextContent(event.content)
      : undefined;
    const content = event.messageType === "text"
      ? (text === undefined ? undefined : { kind: "text" as const, text })
      : event.messageType === "image"
        ? parseFeishuImageContent(event.content)
        : event.messageType === "file"
          ? parseFeishuFileContent(event.content)
          : event.messageType === "audio"
            ? parseFeishuAudioContent(event.content)
            : parseFeishuPostContent(event.content);
    if (content === undefined) {
      return { status: "ignored", reason: "invalid-content" };
    }
    if (content.kind === "text" && content.text.trim().length === 0) {
      return { status: "ignored", reason: "empty-text" };
    }

    const target: ConversationTarget = {
      surface: "feishu",
      accountId: this.options.accountId,
      conversationId: event.chatId,
    };
    const accessContext = {
      target,
      actorId: event.actorOpenId,
    };
    if (!this.options.access.isAllowed(accessContext)) {
      return { status: "ignored", reason: "unauthorized" };
    }

    const deduplicationKey = event.eventId ?? event.messageId;
    this.pruneSeen(now);
    if (this.seen.has(deduplicationKey)) {
      return { status: "ignored", reason: "duplicate" };
    }
    if (this.pendingCount >= this.capacity) {
      return { status: "retry", reason: "overloaded" };
    }

    const message: FeishuInboxMessage = {
      target,
      actorId: event.actorOpenId,
      eventId: event.eventId,
      messageId: event.messageId,
      createdAtMs,
      ...(event.parentId === undefined ? {} : { parentId: event.parentId }),
      ...content,
    };
    this.rememberSeen(deduplicationKey, now);
    this.pendingCount += 1;
    this.enqueue(message);
    return { status: "accepted" };
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private enqueue(message: FeishuInboxMessage): void {
    const conversationId = message.target.conversationId;
    const existing = this.workers.get(conversationId);
    if (existing !== undefined) {
      existing.queue.push(message);
      existing.revision += 1;
      return;
    }
    const queue = [message];
    const worker: ConversationWorker = {
      queue,
      done: Promise.resolve(),
      revision: 0,
    };
    this.workers.set(conversationId, worker);
    worker.done = Promise.resolve().then(
      () => this.runWorker(conversationId, worker),
    );
  }

  private async runWorker(
    conversationId: string,
    worker: ConversationWorker,
  ): Promise<void> {
    const handleImageBatch = this.options.handleImageBatch === undefined
      ? undefined
      : (
          messages: readonly Extract<
            FeishuInboxMessage,
            { kind: "image" }
          >[],
        ) => this.options.handleImageBatch!(messages);
    while (worker.queue.length > 0) {
      const first = worker.queue[0];
      if (
        first?.kind === "image"
        && handleImageBatch !== undefined
        && this.inputQuietWindowMs > 0
      ) {
        const revision = worker.revision;
        await delay(this.inputQuietWindowMs);
        if (worker.revision !== revision) {
          continue;
        }
      }
      const imageBatch = first?.kind === "image"
        && this.options.handleImageBatch !== undefined
        ? takeLeadingImages(worker.queue)
        : undefined;
      if (imageBatch !== undefined && handleImageBatch !== undefined) {
        try {
          for (const message of imageBatch) {
            this.options.actorRegistry?.rememberActor(
              message.target,
              message.actorId,
            );
          }
          await handleImageBatch(imageBatch);
        } catch (error) {
          for (const message of imageBatch) {
            this.reportProcessingError(message, error);
          }
        } finally {
          this.pendingCount -= imageBatch.length;
        }
        continue;
      }
      const message = worker.queue.shift();
      if (message === undefined) {
        break;
      }
      try {
        this.options.actorRegistry?.rememberActor(
          message.target,
          message.actorId,
        );
        await this.options.handle(message);
      } catch (error) {
        this.reportProcessingError(message, error);
      } finally {
        this.pendingCount -= 1;
      }
    }
    const current = this.workers.get(conversationId);
    if (current === worker) {
      this.workers.delete(conversationId);
    }
  }

  private reportProcessingError(
    message: FeishuInboxMessage,
    error: unknown,
  ): void {
    try {
      this.options.handleError({
        target: message.target,
        messageId: message.messageId,
        errorType: surfaceErrorMetadata(error).errorType,
      });
    } catch {
      // Error reporting must not stop later messages for this Conversation.
    }
  }

  private async finishClose(): Promise<void> {
    const completed = await waitAtMost(
      Promise.allSettled([...this.workers.values()].map((worker) => worker.done)),
      this.closeTimeoutMs,
    );
    if (completed) {
      this.workers.clear();
      this.seen.clear();
      return;
    }
    try {
      this.options.handleCloseTimeout(this.pendingCount);
    } catch {
      // Timeout reporting must not make concurrent close callers diverge.
    }
    for (const worker of this.workers.values()) {
      this.pendingCount -= worker.queue.length;
      worker.queue.length = 0;
    }
  }

  private pruneSeen(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt > now) {
        break;
      }
      this.seen.delete(key);
    }
  }

  private rememberSeen(key: string, now: number): void {
    while (this.seen.size >= this.deduplicationCapacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.seen.delete(oldest);
    }
    this.seen.set(key, now + this.deduplicationTtlMs);
  }
}

function parseTimestamp(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`飞书 Inbox ${name}必须是正整数`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`飞书 Inbox ${name}必须是非负整数`);
  }
  return value;
}

function takeLeadingImages(
  queue: FeishuInboxMessage[],
): Array<Extract<FeishuInboxMessage, { kind: "image" }>> {
  const images: Array<Extract<FeishuInboxMessage, { kind: "image" }>> = [];
  while (queue[0]?.kind === "image") {
    const message = queue.shift();
    if (message?.kind === "image") {
      images.push(message);
    }
  }
  return images;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

async function waitAtMost<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([
      operation.then(() => true),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
