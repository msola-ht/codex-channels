import type { Logger } from "pino";

import type { ConversationService } from "../../application/index.js";
import type {
  ConversationActorRegistry,
  SurfaceAccessPolicy,
} from "../../policy/index.js";
import type {
  SurfaceAdapter,
  SurfaceConfigurationChange,
} from "../types.js";
import { FeishuConversationAdapter } from "./adapter.js";
import {
  FeishuEventConnection,
  FeishuMessageClient,
  type FeishuEventConnectionOptions,
} from "./client.js";
import { FeishuInbox } from "./inbox.js";
import { FeishuInteractionPort } from "./interactions.js";
import {
  FeishuImageStore,
  type FeishuImagePort,
} from "./media.js";
import type { FeishuMessageEventError } from "./message-event.js";
import {
  FeishuOutbox,
  type FeishuMessagePort,
} from "./outbox.js";
import { renderFeishuConfigurationChange } from "./renderer.js";

interface FeishuEventConnectionPort {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface FeishuSurfaceDependencies {
  messagePort?: FeishuMessagePort;
  imagePort?: FeishuImagePort;
  createEventConnection: (
    options: FeishuEventConnectionOptions,
  ) => FeishuEventConnectionPort;
}

export interface FeishuSurfaceOptions {
  appId: string;
  appSecret: string;
  service: ConversationService;
  access: SurfaceAccessPolicy;
  logger: Logger;
  uploadsDirectory: string;
  onFatal: (error: Error) => void;
  actorRegistry?: ConversationActorRegistry;
  webSocketAgent?: unknown;
  configurationRecipients?: () => readonly string[];
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
  private readonly images: FeishuImagePort;
  private readonly connection: FeishuEventConnectionPort;
  private readonly configurationRecipients:
    | (() => readonly string[])
    | undefined;
  private readonly logger: Logger;
  private connectionReady = false;
  private cardActionObserved = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    options: FeishuSurfaceOptions,
    dependencies: FeishuSurfaceDependencies = defaultDependencies,
  ) {
    this.accountId = options.appId;
    this.configurationRecipients = options.configurationRecipients;
    this.logger = options.logger;
    const client = dependencies.messagePort && dependencies.imagePort
      ? undefined
      : new FeishuMessageClient({
          appId: options.appId,
          appSecret: options.appSecret,
        });
    const messagePort = dependencies.messagePort ?? client!;
    this.images = dependencies.imagePort ?? new FeishuImageStore(
      options.uploadsDirectory,
      client!,
      options.logger,
    );
    this.output = new FeishuOutbox(
      options.appId,
      messagePort,
      options.logger,
    );
    this.interactions = new FeishuInteractionPort(
      this.output,
      options.actorRegistry,
      options.access,
      options.logger,
    );
    const adapter = new FeishuConversationAdapter(
      options.service,
      this.output,
      this.images,
      () => ({
        connectionReady: this.connectionReady,
        cardActionObserved: this.cardActionObserved,
      }),
    );
    this.inbox = new FeishuInbox({
      accountId: options.appId,
      access: options.access,
      ...(options.actorRegistry
        ? { actorRegistry: options.actorRegistry }
        : {}),
      handle: (message) => adapter.handle(message),
      handleError: (error) => {
        options.logger.warn(
          {
            surface: error.target.surface,
            accountId: error.target.accountId,
            conversationId: error.target.conversationId,
            messageId: error.messageId,
            errorType: error.errorType,
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
        if (result.status === "retry") {
          const notified = this.output.notifyText(
            event.chatId,
            "当前飞书输入队列繁忙，请稍后重试。",
          );
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
    this.logger.info(this.lifecycleContext(), "飞书长连接正在连接");
    const connectionStarting = this.connection.start();
    try {
      await Promise.all([imagesStarting, connectionStarting]);
    } catch (error) {
      await this.connection.stop();
      this.images.close();
      throw error;
    }
    this.connectionReady = true;
    this.logger.info(this.lifecycleContext(), "飞书长连接已就绪");
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.connectionReady = false;
    await this.connection.stop();
    await this.inbox.close();
    this.images.close();
    await this.interactions.close();
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

const defaultDependencies: FeishuSurfaceDependencies = {
  createEventConnection: (options) => new FeishuEventConnection(options),
};
