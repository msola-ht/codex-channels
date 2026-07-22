import type { RpcNotification } from "../codex-client/json-rpc.js";
import type { EventBus } from "../event-bus/event-bus.js";
import type { SessionRouter } from "../session-routing/router.js";
import { type ConversationTarget, type OutputEvent, isCriticalOutputEvent } from "./events.js";

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

export class ConversationCore {
  private readonly activeByConversation = new Map<string, ActiveTurn>();
  private readonly errorsByTurn = new Map<string, string>();

  constructor(
    private readonly router: SessionRouter,
    private readonly output: EventBus<OutputEvent>,
  ) {}

  markTurnStarted(target: ConversationTarget, threadId: string, turnId: string): void {
    this.activeByConversation.set(this.key(target), { target, threadId, turnId });
  }

  activeTurn(target: ConversationTarget): ActiveTurn | undefined {
    return this.activeByConversation.get(this.key(target));
  }

  connectionLost(message: string): void {
    this.activeByConversation.clear();
    this.errorsByTurn.clear();
    for (const binding of this.router.allBindings()) {
      this.publish({
        type: "warning",
        target: binding.target,
        threadId: binding.threadId,
        message,
      });
    }
  }

  handle(notification: RpcNotification): void {
    const params = asRecord(notification.params);
    const threadId = stringField(params, "threadId");

    switch (notification.method) {
      case "item/agentMessage/delta": {
        const turnId = stringField(params, "turnId");
        const itemId = stringField(params, "itemId");
        const text = stringField(params, "delta");
        if (threadId && turnId && itemId && text) {
          this.publishForThread(threadId, {
            type: "text.delta",
            threadId,
            turnId,
            itemId,
            text,
          });
        }
        return;
      }
      case "item/completed": {
        const turnId = stringField(params, "turnId");
        const item = asRecord(params?.item);
        if (
          threadId &&
          turnId &&
          item?.type === "agentMessage" &&
          typeof item.id === "string" &&
          typeof item.text === "string"
        ) {
          this.publishForThread(threadId, {
            type: "text.completed",
            threadId,
            turnId,
            itemId: item.id,
            text: item.text,
          });
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
        const target = this.router.forgetThread(threadId);
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

  private publish(event: OutputEvent): void {
    this.output.publish(event, isCriticalOutputEvent(event));
  }

  private key(target: ConversationTarget): string {
    return `${target.surface}:${target.conversationId}`;
  }
}
