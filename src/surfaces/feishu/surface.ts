import type { Logger } from "pino";

import type { ConversationUseCases } from "../../application/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";
import type {
  OperationUpdateDisplay,
  SurfaceAdapter,
  SurfaceConfigurationChange,
} from "../types.js";
import { surfaceErrorMetadata } from "../error-metadata.js";
import { FeishuConversationAdapter } from "./adapter.js";
import {
  FeishuApplicationHttpApi,
  type FeishuApplicationApi,
} from "./application-api.js";
import {
  FeishuApplicationSetupController,
} from "./application-setup.js";
import {
  createFeishuOAuthApi,
  FeishuMessageError,
  FeishuMessageClient,
  type FeishuQuotedMessagePort,
} from "./client.js";
import {
  FeishuEventConnection,
  type FeishuEventConnectionOptions,
} from "./event-connection.js";
import {
  FeishuCommandCenter,
  feishuCommandMenuEventKey,
} from "./command-center.js";
import {
  FeishuFileInput,
  type FeishuFilePort,
} from "./file-input.js";
import { FeishuInbox } from "./inbox.js";
import { FeishuInteractionPort } from "./interactions.js";
import {
  FeishuImageStore,
  type FeishuImagePort,
} from "./media.js";
import {
  FeishuAudioStore,
  type FeishuAudioPort,
} from "./audio.js";
import type { FeishuMessageEventError } from "./message-event.js";
import type {
  FeishuMenuEvent,
  FeishuMenuEventError,
} from "./menu-event.js";
import {
  FeishuOutbox,
  type FeishuMessagePort,
} from "./outbox.js";
import {
  FeishuOAuthController,
  type FeishuOAuthControllerPort,
} from "./oauth.js";
import { createFeishuUserTokenStore } from "./oauth-token-store.js";
import { renderFeishuConfigurationChange } from "./renderer.js";

interface FeishuEventConnectionPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  resetAfterStartFailure?(): void;
}

interface FeishuSurfaceDependencies {
  messagePort?: FeishuMessagePort;
  imagePort?: FeishuImagePort;
  audioPort?: FeishuAudioPort;
  filePort?: FeishuFilePort;
  quotedMessagePort?: FeishuQuotedMessagePort;
  createEventConnection: (
    options: FeishuEventConnectionOptions,
  ) => FeishuEventConnectionPort;
  oauth?: FeishuOAuthControllerPort & { close(): Promise<void> };
  applicationApi?: FeishuApplicationApi;
}

export interface FeishuStartupNotification {
  messages(): ReadonlyArray<{ chatId: string; text: string }>;
}

export interface FeishuSurfaceOptions {
  appId: string;
  appSecret: string;
  service: ConversationUseCases;
  access: SurfaceAccessPolicy;
  logger: Logger;
  uploadsDirectory: string;
  credentialsDirectory: string;
  onFatal: (error: Error) => void;
  actorRegistry?: ConversationActorRegistry;
  openApiAgent?: unknown;
  accountsAgent?: unknown;
  webSocketAgent?: unknown;
  disableEnvironmentProxy?: boolean;
  operationUpdateDisplay?: OperationUpdateDisplay;
  planUpdatesEnabled?: boolean;
  debugEnabled?: boolean;
  configurationRecipients?: () => readonly string[];
  startupNotification?: FeishuStartupNotification;
}

export function createFeishuSurface(
  options: FeishuSurfaceOptions,
): FeishuSurface {
  return new FeishuSurface(options);
}

export class FeishuSurface implements SurfaceAdapter {
  readonly surface = "feishu" as const;
  readonly accountId: string;
  readonly interactions: FeishuInteractionPort;
  readonly output: FeishuOutbox;

