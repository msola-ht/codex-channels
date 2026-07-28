import type { Logger } from "pino";

import type { ConversationService } from "../../application/index.js";
import type {
  ConversationTarget,
} from "../../conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";
import type {
  OperationUpdateDisplay,
  SurfaceAdapter,
  SurfaceConfigurationChange,
} from "../types.js";

import {
  WeixinInputAdapter,
  type WeixinInputFatalError,
} from "./input-adapter.js";
import type { WeixinImagePort } from "./image-store.js";
import { WeixinInteractionPort } from "./interactions.js";
import {
  WeixinOutbox,
  type WeixinOutboxOptions,
} from "./outbox.js";
import type {
  WeixinImageSendProtocolClient,
  WeixinProtocolClient,
  WeixinTypingProtocolClient,
} from "./protocol-client.js";
import { WeixinReplyContextStore } from "./reply-context-store.js";
import type { WeixinReplyContextPersistence } from "./reply-context-persistence.js";
import { formatWeixinCommandText } from "./command-renderer.js";
import type { WeixinUpdatesCursorStore } from "./updates-cursor-store.js";
import type { WeixinUpdatesRetryEvent } from "./updates-monitor.js";
import { WeixinTypingController } from "./typing-controller.js";

export interface WeixinSurfaceOptions {
  accountId: string;
  client: WeixinProtocolClient;
  imageSendClient?: WeixinImageSendProtocolClient;
  typingClient?: WeixinTypingProtocolClient;
  cursorStore: WeixinUpdatesCursorStore;
  service: ConversationService;
  access: SurfaceAccessPolicy;
  logger: Logger;
  onFatal: (error: WeixinInputFatalError) => void;
  actorRegistry?: ConversationActorRegistry;
  replyContextPersistence?: WeixinReplyContextPersistence;
  images?: WeixinImagePort;
  startupNotification?: {
    targets(): readonly ConversationTarget[];
    text(target: ConversationTarget): string;
  };
  operationUpdateDisplay?: OperationUpdateDisplay;
  inputCloseTimeoutMs?: number;
  outbox?: WeixinOutboxOptions;
}

export class WeixinConfigurationDeliveryError extends Error {
  constructor() {
    super("微信 Surface 不支持主动配置通知");
    this.name = "WeixinConfigurationDeliveryError";
  }
}

export class WeixinSurface implements SurfaceAdapter {
  readonly surface = "weixin" as const;
  readonly accountId: string;
  readonly interactions: WeixinInteractionPort;
  readonly output: WeixinOutbox;

  private readonly input: WeixinInputAdapter;
  private readonly replyContexts: WeixinReplyContextStore;
  private readonly replyContextPersistence:
    | WeixinReplyContextPersistence
    | undefined;
  private readonly startupNotification: WeixinSurfaceOptions["startupNotification"];
  private readonly access: SurfaceAccessPolicy;
  private readonly logger: Logger;
  private readonly images: WeixinImagePort | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(options: WeixinSurfaceOptions) {
    const replyContexts = new WeixinReplyContextStore(options.accountId);
    this.replyContexts = replyContexts;
    this.replyContextPersistence = options.replyContextPersistence;
    this.startupNotification = options.startupNotification;
    this.access = options.access;
    this.logger = options.logger;
    this.images = options.images;
    this.accountId = options.accountId;
    this.interactions = new WeixinInteractionPort();
    const typing = options.typingClient === undefined
      ? undefined
      : new WeixinTypingController(
          options.typingClient,
          replyContexts,
          options.access,
          options.logger,
        );
    this.output = new WeixinOutbox(
      options.accountId,
      options.client,
      replyContexts,
      options.access,
      options.logger,
      {
        ...options.outbox,
        ...(options.imageSendClient === undefined
          ? {}
          : { imageClient: options.imageSendClient }),
        ...(typing === undefined ? {} : { typing }),
        ...(options.operationUpdateDisplay === undefined
          ? {}
          : {
              operationUpdateDisplay: options.operationUpdateDisplay,
            }),
        ...(options.replyContextPersistence === undefined
          ? {}
          : {
              onReplyContextInvalidated: (target) =>
                options.replyContextPersistence!.remove(target),
            }),
      },
    );
    this.input = new WeixinInputAdapter({
      accountId: options.accountId,
      client: options.client,
      cursorStore: options.cursorStore,
      service: options.service,
      outbox: this.output,
      access: options.access,
      replyContexts,
      ...(options.images === undefined ? {} : { images: options.images }),
      ...(options.replyContextPersistence === undefined
        ? {}
        : {
            persistReplyContext: (target, actorId, contextToken) =>
              options.replyContextPersistence!.set(
                target,
                actorId,
                contextToken,
              ),
            removePersistedReplyContext: (target) =>
              options.replyContextPersistence!.remove(target),
          }),
      ...(options.actorRegistry === undefined
        ? {}
        : { actorRegistry: options.actorRegistry }),
      onFatal: options.onFatal,
      onRetry: (event) => {
        logUpdatesRetry(
          options.logger,
          options.accountId,
          event,
        );
      },
      ...(options.inputCloseTimeoutMs === undefined
        ? {}
        : { closeTimeoutMs: options.inputCloseTimeoutMs }),
      onStopTimeout: () => {
        options.logger.warn(
          {
            surface: "weixin",
            accountId: options.accountId,
          },
          "微信输入关闭等待超时",
        );
      },
    });
  }

