import type { Logger } from "pino";

import type { ConversationUseCases } from "../../application/index.js";
import type {
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
} from "../../application/index.js";
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
import { formatSurfaceConfigurationChange } from "../configuration-change-format.js";
import { surfaceErrorMetadata } from "../error-metadata.js";

import {
  WeixinInputAdapter,
  type WeixinInputFatalError,
} from "./input-adapter.js";
import type { WeixinAudioPort } from "./audio-store.js";
import type { WeixinFilePort } from "./file-input.js";
import type { WeixinImagePort } from "./image-store.js";
import type { WeixinCredentialStore } from "./credential-store.js";
import { WeixinInteractionPort } from "./interactions.js";
import {
  WeixinOutbox,
  type WeixinOutboxOptions,
} from "./outbox.js";
import type {
  WeixinFileSendProtocolClient,
  WeixinImageSendProtocolClient,
  WeixinLifecycleProtocolClient,
  WeixinProtocolClient,
  WeixinTypingProtocolClient,
} from "./protocol-client.js";
import { WeixinProtocolError } from "./protocol-client.js";
import { WeixinReplyContextStore } from "./reply-context-store.js";
import type { WeixinReplyContextPersistence } from "./reply-context-persistence.js";
import { formatWeixinCommandText } from "./command-renderer.js";
import type { WeixinUpdatesCursorStore } from "./updates-cursor-store.js";
import type { WeixinUpdatesRetryEvent } from "./updates-monitor.js";
import { WeixinTypingController } from "./typing-controller.js";

export interface WeixinStartupNotification {
  targets(): readonly ConversationTarget[];
  text(target: ConversationTarget): string;
}

export interface WeixinSurfaceOptions {
  accountId: string;
  client: WeixinProtocolClient;
  fileSendClient?: WeixinFileSendProtocolClient;
  imageSendClient?: WeixinImageSendProtocolClient;
  typingClient?: WeixinTypingProtocolClient;
  lifecycleClient?: WeixinLifecycleProtocolClient;
  cursorStore: WeixinUpdatesCursorStore;
  service: ConversationUseCases;
  access: SurfaceAccessPolicy;
  logger: Logger;
  onFatal: (error: WeixinInputFatalError) => void;
  actorRegistry?: ConversationActorRegistry;
  replyContextPersistence?: WeixinReplyContextPersistence;
  credentialStore?: Pick<WeixinCredentialStore, "get">;
  images?: WeixinImagePort;
  files?: WeixinFilePort;
  audios?: WeixinAudioPort;
  startupNotification?: WeixinStartupNotification;
  operationUpdateDisplay?: OperationUpdateDisplay;
  planUpdatesEnabled?: boolean;
  debugEnabled?: boolean;
  exchangeRate?: () => ExchangeRateSnapshot | null;
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency;
  inputCloseTimeoutMs?: number;
  outbox?: WeixinOutboxOptions;
}