  private readonly inbox: FeishuInbox;
  private readonly adapter: FeishuConversationAdapter;
  private readonly commandCenter: FeishuCommandCenter;
  private readonly applicationSetup: FeishuApplicationSetupController;
  private readonly images: FeishuImagePort;
  private readonly audios: FeishuAudioPort;
  private readonly connection: FeishuEventConnectionPort;
  private readonly oauth: FeishuOAuthControllerPort & {
    close(): Promise<void>;
  };
  private readonly configurationRecipients:
    | (() => readonly string[])
    | undefined;
  private readonly startupNotification:
    | FeishuStartupNotification
    | undefined;
  private readonly logger: Logger;
  private readonly overloadNotifiedChats = new Set<string>();
  private connectionReady = false;
  private cardActionObserved = false;
  private menuEventObserved = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    options: FeishuSurfaceOptions,
    dependencies: FeishuSurfaceDependencies = defaultDependencies,
  ) {
    this.accountId = options.appId;
    this.configurationRecipients = options.configurationRecipients;
    this.startupNotification = options.startupNotification;
    this.logger = options.logger;
    const client = dependencies.messagePort
        && dependencies.imagePort
        && dependencies.audioPort
      ? undefined
      : new FeishuMessageClient({
          appId: options.appId,
          appSecret: options.appSecret,
          ...(options.openApiAgent
            ? { httpAgent: options.openApiAgent }
            : {}),
        ...(options.disableEnvironmentProxy
          ? { disableEnvironmentProxy: true }
          : {}),
      });
    const messagePort = dependencies.messagePort ?? client!;
    const quotedMessages = dependencies.quotedMessagePort ?? client;
    this.images = dependencies.imagePort ?? new FeishuImageStore(
      options.uploadsDirectory,
      client!,
      options.logger,
    );
    this.audios = dependencies.audioPort ?? new FeishuAudioStore(
      options.uploadsDirectory,
      client!,
      options.logger,
    );
    const files = dependencies.filePort
      ?? (client === undefined ? undefined : new FeishuFileInput(client));
    this.output = new FeishuOutbox(
      options.appId,
      messagePort,
      options.logger,
      {
        ...(options.operationUpdateDisplay !== undefined
          ? { operationUpdateDisplay: options.operationUpdateDisplay }
          : {}),
        ...(options.planUpdatesEnabled !== undefined
          ? { planUpdatesEnabled: options.planUpdatesEnabled }
          : {}),
      },
    );
    this.interactions = new FeishuInteractionPort(
      this.output,
      options.actorRegistry,
      options.access,
      options.logger,
    );
    this.oauth = dependencies.oauth ?? new FeishuOAuthController(
      options.appId,
      createFeishuOAuthApi({
        appId: options.appId,
        appSecret: options.appSecret,
        ...(options.openApiAgent
          ? { httpAgent: options.openApiAgent }
          : {}),
        ...(options.disableEnvironmentProxy
          ? { disableEnvironmentProxy: true }
          : {}),
      }, options.accountsAgent),
      createFeishuUserTokenStore(options.credentialsDirectory),
      this.output,
      options.logger,
    );
    this.applicationSetup = new FeishuApplicationSetupController(
      options.appId,
      dependencies.applicationApi ?? new FeishuApplicationHttpApi({
        appId: options.appId,
        appSecret: options.appSecret,
        ...(options.openApiAgent
          ? { httpAgent: options.openApiAgent }
          : {}),
        ...(options.disableEnvironmentProxy
          ? { disableEnvironmentProxy: true }
          : {}),
      }),
      this.output,
      options.access,
      options.logger,
    );
    this.adapter = new FeishuConversationAdapter(
      options.service,
      this.output,
      this.images,
      () => ({
        connectionReady: this.connectionReady,
        cardActionObserved: this.cardActionObserved,
        menuEventObserved: this.menuEventObserved,
      }),
      this.oauth,
      {
        open: (target, actorId) =>
          this.commandCenter.open(target, actorId),
      },
      this.applicationSetup,
      this.interactions,
      {
        quietWindowMs: 0,
        debugEnabled: options.debugEnabled ?? false,
        ...(files === undefined ? {} : { files }),
        audios: this.audios,
        ...(quotedMessages === undefined
          ? {}
          : {
              readQuotedText: (messageId: string) =>
                quotedMessages.readQuotedText(messageId),
              onQuotedTextError: (error: unknown) => {
                this.logger.warn(
                  {
                    surface: "feishu",
                    errorCode: error instanceof FeishuMessageError
                      ? error.code
                      : "unknown",
                  },
                  "飞书引用消息读取失败，已忽略引用上下文",
                );
              },
            }),
      },
    );
    this.commandCenter = new FeishuCommandCenter(
      this.output,
      options.access,
      (target, action, actorId, input) =>
        this.adapter.handleCommandCenterAction(
          target,
          action,
          actorId,
          input,
        ),
      options.logger,
    );
    this.inbox = new FeishuInbox({
      accountId: options.appId,
      access: options.access,
      ...(options.actorRegistry
        ? { actorRegistry: options.actorRegistry }
        : {}),
      handle: (message) => this.adapter.handle(message),
      handleImageBatch: (messages) =>
        this.adapter.handleImageBatch(messages),
      inputQuietWindowMs: 0,
      handleError: (error) => {
        options.logger.warn(
          {
            surface: error.target.surface,
            accountId: error.target.accountId,
            conversationId: error.target.conversationId,
            messageId: error.messageId,
            errorType: error.errorType,
            ...(error.errorCode === undefined
              ? {}
              : { errorCode: error.errorCode }),
            ...(error.errorReason === undefined
              ? {}
              : { errorReason: error.errorReason }),
          },
          "飞书消息处理失败",
        );
      },
      handleCloseTimeout: (pendingCount) => {
        options.logger.warn(
          { pendingCount },
          "飞书输入队列关闭等待超时",
        );
      },
    });
    this.connection = dependencies.createEventConnection({
      appId: options.appId,
      appSecret: options.appSecret,
      ...(options.webSocketAgent
        ? { webSocketAgent: options.webSocketAgent }
        : {}),
      onMessage: (event) => {
        const result = this.inbox.receive(event);
        options.logger.debug(
          {
            surface: "feishu",
            accountId: options.appId,
            messageType: event.messageType,
            outcome: result.status,
            ...(result.status === "accepted" ? {} : { reason: result.reason }),
          },
          "飞书输入已到达 Gateway",
        );
        if (result.status === "accepted") {
          this.overloadNotifiedChats.delete(event.chatId);
        } else if (
          result.status === "retry"
          && !this.overloadNotifiedChats.has(event.chatId)
        ) {
          const notified = this.output.notifyText(
            event.chatId,
            "当前飞书输入队列繁忙，请稍后重试。",
          );
          if (notified) {
            this.overloadNotifiedChats.add(event.chatId);
          }
          options.logger.warn(
            {
              reason: result.reason,
              notified,
            },
            "飞书输入队列过载，事件未接收",
          );
        }
      },
      onInvalidMessage: (error) => {
        logInvalidMessage(options.logger, error);
      },
      onCardAction: (action) => {
        this.cardActionObserved = true;
        const setupResult = this.applicationSetup.handleCardAction(action);
        if (setupResult === "accepted") {
          return;
        }
        if (setupResult === "invalid") {
          options.logger.warn(
            this.lifecycleContext(),
            "飞书应用配置动作未处理",
          );
          return;
        }
        const commandResult = this.commandCenter.handleCardAction(action);
        if (commandResult === "accepted") {
          return;
        }
        if (commandResult === "invalid") {
          options.logger.warn(
            this.lifecycleContext(),
            "飞书命令中心动作未处理",
          );
          return;
        }
        const result = this.interactions.handleCardAction(action);
        if (result !== "accepted") {
          options.logger.warn(
            {
              ...this.lifecycleContext(),
              result,
            },
            "飞书卡片动作未处理",
          );
        }
      },
      onInvalidCardAction: (error) => {
        options.logger.warn(
          {
            errorCode: error.code,
            field: error.field,
          },
          "飞书卡片动作格式无效",
        );
      },
      onMenuEvent: (event) => {
        try {
          this.handleMenuEvent(event, options);
        } catch (error) {
          options.logger.warn(
            {
              ...this.lifecycleContext(),
              ...surfaceErrorMetadata(error),
            },
            "飞书机器人菜单路由失败",
          );
        }
      },
      onInvalidMenuEvent: (error) => {
        logInvalidMenuEvent(options.logger, error);
      },
      onReconnecting: () => {
        this.connectionReady = false;
        this.logger.warn(this.lifecycleContext(), "飞书长连接正在重连");
      },
      onReconnected: () => {
        this.connectionReady = true;
        this.logger.info(this.lifecycleContext(), "飞书长连接已恢复");
      },
      onFatal: options.onFatal,
    });
  }

  async start(): Promise<void> {
    const imagesStarting = this.images.start();
    const audiosStarting = this.audios.start();
    this.logger.info(this.lifecycleContext(), "飞书长连接正在连接");
    const connectionStarting = this.connection.start();
    try {
      await Promise.all([imagesStarting, audiosStarting, connectionStarting]);
    } catch (error) {
      this.connection.resetAfterStartFailure?.();
      throw error;
    }
    this.connectionReady = true;
    this.logger.info(this.lifecycleContext(), "飞书长连接已就绪");
    this.sendStartupNotifications();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.connectionReady = false;
    await this.connection.stop();
    await this.inbox.close();
    await this.adapter.close();
    await this.applicationSetup.close();
    await this.oauth.close();
    this.images.close();
    this.audios.close();
    await this.interactions.close();
    await this.commandCenter.close();
    await this.output.close();
    this.logger.info(this.lifecycleContext(), "飞书 Surface 已停止");
  }

  configurationChanged(change: SurfaceConfigurationChange): void {
    if (!this.configurationRecipients) {
      return;
    }
    const text = renderFeishuConfigurationChange(change);
    for (const chatId of this.safeConfigurationRecipients()) {
      if (!this.output.notifyText(chatId, text)) {
        this.logger.warn(
          { accountId: this.accountId, conversationId: chatId },
          "飞书配置通知未进入输出队列",
        );
      }
    }
  }

  deliverConfigurationChange(
    change: SurfaceConfigurationChange,
  ): Promise<void> {
    if (!this.configurationRecipients) {
      return Promise.reject(
        new Error("飞书 Surface 尚未配置安全的配置通知收件人"),
      );
    }
    const text = renderFeishuConfigurationChange(change);
    return Promise.all(
      this.safeConfigurationRecipients().map(
        (chatId) => this.output.deliverText(chatId, text),
      ),
    ).then(() => undefined);
  }

  private safeConfigurationRecipients(): string[] {
    const recipients = [...new Set(this.configurationRecipients?.() ?? [])];
    for (const chatId of recipients) {
      if (!/^oc_.+$/u.test(chatId)) {
        throw new Error("飞书配置通知包含无效 Chat ID");
      }
    }
    return recipients;
  }

  private sendStartupNotifications(): void {
    if (!this.startupNotification) {
      return;
    }
    let messages: ReadonlyArray<{ chatId: string; text: string }>;
    try {
      messages = this.startupNotification.messages();
    } catch (error) {
      this.logger.warn(
        {
          ...this.lifecycleContext(),
          ...surfaceErrorMetadata(error),
        },
        "飞书启动联通通知生成失败",
      );
      return;
    }
    const delivered = new Set<string>();
    for (const { chatId, text } of messages) {
      if (!/^oc_.+$/u.test(chatId)) {
        this.logger.warn(
          this.lifecycleContext(),
          "飞书启动联通通知收件人无效",
        );
        continue;
      }
      if (delivered.has(chatId)) {
        continue;
      }
      delivered.add(chatId);
      if (!this.output.notifyMarkdown(chatId, text)) {
        this.logger.warn(
          {
            ...this.lifecycleContext(),
            conversationId: chatId,
          },
          "飞书启动联通通知未进入输出队列",
        );
      }
    }
  }

  private handleMenuEvent(
    event: FeishuMenuEvent,
    options: Pick<
      FeishuSurfaceOptions,
      "access" | "actorRegistry"
    >,
  ): void {
    if (
      event.appId !== this.accountId
      || event.eventKey !== feishuCommandMenuEventKey
    ) {
      this.logger.warn(
        {
          ...this.lifecycleContext(),
          reason: event.appId !== this.accountId
            ? "account-mismatch"
            : "unsupported-event-key",
        },
        "飞书机器人菜单事件未处理",
      );
      return;
    }
    this.menuEventObserved = true;
    const target = this.resolveMenuTarget(event.actorOpenId, options);
    if (!target) {
      this.logger.warn(
        this.lifecycleContext(),
        "飞书机器人菜单没有唯一已授权私聊",
      );
      return;
    }
    void this.commandCenter.openFromMenu(
      target,
      event.actorOpenId,
      event.eventId,
    ).catch((error: unknown) => {
      this.logger.warn(
        {
          ...this.lifecycleContext(),
          conversationId: target.conversationId,
          ...surfaceErrorMetadata(error),
        },
        "飞书机器人菜单卡片发送失败",
      );
    });
  }

  private resolveMenuTarget(
    actorId: string,
    options: Pick<
      FeishuSurfaceOptions,
      "access" | "actorRegistry"
    >,
  ): ConversationTarget | undefined {
    if (!options.actorRegistry || !this.configurationRecipients) {
      return undefined;
    }
    const candidates = this.safeConfigurationRecipients().flatMap(
      (conversationId): ConversationTarget[] => {
        const target: ConversationTarget = {
          surface: "feishu",
          accountId: this.accountId,
          conversationId,
        };
        return options.actorRegistry!.actors(target).includes(actorId)
          && options.access.isAllowed({ target, actorId })
          ? [target]
          : [];
      },
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private lifecycleContext(): {
    surface: "feishu";
    accountId: string;
  } {
    return {
      surface: this.surface,
      accountId: this.accountId,
    };
  }
}

function logInvalidMessage(
  logger: Logger,
  error: FeishuMessageEventError,
): void {
  logger.warn(
    {
      errorCode: error.code,
      field: error.field,
    },
    "飞书消息事件格式无效",
  );
}

function logInvalidMenuEvent(
  logger: Logger,
  error: FeishuMenuEventError,
): void {
  logger.warn(
    {
      errorCode: error.code,
      field: error.field,
    },
    "飞书机器人菜单事件格式无效",
  );
}

const defaultDependencies: FeishuSurfaceDependencies = {
  createEventConnection: (options) => new FeishuEventConnection(options),
};