  start(): Promise<void> {
    this.startPromise ??= this.startOnce();
    return this.startPromise;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  deliverConfigurationChange(
    change: SurfaceConfigurationChange,
  ): Promise<void> {
    void change;
    return Promise.reject(new WeixinConfigurationDeliveryError());
  }

  private async stopOnce(): Promise<void> {
    try {
      await this.input.stop();
    } finally {
      this.images?.close();
      this.interactions.cancelAll("Gateway 已停止");
      await this.output.close();
    }
  }

  private async startOnce(): Promise<void> {
    const targets = this.startupNotification?.targets() ?? [];
    const restored: ConversationTarget[] = [];
    if (this.replyContextPersistence) {
      const seen = new Set<string>();
      for (const target of targets) {
        if (
          target.surface !== "weixin"
          || target.accountId !== this.accountId
          || seen.has(target.conversationId)
        ) {
          continue;
        }
        seen.add(target.conversationId);
        const stored = await this.replyContextPersistence.get(target);
        if (stored === null) {
          continue;
        }
        if (!this.access.isAllowed({ target, actorId: stored.actorId })) {
          await this.replyContextPersistence.remove(target);
          continue;
        }
        this.replyContexts.remember(
          target,
          stored.actorId,
          stored.contextToken,
        );
        restored.push(target);
      }
    }
    await this.images?.start();
    try {
      await this.input.start();
    } catch (error) {
      this.images?.close();
      throw error;
    }
    for (const target of restored) {
      try {
        const text = this.startupNotification?.text(target);
        if (text) {
          await this.output.deliverText(
            target,
            formatWeixinCommandText(text),
          );
        }
      } catch (error) {
        this.logger.warn(
          {
            surface: "weixin",
            accountId: this.accountId,
            conversationId: target.conversationId,
            errorType: error instanceof Error ? error.name : typeof error,
          },
          "微信启动联通通知发送失败，不影响长轮询",
        );
      }
    }
  }
}

function logUpdatesRetry(
  logger: Logger,
  accountId: string,
  event: WeixinUpdatesRetryEvent,
): void {
  const details = {
    surface: "weixin",
    accountId,
    attempt: event.attempt,
    code: event.code,
    delayMs: event.delayMs,
    phase: event.phase,
    ...(event.returnCode === undefined
      ? {}
      : { returnCode: event.returnCode }),
    ...(event.status === undefined ? {} : { status: event.status }),
  };
  if (event.phase === "credential-pause") {
    logger.warn(
      details,
      "微信 Bot Token 已失效，已暂停轮询；请重新运行 codexc setup",
    );
    return;
  }
  logger.warn(
    details,
    event.phase === "backoff"
      ? "微信长轮询连续失败，进入退避后将自动恢复"
      : "微信长轮询暂时失败，将自动重试",
  );
}
