import type { Logger } from "pino";

import type { ConversationTarget } from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import { surfaceErrorMetadata } from "../error-metadata.js";

import {
  WeixinProtocolError,
  type WeixinTypingProtocolClient,
} from "./protocol-client.js";
import { WeixinReplyContextStore } from "./reply-context-store.js";

const defaultKeepaliveMs = 5_000;
const defaultTicketTtlMs = 24 * 60 * 60 * 1_000;
const maximumCachedTickets = 1_000;

export interface WeixinTypingControllerOptions {
  keepaliveMs?: number;
  ticketTtlMs?: number;
  nowImpl?: () => number;
  delayImpl?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface CachedTypingTicket {
  value: string;
  expiresAt: number;
}

interface TypingSession {
  target: ConversationTarget;
  controller: AbortController;
  stopped: boolean;
  started: boolean;
  actorId?: string;
  ticket?: string;
  task: Promise<void>;
  stopTask?: Promise<void>;
}

export class WeixinTypingController {
  private readonly sessions = new Map<string, TypingSession>();
  private readonly tickets = new Map<string, CachedTypingTicket>();
  private readonly keepaliveMs: number;
  private readonly ticketTtlMs: number;
  private readonly nowImpl: () => number;
  private readonly delayImpl:
    (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private closed = false;

  constructor(
    private readonly client: WeixinTypingProtocolClient,
    private readonly contexts: WeixinReplyContextStore,
    private readonly access: SurfaceAccessPolicy,
    private readonly logger: Logger,
    options: WeixinTypingControllerOptions = {},
  ) {
    this.keepaliveMs = positiveNumber(
      options.keepaliveMs ?? defaultKeepaliveMs,
      "微信输入状态续期间隔无效",
    );
    this.ticketTtlMs = positiveNumber(
      options.ticketTtlMs ?? defaultTicketTtlMs,
      "微信输入状态票据缓存时间无效",
    );
    this.nowImpl = options.nowImpl ?? Date.now;
    this.delayImpl = options.delayImpl ?? abortableDelay;
  }

  start(target: ConversationTarget): void {
    if (this.closed) {
      return;
    }
    const prior = this.sessions.get(target.conversationId);
    const session: TypingSession = {
      target,
      controller: new AbortController(),
      stopped: false,
      started: false,
      task: Promise.resolve(),
    };
    this.sessions.set(target.conversationId, session);
    session.task = (prior === undefined
      ? Promise.resolve()
      : this.stopSession(prior))
      .then(() => this.run(session));
  }

  async stop(target: ConversationTarget): Promise<void> {
    const session = this.sessions.get(target.conversationId);
    if (session === undefined) {
      return;
    }
    if (this.sessions.get(target.conversationId) === session) {
      this.sessions.delete(target.conversationId);
    }
    await this.stopSession(session);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => this.stopSession(session)));
    this.tickets.clear();
  }

  private async run(session: TypingSession): Promise<void> {
    if (session.stopped || this.closed) {
      return;
    }
    const context = this.contexts.get(session.target);
    if (
      context === undefined
      || context.contextToken === undefined
      || !this.access.isAllowed({
        target: session.target,
        actorId: context.actorId,
      })
    ) {
      return;
    }
    session.actorId = context.actorId;
    try {
      session.ticket = await this.ticketFor(
        context.actorId,
        context.contextToken,
        session.controller.signal,
      );
      if (session.stopped || this.closed) {
        return;
      }
      await this.client.setTyping({
        actorId: context.actorId,
        typingTicket: session.ticket,
        status: "typing",
      }, session.controller.signal);
      session.started = true;

      while (!session.stopped && !this.closed) {
        await this.delayImpl(
          this.keepaliveMs,
          session.controller.signal,
        );
        if (session.stopped || this.closed) {
          return;
        }
        if (!this.access.isAllowed({
          target: session.target,
          actorId: context.actorId,
        })) {
          await this.cancelActive(session);
          return;
        }
        await this.client.setTyping({
          actorId: context.actorId,
          typingTicket: session.ticket,
          status: "typing",
        }, session.controller.signal);
      }
    } catch (error) {
      if (session.controller.signal.aborted) {
        return;
      }
      this.tickets.delete(context.actorId);
      this.logFailure(session.target, "微信输入状态更新失败，不影响正常回复", error);
      await this.cancelActive(session);
    }
  }

  private stopSession(session: TypingSession): Promise<void> {
    session.stopTask ??= this.stopSessionOnce(session);
    return session.stopTask;
  }

  private async stopSessionOnce(session: TypingSession): Promise<void> {
    session.stopped = true;
    session.controller.abort();
    await session.task;
    await this.cancelActive(session);
  }

  private async cancelActive(session: TypingSession): Promise<void> {
    if (
      !session.started
      || session.actorId === undefined
      || session.ticket === undefined
    ) {
      return;
    }
    session.started = false;
    try {
      await this.client.setTyping({
        actorId: session.actorId,
        typingTicket: session.ticket,
        status: "cancel",
      });
    } catch (error) {
      this.tickets.delete(session.actorId);
      this.logFailure(session.target, "微信输入状态取消失败", error);
    }
  }

  private async ticketFor(
    actorId: string,
    contextToken: string,
    signal: AbortSignal,
  ): Promise<string> {
    const now = this.nowImpl();
    const cached = this.tickets.get(actorId);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.value;
    }
    this.tickets.delete(actorId);
    const value = await this.client.getTypingTicket({
      actorId,
      contextToken,
    }, signal);
    if (this.tickets.size >= maximumCachedTickets) {
      const oldest = this.tickets.keys().next().value;
      if (oldest !== undefined) {
        this.tickets.delete(oldest);
      }
    }
    this.tickets.set(actorId, {
      value,
      expiresAt: now + this.ticketTtlMs,
    });
    return value;
  }

  private logFailure(
    target: ConversationTarget,
    message: string,
    error: unknown,
  ): void {
    this.logger.warn(
      {
        surface: "weixin",
        accountId: target.accountId,
        conversationId: target.conversationId,
        ...typingErrorMetadata(error),
      },
      message,
    );
  }
}

function positiveNumber(value: number, message: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(message);
  }
  return value;
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new WeixinProtocolError("aborted", "微信输入状态已取消"));
      return;
    }
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new WeixinProtocolError("aborted", "微信输入状态已取消"));
    };
    signal.addEventListener("abort", abort, { once: true });
    timeout.unref?.();
  });
}

function typingErrorMetadata(error: unknown): Record<string, unknown> {
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
