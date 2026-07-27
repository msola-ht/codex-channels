import type { Logger } from "pino";

import {
  isCriticalOutputEvent,
  type ConversationTarget,
  type OutputEvent,
} from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import type { SurfaceOutputPort } from "../types.js";

import { validateWeixinAccountId } from "./credential-store.js";
import {
  WeixinProtocolError,
  type WeixinProtocolClient,
} from "./protocol-client.js";
import { WeixinReplyContextStore } from "./reply-context-store.js";

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
}

export class WeixinOutbox implements SurfaceOutputPort {
  private readonly delivery: ConversationDeliveryQueue;
  private readonly turnsWithFinalText = new Set<string>();
  private readonly accountId: string;
  private closed = false;

  constructor(
    accountId: string,
    private readonly client: Pick<WeixinProtocolClient, "sendText">,
    private readonly contexts: WeixinReplyContextStore,
    private readonly access: SurfaceAccessPolicy,
    logger: Logger,
    options: WeixinOutboxOptions = {},
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
    const rendered = this.render(event);
    if (rendered === null) {
      return;
    }
    const accepted = this.delivery.enqueue(
      event.target.conversationId,
      () => this.send(event.target, rendered),
      isCriticalOutputEvent(event),
    );
    if (accepted && event.type === "text.completed") {
      this.rememberFinalText(event.threadId, event.turnId);
    }
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
    this.turnsWithFinalText.clear();
    this.contexts.clear();
  }

  private render(event: OutputEvent): string | null {
    switch (event.type) {
      case "text.completed":
        if (event.phase === "commentary") {
          return null;
        }
        return event.text.trim().length === 0
          ? "Codex 返回了空消息。"
          : event.text;
      case "turn.completed": {
        const hadFinalText = this.forgetFinalText(
          event.threadId,
          event.turnId,
        );
        if (event.status === "completed" && hadFinalText) {
          return null;
        }
        if (event.status === "completed") {
          return "本次运行已完成。";
        }
        if (event.status === "interrupted") {
          return "本次运行已停止。";
        }
        if (event.status === "failed") {
          return event.error?.trim()
            ? `本次运行失败：${visibleMessage(event.error)}`
            : "本次运行失败。";
        }
        return "本次运行状态异常。";
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

  private rememberFinalText(threadId: string, turnId: string): void {
    while (this.turnsWithFinalText.size >= 1_000) {
      const oldest = this.turnsWithFinalText.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.turnsWithFinalText.delete(oldest);
    }
    this.turnsWithFinalText.add(turnKey(threadId, turnId));
  }

  private forgetFinalText(threadId: string, turnId: string): boolean {
    return this.turnsWithFinalText.delete(turnKey(threadId, turnId));
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

function turnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
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
