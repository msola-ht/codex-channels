import type { Logger } from "pino";

import type {
  ConversationUseCases,
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
  ScheduledTaskUseCases,
} from "../../application/index.js";
import {
  conversationTargetKey,
  type ConversationTarget,
} from "../../conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";
import { truncateQuotedText } from "../quoted-input.js";
import {
  WeixinProtocolError,
  type WeixinInboundMessage,
  type WeixinProtocolClient,
  type WeixinProtocolErrorCode,
} from "./protocol-client.js";
import { WeixinConversationAdapter } from "./conversation-adapter.js";
import type { WeixinAudioPort } from "./audio-store.js";
import type { WeixinFilePort } from "./file-input.js";
import type { WeixinImagePort } from "./image-store.js";
import type { WeixinInteractionPort } from "./interactions.js";
import type { WeixinOutbox } from "./outbox.js";
import {
  createWeixinDoctor,
  type CreateWeixinDoctorOptions,
} from "./doctor.js";
import type { WeixinUpdatesCursorStore } from "./updates-cursor-store.js";
import {
  createWeixinUpdatesMonitor,
  type WeixinUpdatesRetryEvent,
} from "./updates-monitor.js";
import { WeixinPollingHealth } from "./polling-health.js";
import { WeixinReplyContextStore } from "./reply-context-store.js";

type WeixinSupportedMessage = Extract<
  WeixinInboundMessage,
  { kind: "text" | "image" | "file" | "audio" }
>;

const maximumQuotedTextCacheEntries = 1_000;

export type WeixinInputFatalCode =
  | WeixinProtocolErrorCode
  | "message-processing"
  | "receiver-failed";

export class WeixinInputFatalError extends Error {
  constructor(readonly code: WeixinInputFatalCode) {
    super("微信消息接收已停止");
    this.name = "WeixinInputFatalError";
  }
}

export interface WeixinInputAdapterOptions {
  accountId: string;
  client: WeixinProtocolClient;
  cursorStore: WeixinUpdatesCursorStore;
  service: ConversationUseCases;
  outbox: Pick<WeixinOutbox, "notifyText">;
  access: SurfaceAccessPolicy;
  replyContexts: WeixinReplyContextStore;
  persistReplyContext?(
    target: ConversationTarget,
    actorId: string,
    contextToken: string,
  ): Promise<void>;
  removePersistedReplyContext?(target: ConversationTarget): Promise<void>;
  actorRegistry?: ConversationActorRegistry;
  threadSectionAccess?: SurfaceAccessPolicy;
  scheduledTasks?: ScheduledTaskUseCases;
  interactions?: Pick<WeixinInteractionPort, "handleText">;
  images?: Pick<WeixinImagePort, "download">;
  files?: Pick<WeixinFilePort, "download">;
  audios?: Pick<WeixinAudioPort, "download">;
  doctor?: Omit<
    CreateWeixinDoctorOptions,
    "accountId" | "cursorStore" | "pollingHealth"
  >;
  onFatal(error: WeixinInputFatalError): void;
  onRetry?(event: WeixinUpdatesRetryEvent): void;
  onStopTimeout?(): void;
  closeTimeoutMs?: number;
  now?: () => number;
  debugEnabled?: boolean;
  exchangeRate?: () => ExchangeRateSnapshot | null;
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency;
  logger?: Pick<Logger, "debug">;
}

export class WeixinInputAdapter {
  readonly accountId: string;

  private readonly closeTimeoutMs: number;
  private readonly now: () => number;
  private readonly health = new WeixinPollingHealth();
  private readonly monitor;
  private readonly conversations: WeixinConversationAdapter;
  private controller: AbortController | undefined;
  private runTask: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly replyContextWrites = new Map<string, Promise<void>>();
  private readonly quotedTexts = new Map<string, string>();
  private stopping = false;

  constructor(private readonly options: WeixinInputAdapterOptions) {
    this.accountId = options.accountId;
    this.closeTimeoutMs = positiveInteger(
      options.closeTimeoutMs ?? 5_000,
      "微信输入关闭超时时间无效",
    );
    this.now = options.now ?? Date.now;
    this.conversations = new WeixinConversationAdapter(
      options.service,
      options.outbox,
      options.images,
      {
        quietWindowMs: 0,
        pollingHealth: this.health,
        now: this.now,
        debugEnabled: options.debugEnabled ?? false,
        ...(options.exchangeRate === undefined
          ? {}
          : { exchangeRate: options.exchangeRate }),
        ...(options.priceCurrency === undefined
          ? {}
          : { priceCurrency: options.priceCurrency }),
        ...(options.threadSectionAccess === undefined
          ? {}
          : { threadSectionAccess: options.threadSectionAccess }),
        ...(options.scheduledTasks === undefined
          ? {}
          : { scheduledTasks: options.scheduledTasks }),
        ...(options.doctor === undefined
          ? {}
          : {
              doctor: createWeixinDoctor({
                accountId: options.accountId,
                cursorStore: options.cursorStore,
                pollingHealth: this.health,
                ...options.doctor,
              }),
            }),
      },
      options.files,
      options.audios,
    );
    this.monitor = createWeixinUpdatesMonitor({
      accountId: options.accountId,
      client: options.client,
      cursorStore: options.cursorStore,
      handleMessage: (message) => this.handle(message),
      onPollStart: () => this.health.recordPollStart(),
      onPollSuccess: (atMs) => this.health.recordSuccess(atMs),
      onRetry: (event) => {
        this.health.recordRetry(event, Date.now());
        options.onRetry?.(event);
      },
    });
  }

