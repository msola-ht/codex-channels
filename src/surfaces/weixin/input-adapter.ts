import type { ConversationService } from "../../application/index.js";
import type { ConversationTarget } from "../../conversation-core/index.js";
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
import type { WeixinUpdatesCursorStore } from "./updates-cursor-store.js";
import { createWeixinUpdatesMonitor } from "./updates-monitor.js";

type WeixinTextMessage = Extract<
  WeixinInboundMessage,
  { kind: "text" }
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
  service: Pick<ConversationService, "submit">;
  access: SurfaceAccessPolicy;
  actorRegistry?: ConversationActorRegistry;
  onFatal(error: WeixinInputFatalError): void;
  onStopTimeout?(): void;
  closeTimeoutMs?: number;
}

export class WeixinInputAdapter {
  readonly accountId: string;

  private readonly closeTimeoutMs: number;
  private readonly monitor;
  private controller: AbortController | undefined;
  private runTask: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopping = false;

  constructor(private readonly options: WeixinInputAdapterOptions) {
    this.accountId = options.accountId;
    this.closeTimeoutMs = positiveInteger(
      options.closeTimeoutMs ?? 5_000,
      "微信输入关闭超时时间无效",
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

  private async handle(message: WeixinTextMessage): Promise<void> {
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
      return;
    }
    this.options.actorRegistry?.rememberActor(target, message.actorId);
    try {
      await this.options.service.submit(target, message.text);
    } catch (error) {
      throw new WeixinMessageProcessingError({ cause: error });
    }
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
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
