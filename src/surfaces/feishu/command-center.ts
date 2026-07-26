import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import type { ConversationTarget } from "../../conversation-core/index.js";
import type { SurfaceAccessPolicy } from "../../policy/index.js";
import type { FeishuCardDocument } from "./approval-card.js";
import type { FeishuCardAction } from "./card-action.js";
import type { FeishuOutbox } from "./outbox.js";

export const feishuCommandMenuEventKey = "codexc_home";

export const feishuCommandCenterActions = [
  "status",
  "sessions",
  "workspace",
  "model",
  "usage",
  "help",
] as const;

export type FeishuCommandCenterAction =
  typeof feishuCommandCenterActions[number];

export type FeishuCommandCenterActionResult =
  | "accepted"
  | "ignored"
  | "invalid";

interface PendingCommandCenter {
  target: ConversationTarget;
  actorId: string;
  messageId: string;
  expiresAt: number;
}

interface FeishuCommandCenterOptions {
  tokenTtlMs?: number;
  capacity?: number;
  eventDeduplicationTtlMs?: number;
  eventDeduplicationCapacity?: number;
  closeTimeoutMs?: number;
  now?: () => number;
}

export class FeishuCommandCenter {
  private readonly pending = new Map<string, PendingCommandCenter>();
  private readonly seenMenuEvents = new Map<string, number>();
  private readonly tokenTtlMs: number;
  private readonly capacity: number;
  private readonly eventDeduplicationTtlMs: number;
  private readonly eventDeduplicationCapacity: number;
  private readonly closeTimeoutMs: number;
  private readonly now: () => number;
  private readonly tasks = new Set<Promise<unknown>>();
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly outbox: Pick<FeishuOutbox, "deliverCard">,
    private readonly access: SurfaceAccessPolicy,
    private readonly execute: (
      target: ConversationTarget,
      action: FeishuCommandCenterAction,
    ) => Promise<void>,
    private readonly logger: Logger,
    options: FeishuCommandCenterOptions = {},
  ) {
    this.tokenTtlMs = options.tokenTtlMs ?? 10 * 60_000;
    this.capacity = options.capacity ?? 100;
    this.eventDeduplicationTtlMs =
      options.eventDeduplicationTtlMs ?? 10 * 60_000;
    this.eventDeduplicationCapacity =
      options.eventDeduplicationCapacity ?? 1_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  async open(
    target: ConversationTarget,
    actorId: string,
  ): Promise<void> {
    if (
      this.closed
      || !this.access.isAllowed({ target, actorId })
    ) {
      return;
    }
    this.prune();
    const token = randomBytes(18).toString("base64url");
    const messageId = await this.outbox.deliverCard(
      target.conversationId,
      renderFeishuCommandCenterCard(token),
    );
    if (this.closed) {
      return;
    }
    this.pending.set(token, {
      target,
      actorId,
      messageId,
      expiresAt: this.now() + this.tokenTtlMs,
    });
    this.trimOldest(this.pending, this.capacity);
  }

  openFromMenu(
    target: ConversationTarget,
    actorId: string,
    eventId: string,
  ): Promise<void> {
    return this.track(this.openFromMenuOnce(target, actorId, eventId));
  }

  private async openFromMenuOnce(
    target: ConversationTarget,
    actorId: string,
    eventId: string,
  ): Promise<void> {
    this.prune();
    if (this.seenMenuEvents.has(eventId)) {
      return;
    }
    this.seenMenuEvents.set(
      eventId,
      this.now() + this.eventDeduplicationTtlMs,
    );
    this.trimOldest(
      this.seenMenuEvents,
      this.eventDeduplicationCapacity,
    );
    try {
      await this.open(target, actorId);
    } catch (error) {
      this.seenMenuEvents.delete(eventId);
      throw error;
    }
  }

  handleCardAction(
    action: FeishuCardAction,
  ): FeishuCommandCenterActionResult {
    const token = action.value.codexc_command_token;
    const command = action.value.codexc_command;
    if (token === undefined && command === undefined) {
      return "ignored";
    }
    if (
      this.closed
      || action.tag !== "button"
      || token === undefined
      || command === undefined
      || !isCommandCenterAction(command)
    ) {
      return "invalid";
    }
    this.prune();
    const pending = this.pending.get(token);
    if (
      !pending
      || pending.messageId !== action.messageId
      || pending.target.conversationId !== action.chatId
      || pending.actorId !== action.actorOpenId
      || !this.access.isAllowed({
        target: pending.target,
        actorId: action.actorOpenId,
      })
    ) {
      return "invalid";
    }
    void this.track(
      this.execute(pending.target, command).catch((error: unknown) => {
        this.logger.warn(
          {
            surface: pending.target.surface,
            accountId: pending.target.accountId,
            conversationId: pending.target.conversationId,
            action: command,
            errorType: error instanceof Error ? error.name : typeof error,
          },
          "飞书命令中心动作执行失败",
        );
      }),
    );
    return "accepted";
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.pending.clear();
    this.seenMenuEvents.clear();
    if (this.tasks.size === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const completed = Promise.allSettled([...this.tasks]);
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.closeTimeoutMs);
    });
    await Promise.race([completed, timedOut]);
    if (timer) {
      clearTimeout(timer);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [token, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        this.pending.delete(token);
      }
    }
    for (const [eventId, expiresAt] of this.seenMenuEvents) {
      if (expiresAt <= now) {
        this.seenMenuEvents.delete(eventId);
      }
    }
  }

  private trimOldest<K, V>(map: Map<K, V>, capacity: number): void {
    while (map.size > capacity) {
      const first = map.keys().next();
      if (first.done) {
        return;
      }
      map.delete(first.value);
    }
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
}

export function renderFeishuCommandCenterCard(
  token: string,
): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "Codex 命令中心",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: "选择常用只读操作；普通文本仍会发送到当前 Codex Thread。",
        },
      },
      actionRow(token, [
        ["当前状态", "status", "primary"],
        ["会话列表", "sessions", "default"],
        ["Workspace", "workspace", "default"],
      ]),
      actionRow(token, [
        ["模型设置", "model", "default"],
        ["账户用量", "usage", "default"],
        ["全部命令", "help", "default"],
      ]),
    ],
  };
}

function actionRow(
  token: string,
  actions: ReadonlyArray<readonly [
    label: string,
    action: FeishuCommandCenterAction,
    type: "primary" | "default",
  ]>,
): Record<string, unknown> {
  return {
    tag: "action",
    actions: actions.map(([label, action, type]) => ({
      tag: "button",
      text: {
        tag: "plain_text",
        content: label,
      },
      type,
      value: {
        codexc_command_token: token,
        codexc_command: action,
      },
    })),
  };
}

function isCommandCenterAction(
  value: string,
): value is FeishuCommandCenterAction {
  return (feishuCommandCenterActions as readonly string[]).includes(value);
}
