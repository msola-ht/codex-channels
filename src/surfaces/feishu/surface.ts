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
  FeishuTextMessageClient,
  type FeishuEventConnectionOptions,
} from "./client.js";
import { FeishuInbox } from "./inbox.js";
import { FeishuInteractionPort } from "./interactions.js";
import type { FeishuMessageEventError } from "./message-event.js";
import {
  FeishuOutbox,
  type FeishuTextMessagePort,
} from "./outbox.js";

interface FeishuEventConnectionPort {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface FeishuSurfaceDependencies {
  messagePort?: FeishuTextMessagePort;
  createEventConnection: (
    options: FeishuEventConnectionOptions,
  ) => FeishuEventConnectionPort;
}

export interface FeishuSurfaceOptions {
  appId: string;
  appSecret: string;
  service: Pick<ConversationService, "submit">;
  access: SurfaceAccessPolicy;
  logger: Logger;
  onFatal: (error: Error) => void;
  actorRegistry?: ConversationActorRegistry;
  webSocketAgent?: unknown;
}

export function createFeishuSurface(
  options: FeishuSurfaceOptions,
): SurfaceAdapter {
  return new FeishuSurface(options);
}

export class FeishuSurface implements SurfaceAdapter {
  readonly surface = "feishu" as const;
  readonly accountId: string;
  readonly interactions = new FeishuInteractionPort();
  readonly output: FeishuOutbox;

  private readonly inbox: FeishuInbox;
  private readonly connection: FeishuEventConnectionPort;

  constructor(
    options: FeishuSurfaceOptions,
    dependencies: FeishuSurfaceDependencies = defaultDependencies,
  ) {
    this.accountId = options.appId;
    const messagePort = dependencies.messagePort ?? new FeishuTextMessageClient({
      appId: options.appId,
      appSecret: options.appSecret,
    });
    this.output = new FeishuOutbox(
      options.appId,
      messagePort,
      options.logger,
    );
    const adapter = new FeishuConversationAdapter(
      options.service,
      this.output,
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
      onFatal: options.onFatal,
    });
  }

  start(): Promise<void> {
    return this.connection.start();
  }

  async stop(): Promise<void> {
    await this.connection.stop();
    await this.inbox.close();
    this.interactions.cancelAll("Surface stopped");
    await this.output.close();
  }

  deliverConfigurationChange(
    change: SurfaceConfigurationChange,
  ): Promise<void> {
    void change;
    return Promise.reject(
      new Error("飞书 Surface 尚未配置安全的配置通知收件人"),
    );
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
