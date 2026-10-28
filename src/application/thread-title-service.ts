import type { ConversationTarget } from "../conversation-core/index.js";
import { threadTitleInputDigest, type CompletedThreadTitleInput, type GenerateThreadTitleRequest,
  type SetGeneratedThreadNameRequest, type SetGeneratedThreadNameResult, type ThreadTitlePort,
  type TitleInputContext } from "./thread-title-port.js";
import type { TurnInput } from "./turn-port.js";

export interface ThreadTitleAuthorization {
  bindingKey: object;
  provider: string;
  cwd: string;
  assertCurrent(): void;
  context(): Pick<GenerateThreadTitleRequest, "model" | "modelProvider" | "permissionProfile"> | undefined;
}

interface Registration {
  threadId: string;
  digest: string;
  candidate: string;
  authorization: ThreadTitleAuthorization;
  expires: number;
  target: ConversationTarget;
}

interface TitleTask {
  registration: Registration;
  abort: AbortController;
  promise: Promise<void>;
  writing?: string;
  context: Pick<GenerateThreadTitleRequest, "model" | "modelProvider" | "permissionProfile">;
}

interface ThreadTitleOptions {
  port: ThreadTitlePort;
  authorize(target: ConversationTarget, threadId: string, actorId: string): ThreadTitleAuthorization | undefined;
  write(target: ConversationTarget, request: SetGeneratedThreadNameRequest): Promise<SetGeneratedThreadNameResult>;
  report(event: { threadId: string; provider: string; outcome: string; reason?: string }): void;
}

