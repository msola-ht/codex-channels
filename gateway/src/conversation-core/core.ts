import type { MessagePhase, ThreadTokenUsage } from "../codex-protocol/index.js";
import type { EventBus } from "../event-bus/event-bus.js";
import {
  gatewayUserMessageClientIdPrefix,
  type ConversationTarget,
  type OutputEvent,
  isCriticalOutputEvent,
} from "./events.js";
import type { ConversationRoutingPort } from "./routing-port.js";
import { parseOperationUpdate } from "./operation.js";

export interface CodexNotification {
  method: string;
  params: unknown;
}

interface ActiveTurn {
  target: ConversationTarget;
  threadId: string;
  turnId: string;
}

type WithoutTarget<T> = T extends unknown ? Omit<T, "target"> : never;
type UntargetedOutputEvent = WithoutTarget<OutputEvent>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = record?.[name];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, name: string): number | undefined {
  const value = record?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class ConversationCore {
  private readonly activeByConversation = new Map<string, ActiveTurn>();
  private readonly errorsByTurn = new Map<string, string>();
  private readonly usageByThread = new Map<string, ThreadTokenUsage>();
  private readonly seenUserMessages = new Set<string>();
  private readonly phaseByItem = new Map<string, MessagePhase | null>();

  constructor(
    private readonly router: ConversationRoutingPort,
    private readonly output: EventBus<OutputEvent>,
  ) {}

  markTurnStarted(target: ConversationTarget, threadId: string, turnId: string): void {
    const current = this.activeByConversation.get(this.key(target));
    if (current?.threadId === threadId && current.turnId === turnId) {
      return;
    }
    this.activeByConversation.set(this.key(target), { target, threadId, turnId });
    this.publish({ type: "turn.started", target, threadId, turnId });
  }

  activeTurn(target: ConversationTarget): ActiveTurn | undefined {
    return this.activeByConversation.get(this.key(target));
  }

  tokenUsage(threadId: string): ThreadTokenUsage | undefined {
    return this.usageByThread.get(threadId);
  }

  connectionLost(message: string): void {
    this.activeByConversation.clear();
    this.errorsByTurn.clear();
    this.usageByThread.clear();
    this.seenUserMessages.clear();
    this.phaseByItem.clear();
    for (const binding of this.router.allBindings()) {
      this.publish({
        type: "connection.lost",
        target: binding.target,
        threadId: binding.threadId,
        message,
      });
    }
  }

  handle(notification: CodexNotification): void {
    const params = asRecord(notification.params);
    const threadId = stringField(params, "threadId");

    switch (notification.method) {
      case "turn/started": {
        const turn = asRecord(params?.turn);
        const turnId = stringField(turn, "id");
        const target = threadId ? this.router.targetForThread(threadId) : undefined;
        if (threadId && turnId && target) {
          this.markTurnStarted(target, threadId, turnId);
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const tokenUsage = parseThreadTokenUsage(asRecord(params?.tokenUsage));
        if (threadId && tokenUsage) {
          this.usageByThread.set(threadId, tokenUsage);
        }
        return;
      }
      case "item/agentMessage/delta": {
        const turnId = stringField(params, "turnId");
        const itemId = stringField(params, "itemId");
        const text = stringField(params, "delta");
        if (threadId && turnId && itemId && text) {
          const phase = this.phaseByItem.get(this.itemKey(threadId, turnId, itemId));
          this.publishForThread(threadId, {
            type: "text.delta",
            threadId,
            turnId,
            itemId,
            text,
            ...(phase !== undefined ? { phase } : {}),
          });
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        const turnId = stringField(params, "turnId");
        const item = asRecord(params?.item);
        const itemId = stringField(item, "id");
        if (threadId && turnId && item?.type === "agentMessage" && itemId) {
          const key = this.itemKey(threadId, turnId, itemId);
          const phase = messagePhase(item.phase);
          if (notification.method === "item/started") {
            this.phaseByItem.set(key, phase);
          } else {
            const resolvedPhase = phase ?? this.phaseByItem.get(key) ?? null;
            if (typeof item.text === "string") {
              this.publishForThread(threadId, {
                type: "text.completed",
                threadId,
                turnId,
                itemId,
                text: item.text,
                phase: resolvedPhase,
              });
            }
            this.phaseByItem.delete(key);
          }
          return;
        }
        if (threadId && turnId && item?.type === "userMessage") {
          this.publishUserMessage(threadId, turnId, item);
          return;
        }
        if (threadId && turnId && item) {
          const operation = parseOperationUpdate(
            item,
            notification.method === "item/started" ? "started" : "completed",
          );
          if (operation) {
            this.publishForThread(threadId, {
              type: "operation.updated",
              threadId,
              turnId,
              operation,
            });
          }
        }
        return;
      }
      case "error": {
        const turnId = stringField(params, "turnId");
        const error = asRecord(params?.error);
        const message = stringField(error, "message");
        if (turnId && message) {
          this.errorsByTurn.set(turnId, message);
        }
        return;
      }
      case "turn/completed": {
        const turn = asRecord(params?.turn);
        const turnId = stringField(turn, "id");
        const status = stringField(turn, "status") ?? "completed";
        if (!threadId || !turnId) {
          return;
        }
        this.clearSeenUserMessages(threadId, turnId);
        this.clearItemPhases(threadId, turnId);
        const target = this.router.targetForThread(threadId);
        if (!target) {
          return;
        }
        const active = this.activeByConversation.get(this.key(target));
        if (active?.turnId === turnId) {
          this.activeByConversation.delete(this.key(target));
        }
        const turnError = asRecord(turn?.error);
        const error = stringField(turnError, "message") ?? this.errorsByTurn.get(turnId);
        this.errorsByTurn.delete(turnId);
        this.publish({
          type: "turn.completed",
          target,
          threadId,
          turnId,
          status,
          ...(error ? { error } : {}),
        });
        return;
      }
      case "thread/status/changed": {
        const status = asRecord(params?.status);
        const statusType = stringField(status, "type");
        if (threadId && statusType) {
          this.publishForThread(threadId, {
            type: "thread.status",
            threadId,
            status: statusType,
          });
        }
        return;
      }
      case "thread/closed":
      case "thread/archived":
      case "thread/deleted": {
        if (!threadId) {
          return;
        }
        const target = this.router.targetForThread(threadId);
        this.usageByThread.delete(threadId);
        this.clearSeenUserMessages(threadId);
        this.clearItemPhases(threadId);
        if (target) {
          this.activeByConversation.delete(this.key(target));
        }
        return;
      }
      case "warning": {
        const message = stringField(params, "message");
        if (message && threadId) {
          this.publishForThread(threadId, { type: "warning", threadId, message });
        }
        return;
      }
      default:
        return;
    }
  }

  private publishForThread(
    threadId: string,
    event: UntargetedOutputEvent,
  ): void {
    const target = this.router.targetForThread(threadId);
    if (target) {
      this.publish({ ...event, target } as OutputEvent);
    }
  }

  private publishUserMessage(
    threadId: string,
    turnId: string,
    item: Record<string, unknown>,
  ): void {
    const itemId = stringField(item, "id");
    if (!itemId) {
      return;
    }
    const messageKey = `${threadId}:${turnId}:${itemId}`;
    if (this.seenUserMessages.has(messageKey)) {
      return;
    }
    this.seenUserMessages.add(messageKey);
    const clientId = stringField(item, "clientId");
    if (clientId?.startsWith(gatewayUserMessageClientIdPrefix)) {
      return;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .map((input) => {
        const record = asRecord(input);
        return record?.type === "text" && typeof record.text === "string"
          ? record.text.trim()
          : "";
      })
      .filter(Boolean)
      .join("\n\n");
    if (!text) {
      return;
    }
    const target = this.router.targetForThread(threadId);
    if (!target) {
      return;
    }
    this.markTurnStarted(target, threadId, turnId);
    this.publish({ type: "user.message", target, threadId, turnId, itemId, text });
  }

  private clearSeenUserMessages(threadId: string, turnId?: string): void {
    const prefix = turnId ? `${threadId}:${turnId}:` : `${threadId}:`;
    for (const key of this.seenUserMessages) {
      if (key.startsWith(prefix)) {
        this.seenUserMessages.delete(key);
      }
    }
  }

  private clearItemPhases(threadId: string, turnId?: string): void {
    const prefix = turnId ? `${threadId}:${turnId}:` : `${threadId}:`;
    for (const key of this.phaseByItem.keys()) {
      if (key.startsWith(prefix)) {
        this.phaseByItem.delete(key);
      }
    }
  }

  private itemKey(threadId: string, turnId: string, itemId: string): string {
    return `${threadId}:${turnId}:${itemId}`;
  }

  private publish(event: OutputEvent): void {
    this.output.publish(event, isCriticalOutputEvent(event));
  }

  private key(target: ConversationTarget): string {
    return `${target.surface}:${target.conversationId}`;
  }
}

function messagePhase(value: unknown): MessagePhase | null {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function parseThreadTokenUsage(record: Record<string, unknown> | undefined): ThreadTokenUsage | undefined {
  const total = parseTokenUsageBreakdown(asRecord(record?.total));
  const last = parseTokenUsageBreakdown(asRecord(record?.last));
  const context = record?.modelContextWindow;
  if (!total || !last || (context !== null && (typeof context !== "number" || !Number.isFinite(context)))) {
    return undefined;
  }
  return { total, last, modelContextWindow: context };
}

function parseTokenUsageBreakdown(record: Record<string, unknown> | undefined): ThreadTokenUsage["total"] | undefined {
  const totalTokens = numberField(record, "totalTokens");
  const inputTokens = numberField(record, "inputTokens");
  const cachedInputTokens = numberField(record, "cachedInputTokens");
  const cacheWriteInputTokens = numberField(record, "cacheWriteInputTokens");
  const outputTokens = numberField(record, "outputTokens");
  const reasoningOutputTokens = numberField(record, "reasoningOutputTokens");
  if (
    totalTokens === undefined || inputTokens === undefined || cachedInputTokens === undefined ||
    cacheWriteInputTokens === undefined || outputTokens === undefined || reasoningOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}
