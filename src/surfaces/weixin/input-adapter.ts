import type { ConversationService } from "../../application/index.js";
import {
  conversationTargetKey,
  type ConversationTarget,
} from "../../conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";

import {
  WeixinProtocolError,
  type WeixinInboundMessage,
  type WeixinProtocolClient,
  type WeixinProtocolErrorCode,
} from "./protocol-client.js";
import { WeixinConversationAdapter } from "./conversation-adapter.js";
import type { WeixinImagePort } from "./image-store.js";
import type { WeixinOutbox } from "./outbox.js";
import type { WeixinUpdatesCursorStore } from "./updates-cursor-store.js";
import { createWeixinUpdatesMonitor } from "./updates-monitor.js";
import { WeixinReplyContextStore } from "./reply-context-store.js";

type WeixinSupportedMessage = Extract<
  WeixinInboundMessage,
  { kind: "text" | "image" }
>;

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
  service: ConversationService;
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
  images?: Pick<WeixinImagePort, "download">;
  onFatal(error: WeixinInputFatalError): void;
  onStopTimeout?(): void;
  closeTimeoutMs?: number;
}

export class WeixinInputAdapter {
  readonly accountId: string;

  private readonly closeTimeoutMs: number;
  private readonly monitor;
  private readonly conversations: WeixinConversationAdapter;
  private controller: AbortController | undefined;
  private runTask: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly replyContextWrites = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(private readonly options: WeixinInputAdapterOptions) {
    this.accountId = options.accountId;
    this.closeTimeoutMs = positiveInteger(
      options.closeTimeoutMs ?? 5_000,
      "微信输入关闭超时时间无效",
    );
    this.conversations = new WeixinConversationAdapter(
      options.service,
      options.outbox,
      options.images,
      { quietWindowMs: 1_000 },
    );
    this.monitor = createWeixinUpdatesMonitor({
      accountId: options.accountId,
      client: options.client,
      cursorStore: options.cursorStore,
      handleMessage: (message) => this.handle(message),
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
    const task = this.monitor.run(controller.signal);
    this.runTask = task;
    void task.catch((error: unknown) => {
      if (!this.stopping) {
        this.reportFatal(error);
      }
    });
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async handle(message: WeixinSupportedMessage): Promise<void> {
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
    try {
      await this.conversations.handle({
        target,
        actorId: message.actorId,
        ...(message.kind === "text"
          ? { kind: "text", text: message.text }
          : {
              kind: "image",
              ...(message.text === undefined ? {} : { text: message.text }),
              images: message.images,
            }),
      });
    } catch (error) {
      throw new WeixinMessageProcessingError({ cause: error });
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
