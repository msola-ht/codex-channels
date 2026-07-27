import type { Logger } from "pino";

import {
  isCriticalOutputEvent,
  type ConversationTarget,
  type OutputEvent,
} from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import type {
  OperationUpdateDisplay,
  SurfaceOutputPort,
} from "../types.js";

import { validateWeixinAccountId } from "./credential-store.js";
import {
  WeixinProtocolError,
  type WeixinProtocolClient,
} from "./protocol-client.js";
import { WeixinReplyContextStore } from "./reply-context-store.js";
import {
  formatWeixinCommandText,
  renderWeixinTurnCompleted,
} from "./command-renderer.js";
import { formatWeixinFinalText } from "./final-text-format.js";
import { formatWeixinOperation } from "./operation-format.js";

const maximumChunkCharacters = 4_000;
const maximumChunks = 5;
const truncationNotice = "\n\n[内容过长，已截断]";

export type WeixinOutboxErrorCode =
  | "missing-reply-context"
  | "unauthorized-recipient";

export class WeixinOutboxError extends Error {
  constructor(readonly code: WeixinOutboxErrorCode) {
    super("微信消息无法发送");
    this.name = "WeixinOutboxError";
  }
}

export interface WeixinOutboxOptions {
  capacity?: number;
  closeTimeoutMs?: number;
  operationUpdateDisplay?: OperationUpdateDisplay;
  onReplyContextInvalidated?: (target: ConversationTarget) => Promise<void>;
}

export class WeixinOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
  private readonly accountId: string;
  private closed = false;

  constructor(
    accountId: string,
    private readonly client: Pick<WeixinProtocolClient, "sendText">,
    private readonly contexts: WeixinReplyContextStore,
    private readonly access: SurfaceAccessPolicy,
    logger: Logger,
    private readonly options: WeixinOutboxOptions = {},
  ) {
    this.accountId = validateWeixinAccountId(accountId);
    this.delivery = new ConversationDeliveryQueue(logger, {
      component: "Weixin",
      ...(options.capacity === undefined
        ? {}
        : { capacity: options.capacity }),
      ...(options.closeTimeoutMs === undefined
        ? {}
        : { closeTimeoutMs: options.closeTimeoutMs }),
      errorMetadata: weixinOutputErrorMetadata,
    });
  }

  handle(event: OutputEvent): void {
    if (
      this.closed
      || event.target.surface !== "weixin"
      || event.target.accountId !== this.accountId
    ) {
      return;
    }
    if (event.type === "operation.updated") {
      if (
        this.options.operationUpdateDisplay === "hidden"
        || event.operation.status === "running"
      ) {
        return;
      }
      const rendered = formatWeixinOperation(
        event.operation,
        this.options.operationUpdateDisplay === "compact"
          ? "compact"
          : "full",
      );
      this.delivery.enqueue(
        event.target.conversationId,
        () => this.send(event.target, rendered),
        true,
      );
      return;
    }
    const rendered = this.render(event);
    if (rendered === null) {
      return;
    }
    this.delivery.enqueue(
      event.target.conversationId,
      () => this.send(event.target, rendered),
      isCriticalOutputEvent(event) || event.type === "turn.started",
    );
  }

  notifyText(target: ConversationTarget, text: string): boolean {
    if (this.closed || !this.matches(target)) {
      return false;
    }
    return this.delivery.enqueue(
      target.conversationId,
      () => this.send(target, text),
      true,
    );
  }

  deliverText(target: ConversationTarget, text: string): Promise<void> {
    if (this.closed || !this.matches(target)) {
      return Promise.reject(new Error("微信输出目标无效或队列已关闭"));
    }
    return this.delivery.runOrdered(
      target.conversationId,
      () => this.send(target, text),
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.delivery.close();
      return;
    }
    this.closed = true;
    await this.delivery.close();
    this.contexts.clear();
  }

  private render(event: OutputEvent): string | null {
    switch (event.type) {
      case "turn.started":
        return "已开始处理。";
      case "text.completed":
        if (event.phase === "commentary") {
          return null;
        }
        return event.text.trim().length === 0
          ? "Codex 返回了空消息。"
          : formatWeixinFinalText(event.text);
      case "turn.completed": {
        return formatWeixinCommandText(renderWeixinTurnCompleted(event));
      }
      case "connection.lost":
        return `Codex 连接已中断：${visibleMessage(event.message)}`;
      case "warning":
        return `Codex 警告：${visibleMessage(event.message)}`;
      default:
        return null;
    }
  }

  private async send(
    target: ConversationTarget,
    text: string,
  ): Promise<void> {
    const context = this.contexts.get(target);
    if (context === undefined) {
      throw new WeixinOutboxError("missing-reply-context");
    }
    for (const chunk of splitWeixinText(text)) {
      if (!this.access.isAllowed({
        target,
        actorId: context.actorId,
      })) {
        this.contexts.remove(target);
        await this.options.onReplyContextInvalidated?.(target);
        throw new WeixinOutboxError("unauthorized-recipient");
      }
      await this.client.sendText({
        actorId: context.actorId,
        contextToken: context.contextToken,
        text: chunk,
      });
    }
  }

  private matches(target: ConversationTarget): boolean {
    return target.surface === "weixin"
      && target.accountId === this.accountId;
  }

}

function splitWeixinText(value: string): string[] {
  const maximumCharacters = maximumChunkCharacters * maximumChunks;
  let text = value;
  if (text.length > maximumCharacters) {
    text = safePrefix(
      text,
      maximumCharacters - truncationNotice.length,
    ) + truncationNotice;
  }
  const chunks: string[] = [];
  while (text.length > 0) {
    const end = safePrefixLength(text, maximumChunkCharacters);
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  return chunks.length === 0 ? ["Codex 返回了空消息。"] : chunks;
}

function safePrefix(value: string, maximumLength: number): string {
  return value.slice(0, safePrefixLength(value, maximumLength));
}

function safePrefixLength(value: string, maximumLength: number): number {
  let length = Math.min(value.length, maximumLength);
  if (
    length > 0
    && length < value.length
    && isHighSurrogate(value.charCodeAt(length - 1))
  ) {
    length -= 1;
  }
  return length;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function visibleMessage(value: string): string {
  return value.replaceAll("[REDACTED]", "[已隐藏]");
}

function weixinOutputErrorMetadata(
  error: unknown,
): Record<string, unknown> {
  if (error instanceof WeixinOutboxError) {
    return { errorType: error.name, errorCode: error.code };
  }
  if (error instanceof WeixinProtocolError) {
    return {
      errorType: error.name,
      errorCode: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.returnCode === undefined
        ? {}
        : { returnCode: error.returnCode }),
    };
  }
  return {
    errorType: error instanceof Error ? error.name : typeof error,
  };
}