export class WeixinConfigurationDeliveryError extends Error {
  constructor() {
    super("微信 Surface 尚未配置安全的配置通知收件人");
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
  private readonly audios: WeixinAudioPort | undefined;
  private readonly lifecycleClient: WeixinLifecycleProtocolClient | undefined;
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
    this.audios = options.audios;
    this.lifecycleClient = options.lifecycleClient;
    this.accountId = options.accountId;
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
        ...(options.fileSendClient === undefined
          ? {}
          : { fileClient: options.fileSendClient }),
        ...(typing === undefined ? {} : { typing }),
        ...(options.operationUpdateDisplay === undefined
          ? {}
          : {
              operationUpdateDisplay: options.operationUpdateDisplay,
            }),
        ...(options.planUpdatesEnabled === undefined
          ? {}
          : {
              planUpdatesEnabled: options.planUpdatesEnabled,
            }),
        ...(options.exchangeRate === undefined
          ? {}
          : { exchangeRate: options.exchangeRate }),
        ...(options.priceCurrency === undefined
          ? {}
          : { priceCurrency: options.priceCurrency }),
        ...(options.replyContextPersistence === undefined
          ? {}
          : {
              onReplyContextInvalidated: (target) =>
                options.replyContextPersistence!.remove(target),
            }),
      },
    );
    this.interactions = new WeixinInteractionPort(
      this.output,
      options.actorRegistry,
      options.access,
      options.logger,
    );
    this.input = new WeixinInputAdapter({
      accountId: options.accountId,
      client: options.client,
      cursorStore: options.cursorStore,
      service: options.service,
      outbox: this.output,
      access: options.access,
      replyContexts,
      interactions: this.interactions,
      ...(options.images === undefined ? {} : { images: options.images }),
      ...(options.files === undefined ? {} : { files: options.files }),
      ...(options.audios === undefined ? {} : { audios: options.audios }),
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
      ...(options.credentialStore === undefined
        || options.replyContextPersistence === undefined
        ? {}
        : {
            doctor: {
              credentialStore: options.credentialStore,
              replyContextPersistence: options.replyContextPersistence,
            },
          }),
      ...(options.actorRegistry === undefined
        ? {}
        : { actorRegistry: options.actorRegistry }),
      onFatal: options.onFatal,
      debugEnabled: options.debugEnabled ?? false,
      ...(options.exchangeRate === undefined
        ? {}
        : { exchangeRate: options.exchangeRate }),
      ...(options.priceCurrency === undefined
        ? {}
        : { priceCurrency: options.priceCurrency }),
      logger: options.logger,
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
    this.startPromise ??= this.startOnce().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  configurationChanged(change: SurfaceConfigurationChange): void {
    if (!this.startupNotification) {
      return;
    }
    const text = formatWeixinCommandText(
      formatSurfaceConfigurationChange(change, "weixin"),
    );
    for (const target of this.safeConfigurationTargets()) {
      if (!this.output.notifyText(target, text)) {
        this.logger.warn(
          {
            surface: "weixin",
            accountId: this.accountId,
            conversationId: target.conversationId,
          },
          "微信配置通知未进入输出队列",
        );
      }
    }
  }

  deliverConfigurationChange(
    change: SurfaceConfigurationChange,
  ): Promise<void> {
    if (!this.startupNotification) {
      return Promise.reject(new WeixinConfigurationDeliveryError());
    }
    const text = formatWeixinCommandText(
      formatSurfaceConfigurationChange(change, "weixin"),
    );
    return Promise.all(
      this.safeConfigurationTargets().map(
        (target) => this.output.deliverText(target, text),
      ),
    ).then(() => undefined);
  }

  private async stopOnce(): Promise<void> {
    try {
      await this.input.stop();
    } finally {
      await this.notifyLifecycle("stop");
      this.images?.close();
      this.audios?.close();
      this.interactions.close();
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
    await Promise.all([
      this.images?.start(),
      this.audios?.start(),
    ]);
    await this.input.start();
    await this.notifyLifecycle("start");
    for (const target of restored) {
      try {
        const text = this.startupNotification?.text(target);
        if (text) {
          await this.output.deliverText(
            target,
            formatWeixinCommandText(text, { structuredFields: true }),
          );
        }
      } catch (error) {
        this.logger.warn(
          {
            surface: "weixin",
            accountId: this.accountId,
            conversationId: target.conversationId,
            ...weixinSurfaceErrorMetadata(error),
          },
          "微信启动联通通知发送失败，不影响长轮询",
        );
      }
    }
  }

  private async notifyLifecycle(
    state: "start" | "stop",
  ): Promise<void> {
    if (!this.lifecycleClient) {
      return;
    }
    try {
      if (state === "start") {
        await this.lifecycleClient.notifyStart();
      } else {
        await this.lifecycleClient.notifyStop();
      }
    } catch (error) {
      this.logger.warn(
        {
          surface: "weixin",
          accountId: this.accountId,
          state,
          ...weixinSurfaceErrorMetadata(error),
        },
        `微信${state === "start" ? "上线" : "下线"}状态对账失败，不影响 Gateway`,
      );
    }
  }

  private safeConfigurationTargets(): ConversationTarget[] {
    const targets = this.startupNotification?.targets() ?? [];
    const seen = new Set<string>();
    return targets.filter((target) => {
      if (
        target.surface !== "weixin"
        || target.accountId !== this.accountId
        || seen.has(target.conversationId)
      ) {
        return false;
      }
      seen.add(target.conversationId);
      const context = this.replyContexts.get(target);
      return context !== undefined
        && this.access.isAllowed({ target, actorId: context.actorId });
    });
  }
}

function weixinSurfaceErrorMetadata(
  error: unknown,
): Record<string, unknown> {
  if (error instanceof WeixinProtocolError) {
    return {
      ...surfaceErrorMetadata(error),
      errorCode: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.returnCode === undefined
        ? {}
        : { returnCode: error.returnCode }),
    };
  }
  return surfaceErrorMetadata(error);
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