  start(): Promise<void> {
    if (this.stopping) {
      return Promise.reject(new Error("微信输入 Adapter 已停止"));
    }
    if (this.runTask !== undefined) {
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.controller = controller;
    this.health.start();
    const task = this.monitor.run(controller.signal);
    this.runTask = task;
    void task
      .catch((error: unknown) => {
        if (!this.stopping) {
          this.reportFatal(error);
        }
      })
      .finally(() => {
        if (this.runTask === task) {
          this.runTask = undefined;
          this.controller = undefined;
        }
      });
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async handle(message: WeixinSupportedMessage): Promise<void> {
    const receivedAtMs = this.now();
    this.options.logger?.debug(
      {
        surface: "weixin",
        accountId: this.accountId,
        messageType: message.kind,
      },
      "微信输入已到达 Gateway",
    );
    const target: ConversationTarget = {
      surface: "weixin",
      accountId: this.accountId,
      conversationId: message.conversationId,
    };
    const accessContext = {
      target,
      actorId: message.actorId,
    };
    if (!this.options.access.isAllowed(accessContext)) {
      this.options.replyContexts.remove(target);
      await this.options.removePersistedReplyContext?.(target);
      return;
    }
    const quotedText = message.quotedText
      ?? (message.quotedMessageId === undefined
        ? undefined
        : this.quotedTexts.get(
          quotedTextCacheKey(target, message.quotedMessageId),
        ));
    if ("text" in message && message.text !== undefined) {
      this.rememberQuotedText(target, message.messageId, message.text);
    }
    this.options.replyContexts.remember(
      target,
      message.actorId,
      message.contextToken,
    );
    await this.persistReplyContext(
      target,
      message.actorId,
      message.contextToken,
    );
    this.options.actorRegistry?.rememberActor(target, message.actorId);
    if (
      message.kind === "text"
      && await this.options.interactions?.handleText(
        target,
        message.actorId,
        message.text,
      ) === "handled"
    ) {
      return;
    }
    try {
      const conversationMessage = message.kind === "text"
        ? {
            target,
            actorId: message.actorId,
            kind: "text" as const,
            text: message.text,
            ...(message.createdAt === undefined
              ? {}
              : { createdAtMs: message.createdAt }),
            receivedAtMs,
            ...(quotedText === undefined ? {} : { quotedText }),
          }
        : message.kind === "image"
          ? {
              target,
              actorId: message.actorId,
              kind: "image" as const,
              ...(message.text === undefined ? {} : { text: message.text }),
              ...(quotedText === undefined ? {} : { quotedText }),
              images: message.images,
            }
          : message.kind === "file"
            ? {
                target,
                actorId: message.actorId,
                kind: "file" as const,
                ...(message.text === undefined ? {} : { text: message.text }),
                ...(quotedText === undefined ? {} : { quotedText }),
                file: message.file,
              }
            : {
                target,
                actorId: message.actorId,
                kind: "audio" as const,
                ...(quotedText === undefined ? {} : { quotedText }),
                audio: message.audio,
              };
      await this.conversations.handle(conversationMessage);
    } catch (error) {
      throw new WeixinMessageProcessingError({ cause: error });
    }
  }

  private rememberQuotedText(
    target: ConversationTarget,
    messageId: string,
    text: string,
  ): void {
    const key = quotedTextCacheKey(target, messageId);
    this.quotedTexts.delete(key);
    this.quotedTexts.set(key, truncateQuotedText(text));
    while (this.quotedTexts.size > maximumQuotedTextCacheEntries) {
      const oldest = this.quotedTexts.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.quotedTexts.delete(oldest);
    }
  }

  private async persistReplyContext(
    target: ConversationTarget,
    actorId: string,
    contextToken: string,
  ): Promise<void> {
    if (this.options.persistReplyContext === undefined) {
      return;
    }
    const key = conversationTargetKey(target);
    const previous = this.replyContextWrites.get(key) ?? Promise.resolve();
    const task = previous.then(() =>
      this.options.persistReplyContext!(target, actorId, contextToken)
    );
    this.replyContextWrites.set(key, task);
    try {
      await task;
    } finally {
      if (this.replyContextWrites.get(key) === task) {
        this.replyContextWrites.delete(key);
      }
    }
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;
    this.health.stop();
    this.quotedTexts.clear();
    this.controller?.abort();
    await this.conversations.close();
    const task = this.runTask;
    if (task === undefined) {
      return;
    }
    const completed = await waitAtMost(
      task.catch(() => undefined),
      this.closeTimeoutMs,
    );
    if (!completed) {
      try {
        this.options.onStopTimeout?.();
      } catch {
        // Timeout reporting must not make repeated stop calls diverge.
      }
    }
  }

  private reportFatal(error: unknown): void {
    const code = error instanceof WeixinMessageProcessingError
      ? "message-processing"
      : error instanceof WeixinProtocolError
        ? error.code
        : "receiver-failed";
    try {
      this.options.onFatal(new WeixinInputFatalError(code));
    } catch {
      // Fatal reporting must not create an unhandled rejection.
    }
  }
}

function quotedTextCacheKey(
  target: ConversationTarget,
  messageId: string,
): string {
  return `${conversationTargetKey(target)}\u0000${messageId}`;
}

class WeixinMessageProcessingError extends Error {
  constructor(options: ErrorOptions) {
    super("微信消息处理失败", options);
    this.name = "WeixinMessageProcessingError";
  }
}

function positiveInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
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
