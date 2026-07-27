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

import {
  WeixinInputAdapter,
  type WeixinInputFatalError,
} from "./input-adapter.js";
import { WeixinInteractionPort } from "./interactions.js";
import {
  WeixinOutbox,
  type WeixinOutboxOptions,
} from "./outbox.js";
import type { WeixinProtocolClient } from "./protocol-client.js";
import { WeixinReplyContextStore } from "./reply-context-store.js";
import type { WeixinUpdatesCursorStore } from "./updates-cursor-store.js";

export interface WeixinSurfaceOptions {
  accountId: string;
  client: WeixinProtocolClient;
  cursorStore: WeixinUpdatesCursorStore;
  service: Pick<ConversationService, "submit">;
  access: SurfaceAccessPolicy;
  logger: Logger;
  onFatal: (error: WeixinInputFatalError) => void;
  actorRegistry?: ConversationActorRegistry;
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
  private stopPromise: Promise<void> | undefined;

  constructor(options: WeixinSurfaceOptions) {
    const replyContexts = new WeixinReplyContextStore(options.accountId);
    this.accountId = options.accountId;
    this.interactions = new WeixinInteractionPort();
    this.output = new WeixinOutbox(
      options.accountId,
      options.client,
      replyContexts,
      options.access,
      options.logger,
      options.outbox,
    );
    this.input = new WeixinInputAdapter({
      accountId: options.accountId,
      client: options.client,
      cursorStore: options.cursorStore,
      service: options.service,
      access: options.access,
      replyContexts,
      ...(options.actorRegistry === undefined
        ? {}
        : { actorRegistry: options.actorRegistry }),
      onFatal: options.onFatal,
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
    return this.input.start();
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
      this.interactions.cancelAll("Gateway 已停止");
      await this.output.close();
    }
  }
}
