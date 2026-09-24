import { randomUUID } from "node:crypto";
import type { InteractionRouter, InteractionRequest } from "../approval/index.js";
import type { AsyncUserQuestion, ConversationInputEvent, ConversationTarget } from "../conversation-core/index.js";

interface QuestionEvent {
  target: ConversationTarget;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: AsyncUserQuestion[];
}

interface PendingQuestion {
  event: QuestionEvent;
  requestId?: string;
  cancelled: boolean;
  cancel(): void;
  timer: NodeJS.Timeout;
}

interface AsyncQuestionOptions {
  interactions: Pick<InteractionRouter, "request" | "resolvedMany">;
  timeoutMs: number;
  targetForThread(threadId: string): ConversationTarget | undefined;
  currentThread(target: ConversationTarget): string | undefined;
  submit(target: ConversationTarget, threadId: string, text: string, isCurrent: () => boolean): Promise<unknown>;
  warn(event: QuestionEvent, message: string): void;
}

/** Owns live optional questions; answers are ordinary Turn input, never RPC responses. */
export class AsyncQuestionCoordinator {
  private readonly pending = new Set<PendingQuestion>();
  private readonly seen = new Set<string>();
  private readonly active = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: AsyncQuestionOptions) {}

  handleInput(event: ConversationInputEvent): void {
    if ((event.type === "turn.completed" && event.status !== "completed")
      || event.type === "thread.reverted" || event.type === "thread.closed"
      || event.type === "thread.archived" || event.type === "thread.deleted") {
      this.cancelThread(event.threadId);
      return;
    }
    if (event.type !== "item.agentMessage.completed" || event.delivery !== "async" || !event.questions) return;
    const target = this.options.targetForThread(event.threadId);
    if (target) this.handle({ ...event, target, questions: event.questions });
  }

  private handle(event: QuestionEvent): void {
    if (this.stopped) return;
    const key = JSON.stringify([event.threadId, event.turnId, event.itemId]);
    if (this.active.has(key) || this.seen.has(key)) return;
    this.remember(key);
    if (this.options.currentThread(event.target) !== event.threadId) {
      this.options.warn(event, "异步问题未打开：问题所属会话不是当前前台会话。");
      return;
    }
    if (this.pending.size >= 100) {
      this.options.warn(event, "待回答的异步问题过多，本次问题未打开。");
      return;
    }
    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => { cancel = () => resolve(undefined); });
    const pending: PendingQuestion = {
      event,
      cancelled: false,
      cancel,
      timer: setTimeout(() => this.cancel(pending), this.options.timeoutMs),
    };
    pending.timer.unref();
    this.pending.add(pending);
    this.active.add(key);
    const task = this.ask(pending, cancelled).catch(() => {
      if (!pending.cancelled) {
        this.options.warn(event, "异步回答未确认送达，请核对原会话后重新发送；Gateway 不会自动重发。");
      }
    }).finally(() => {
      clearTimeout(pending.timer);
      this.pending.delete(pending);
      this.active.delete(key);
      if (!this.stopped) this.remember(key);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
  }

  cancelStale(): void {
    this.cancelMatching((pending) => this.options.currentThread(pending.event.target) !== pending.event.threadId);
  }

  cancelThread(threadId: string): void {
    this.cancelMatching((pending) => pending.event.threadId === threadId);
  }

  cancelSurface(surface: string, accountId: string): void {
    this.cancelMatching(({ event: { target } }) => target.surface === surface && target.accountId === accountId);
  }

  private remember(key: string): void {
    this.seen.delete(key);
    this.seen.add(key);
    if (this.seen.size > 1_000) this.seen.delete(this.seen.values().next().value!);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.cancelMatching(() => true);
    this.seen.clear();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.tasks]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private cancel(pending: PendingQuestion): void {
    this.cancelMatching((candidate) => candidate === pending);
  }

  private cancelMatching(matches: (pending: PendingQuestion) => boolean): void {
    const requestIds = new Set<string>();
    for (const pending of this.pending) {
      if (pending.cancelled || !matches(pending)) continue;
      pending.cancelled = true;
      pending.cancel();
      if (pending.requestId) requestIds.add(pending.requestId);
    }
    this.options.interactions.resolvedMany(requestIds);
  }

  private async ask(pending: PendingQuestion, cancelled: Promise<undefined>): Promise<void> {
    const { event } = pending;
    // All three existing channel forms support three questions per interaction.
    for (let offset = 0; offset < event.questions.length; offset += 3) {
      if (pending.cancelled) return;
      const questions = event.questions.slice(offset, offset + 3);
      const request: InteractionRequest = {
        type: "user-input",
        asynchronous: true,
        requestId: `async-question:${randomUUID()}`,
        threadId: event.threadId,
        turnId: event.turnId,
        itemId: event.itemId,
        title: "异步问题（任务继续执行）",
        questions: questions.map((question, index) => ({
          id: `q${offset + index + 1}`,
          header: `问题 ${offset + index + 1}/${event.questions.length}`,
          question: question.title,
          options: question.options,
          allowOther: true,
          secret: false,
        })),
        expiresInMs: this.options.timeoutMs,
      };
      pending.requestId = request.requestId;
      const decision = await Promise.race([this.options.interactions.request(event.target, request), cancelled]);
      delete pending.requestId;
      if (pending.cancelled || decision?.type !== "user-input") return;
      const answers = request.questions.map((question) => {
        const values = decision.answers[question.id];
        return values?.length && values.every((value) => value.trim())
          ? `${question.question}\n回答：${values.join("；")}`
          : undefined;
      });
      if (answers.some((answer) => answer === undefined)) return;
      try {
        await this.options.submit(
          event.target,
          event.threadId,
          `异步问题回答：\n\n${answers.join("\n\n")}`,
          () => !pending.cancelled && !this.stopped,
        );
      } catch {
        this.options.warn(event, "异步回答未确认送达，请核对原会话后重新发送；Gateway 不会自动重发。");
        return;
      }
    }
  }
}