/** Optional, bounded title work; never owns or replays a user submission. */
export class ThreadTitleService {
  private readonly registrations = new Map<string, Registration>();
  private readonly tasks = new Map<string, TitleTask>();
  private readonly attempts = new WeakMap<object, number>();
  private readonly seen = new Set<string>();
  private stopped = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: ThreadTitleOptions) {
    this.timer = setInterval(() => this.prune(), 1_000);
    this.timer.unref();
  }

  /** Called only after the real submission guards, immediately before the write. */
  attempted(target: ConversationTarget, threadId: string, clientId: string,
    input: readonly TurnInput[], context: TitleInputContext | undefined): void {
    if (this.stopped || !context?.actorId || !context.text.trim()) return;
    try {
      this.prune();
      if (this.registrations.size >= 512 || [...this.registrations.values()]
        .filter(entry => entry.threadId === threadId).length >= 16) return;
      const authorization = this.options.authorize(target, threadId, context.actorId);
      if (!authorization || (this.attempts.get(authorization.bindingKey) ?? 0) >= 2) return;
      authorization.assertCurrent();
      // Bound retained text by UTF-8 bytes without splitting Unicode code points.
      let candidate = "";
      let bytes = 0;
      for (const point of context.text.trim()) {
        bytes += Buffer.byteLength(point);
        if (bytes > 960) break;
        candidate += point;
      }
      this.registrations.set(JSON.stringify([threadId, clientId]), {
        threadId, digest: threadTitleInputDigest(input), candidate, authorization,
        expires: Date.now() + 3_600_000, target,
      });
    } catch {
      // Optional registration must never change the original submission outcome.
      try { this.options.report({ threadId, provider: "unknown", outcome: "skipped", reason: "registration-unavailable" }); } catch { /* Optional diagnostics cannot reject user input. */ }
    }
  }

  completed(event: CompletedThreadTitleInput): void {
    if (this.stopped) return;
    const key = JSON.stringify([event.threadId, event.clientUserMessageId]);
    const registration = this.registrations.get(key);
    if (!registration) return;
    this.registrations.delete(key);
    const item = JSON.stringify([event.threadId, event.turnId, event.itemId]);
    if (this.seen.has(item) || registration.digest !== event.digest || !this.current(registration)) return;
    this.seen.add(item);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
    if (this.tasks.has(event.threadId) || this.tasks.size >= 2 || [...this.tasks.values()]
      .some(task => task.registration.authorization.provider === registration.authorization.provider)) return;
    const count = this.attempts.get(registration.authorization.bindingKey) ?? 0;
    if (count >= 2) return;
    let context: ReturnType<ThreadTitleAuthorization["context"]>;
    try { context = registration.authorization.context(); } catch { return; }
    if (!context) return;
    const task: TitleTask = { registration, context, abort: new AbortController(), promise: Promise.resolve() };
    this.tasks.set(event.threadId, task);
    this.attempts.set(registration.authorization.bindingKey, count + 1);
    task.promise = this.run(task, context).catch(() => {
      this.report(task, task.abort.signal.aborted ? "cancelled" : "failed", "title-operation-failed");
    }).finally(() => {
      if (this.tasks.get(event.threadId) === task) this.tasks.delete(event.threadId);
    });
  }

  nameChanged(threadId: string, name: string | null): void {
    const task = this.tasks.get(threadId);
    if (task?.writing !== undefined && task.writing === name) return;
    this.cancelThread(threadId);
  }

  cancelThread(threadId: string): void {
    for (const [key, entry] of this.registrations) if (entry.threadId === threadId) this.registrations.delete(key);
    this.tasks.get(threadId)?.abort.abort();
  }

  cancelProvider(provider: string): void {
    for (const [key, entry] of this.registrations) {
      if (entry.authorization.provider === provider) this.registrations.delete(key);
    }
    for (const task of this.tasks.values()) if (task.registration.authorization.provider === provider) task.abort.abort();
  }

  cancelAll(): void {
    this.registrations.clear();
    for (const task of this.tasks.values()) task.abort.abort();
  }

  prune(): void {
    for (const [key, entry] of this.registrations) if (!this.current(entry)) this.registrations.delete(key);
    for (const task of this.tasks.values()) {
      try {
        if (!this.current(task.registration)
          || JSON.stringify(task.registration.authorization.context()) !== JSON.stringify(task.context)) task.abort.abort();
      } catch { task.abort.abort(); }
    }
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.cancelAll();
  }

  async close(): Promise<void> {
    this.stop();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.tasks.values()].map(task => task.promise)),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); timer.unref(); })]);
    if (timer) clearTimeout(timer);
  }

  private current(entry: Registration): boolean {
    if (entry.expires <= Date.now()) return false;
    try { entry.authorization.assertCurrent(); return true; } catch { return false; }
  }

  private async run(task: TitleTask,
    context: Pick<GenerateThreadTitleRequest, "model" | "modelProvider" | "permissionProfile">): Promise<void> {
    const { registration: entry } = task;
    const beforeSubmit = () => {
      task.abort.signal.throwIfAborted();
      entry.authorization.assertCurrent();
      if (!this.current(entry)) throw new Error("标题授权已失效");
      const current = entry.authorization.context();
      if (JSON.stringify(current) !== JSON.stringify(context)) throw new Error("标题执行上下文已变化");
    };
    beforeSubmit();
    const result = await this.options.port.generateThreadTitle({
      ...context, threadId: entry.threadId, cwd: entry.authorization.cwd,
      candidate: entry.candidate, signal: task.abort.signal, deadlineMs: Date.now() + 10_000, beforeSubmit,
    });
    if (result.type !== "generated") {
      if (result.type === "skipped") this.attempts.set(entry.authorization.bindingKey,
        Math.max(0, (this.attempts.get(entry.authorization.bindingKey) ?? 1) - 1));
      this.report(task, result.type, result.reason);
      return;
    }
    beforeSubmit();
    task.writing = result.title;
    const deadlineMs = Date.now() + 10_000;
    const written = await this.options.write(entry.target, {
      threadId: entry.threadId, cwd: entry.authorization.cwd, title: result.title, deadlineMs,
      beforeSubmit: () => { beforeSubmit(); if (Date.now() >= deadlineMs) throw new Error("标题回写已超时"); },
    });
    if (written.type === "unconfirmed") this.attempts.set(entry.authorization.bindingKey, 2);
    this.report(task, written.type);
  }

  private report(task: TitleTask, outcome: string, reason?: string): void {
    try {
      this.options.report({ threadId: task.registration.threadId,
        provider: task.registration.authorization.provider, outcome, ...(reason ? { reason } : {}) });
    } catch { /* Diagnostics cannot create an unhandled background rejection. */ }
  }
}
