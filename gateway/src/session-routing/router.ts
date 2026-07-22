import type { CodexAppServerClient } from "../codex-client/client.js";
import type { Thread } from "../codex-protocol/index.js";
import type { ConversationTarget } from "../conversation-core/events.js";
import { MemoryBindingStore, type ConversationBinding } from "./memory-bindings.js";

export class SessionRouter {
  private readonly forceNew = new Set<string>();

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly bindings: MemoryBindingStore,
  ) {}

  current(target: ConversationTarget): ConversationBinding | undefined {
    return this.bindings.get(target);
  }

  targetForThread(threadId: string): ConversationTarget | undefined {
    return this.bindings.getByThread(threadId)?.target;
  }

  allBindings(): ConversationBinding[] {
    return this.bindings.list();
  }

  async restoreSubscriptions(): Promise<Array<{ binding: ConversationBinding; error: Error }>> {
    const failures: Array<{ binding: ConversationBinding; error: Error }> = [];
    for (const binding of this.bindings.list()) {
      try {
        const resumed = await this.codex.resumeThread(binding.threadId);
        this.bindings.bind({
          target: binding.target,
          threadId: resumed.thread.id,
          sessionId: resumed.thread.sessionId,
        });
      } catch (error) {
        this.bindings.unbind(binding.target);
        failures.push({
          binding,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return failures;
  }

  async list(): Promise<Thread[]> {
    const fast = await this.codex.listThreads();
    return fast.length > 0 ? fast : this.codex.listThreads({ fullScan: true });
  }

  async ensure(target: ConversationTarget): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    if (current) {
      return current;
    }
    const targetKey = this.key(target);
    if (!this.forceNew.has(targetKey)) {
      const sessions = await this.list();
      const candidate = sessions.find(
        (thread) =>
          thread.status.type !== "active" && !this.bindings.getByThread(thread.id),
      );
      if (candidate) {
        const resumed = await this.codex.resumeThread(candidate.id);
        const binding = { target, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
        this.bindings.bind(binding);
        return binding;
      }
    }

    const started = await this.codex.startThread();
    const binding = { target, threadId: started.thread.id, sessionId: started.thread.sessionId };
    this.bindings.bind(binding);
    this.forceNew.delete(targetKey);
    return binding;
  }

  async resume(target: ConversationTarget, threadId: string): Promise<ConversationBinding> {
    const owner = this.bindings.getByThread(threadId);
    if (owner && owner.target.conversationId !== target.conversationId) {
      throw new Error("该 Codex Thread 已绑定到其他会话");
    }
    await this.detach(target);
    const resumed = await this.codex.resumeThread(threadId);
    const binding = { target, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
    this.bindings.bind(binding);
    this.forceNew.delete(this.key(target));
    return binding;
  }

  async newSession(target: ConversationTarget): Promise<void> {
    await this.detach(target);
    this.forceNew.add(this.key(target));
  }

  async fork(target: ConversationTarget): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    if (!current) {
      throw new Error("当前还没有 Codex Thread");
    }
    const forked = await this.codex.forkThread(current.threadId);
    await this.detach(target);
    const binding = {
      target,
      threadId: forked.thread.id,
      sessionId: forked.thread.sessionId,
    };
    this.bindings.bind(binding);
    return binding;
  }

  forgetThread(threadId: string): ConversationTarget | undefined {
    const binding = this.bindings.getByThread(threadId);
    if (binding) {
      this.bindings.unbind(binding.target);
      return binding.target;
    }
    return undefined;
  }

  async detach(target: ConversationTarget): Promise<void> {
    const current = this.bindings.unbind(target);
    if (current) {
      await this.codex.unsubscribeThread(current.threadId);
    }
  }

  private key(target: ConversationTarget): string {
    return `${target.surface}:${target.conversationId}`;
  }
}
