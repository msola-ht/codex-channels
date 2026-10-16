import type { OutputEvent } from "../conversation-core/index.js";

type RetryEvent = Extract<OutputEvent, { type: "turn.retry" }>;

interface RetryMessage<MessageId> {
  event: RetryEvent;
  active: boolean;
  messageId?: MessageId;
  lastText?: string;
  notifiedRetry: boolean;
  notifiedResume: boolean;
  creationAttempted: boolean;
}

const retryText: Record<RetryEvent["status"], string> = {
  retrying: "模型请求暂时中断，Codex 正在自动重试，请稍候。",
  resumed: "已收到模型输出，正在继续处理。",
  completed: "模型请求重试已结束，本轮处理完成。",
  failed: "模型请求重试已结束，本轮处理失败，详情见失败汇报。",
  interrupted: "模型请求重试已结束，本轮处理已停止。",
  unavailable: "模型重试状态已失效，请以当前会话状态为准。",
};

export function isTerminalRetry(event: RetryEvent): boolean {
  return event.status !== "retrying" && event.status !== "resumed";
}

export function formatTurnRetryStatus(event: RetryEvent): string {
  return `${retryText[event.status]}\nThread：${event.threadId.slice(0, 12)}`;
}

/** Transient platform message handles only; never a parallel Turn state or replay store. */
export class TurnRetryMessages<MessageId> {
  private readonly messages = new Map<string, RetryMessage<MessageId>>();

  observe(event: OutputEvent, editable = true): void {
    for (const [key, state] of this.messages) {
      if (!sameTarget(event, state.event) || !("threadId" in event) || event.threadId !== state.event.threadId) continue;
      if (event.type === "turn.retry" && event.turnId === state.event.turnId) {
        state.event = event;
        continue;
      }
      const completed = event.type === "turn.completed" && event.turnId === state.event.turnId;
      const superseded = event.type === "turn.started" && event.turnId !== state.event.turnId;
      const disconnected = event.type === "connection.lost" || event.type === "conversation.idle.released";
      if (!completed && !superseded && !disconnected) continue;
      // Keep editable handles until the independently authorized closure settles. WeChat keeps
      // its per-Turn notice budget across disconnection, but needs no terminal platform update.
      if (editable && isTerminalRetry(state.event)) continue;
      if (!editable && disconnected) continue;
      this.messages.delete(key);
      state.active = false;
    }
    if (event.type === "turn.retry" && event.status === "retrying") this.ensureState(event);
  }

  prepare(event: RetryEvent, boundedNotices = false): ((
    send: (text: string, previous?: MessageId) => Promise<MessageId>,
  ) => Promise<void>) | undefined {
    const key = retryKey(event);
    const state = this.messages.get(key);
    // Observation owns the latest revision; queued snapshots must not replace newer status.
    if (!state || state.event !== event) return undefined;
    const current = state;
    return async (send) => {
      try {
        if (!current.active || current.event !== event) return;
        if (boundedNotices) {
          if (isTerminalRetry(event)) return;
          if (event.status === "retrying" ? current.notifiedRetry : (!current.lastText || current.notifiedResume)) return;
          // Reserve each notice before a platform call: an unknown send must not cause duplicates.
          if (event.status === "retrying") current.notifiedRetry = true;
          if (event.status === "resumed") current.notifiedResume = true;
        } else if (current.messageId === undefined && (event.status !== "retrying" || current.creationAttempted)) return;
        const text = formatTurnRetryStatus(event);
        if (current.lastText === text) return;
        current.creationAttempted = true;
        current.messageId = await send(text, current.messageId);
        current.lastText = text;
        if (event.status === "retrying") current.notifiedRetry = true;
        if (event.status === "resumed") current.notifiedResume = true;
      } finally {
        if (isTerminalRetry(event) && !(boundedNotices && event.status === "unavailable")
          && current.event === event && this.messages.get(key) === current) this.messages.delete(key);
      }
    };
  }

  private ensureState(event: RetryEvent): void {
    const key = retryKey(event);
    const state = this.messages.get(key);
    if (!state) {
      if (this.messages.size >= 1_000) {
        const oldest = this.messages.entries().next().value!;
        oldest[1].active = false;
        this.messages.delete(oldest[0]);
      }
      this.messages.set(key, { event, active: true, notifiedRetry: false, notifiedResume: false, creationAttempted: false });
    }
  }

  clear(): void {
    for (const state of this.messages.values()) state.active = false;
    this.messages.clear();
  }
}

function retryKey(event: RetryEvent): string {
  return JSON.stringify([event.target.surface, event.target.accountId, event.target.conversationId, event.threadId, event.turnId]);
}

function sameTarget(a: OutputEvent, b: OutputEvent): boolean {
  return a.target.surface === b.target.surface && a.target.accountId === b.target.accountId
    && a.target.conversationId === b.target.conversationId;
}
