import type { CodexAppServerClient } from "../codex-client/client.js";
import type { Thread } from "../codex-protocol/index.js";
import type { ConversationTarget } from "../conversation-core/events.js";
import type { Workspace, WorkspaceRegistry } from "../policy/workspace-registry.js";
import type { BindingStore, ConversationBinding } from "../storage/binding-store.js";

export class SessionRouter {
  private readonly forceNew = new Set<string>();

  constructor(
    private readonly codex: CodexAppServerClient,
    private readonly bindings: BindingStore,
    private readonly workspaces: WorkspaceRegistry,
  ) {}

  workspace(target: ConversationTarget): Workspace {
    const workspaceId = this.bindings.getWorkspace(target) ?? this.workspaces.defaultWorkspaceId;
    const workspace = this.workspaces.get(workspaceId) ?? this.workspaces.default();
    if (workspace.id !== workspaceId) {
      this.bindings.selectWorkspace(target, workspace.id);
    }
    return workspace;
  }

  listWorkspaces(): Workspace[] {
    return this.workspaces.list();
  }

  resolveWorkspace(selector: string): Workspace {
    return this.workspaces.resolve(selector);
  }

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
        const workspace = this.workspaces.require(binding.workspaceId);
        const resumed = await this.codex.resumeThread(binding.threadId, workspace.cwd);
        this.bindings.bind({
          target: binding.target,
          workspaceId: workspace.id,
          threadId: resumed.thread.id,
          sessionId: resumed.thread.sessionId,
        });
      } catch (error) {
        this.bindings.unbind(binding.target);
        const workspace = this.workspaces.get(binding.workspaceId) ?? this.workspaces.default();
        this.bindings.selectWorkspace(binding.target, workspace.id);
        failures.push({
          binding,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return failures;
  }

  async list(target: ConversationTarget): Promise<Thread[]> {
    const workspace = this.workspace(target);
    const fast = await this.codex.listThreads(workspace.cwd);
    return fast.length > 0 ? fast : this.codex.listThreads(workspace.cwd, { fullScan: true });
  }

  async ensure(target: ConversationTarget): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    if (current) {
      return current;
    }
    const targetKey = this.key(target);
    const workspace = this.workspace(target);
    this.bindings.selectWorkspace(target, workspace.id);
    if (!this.forceNew.has(targetKey)) {
      const sessions = await this.list(target);
      const candidate = sessions.find(
        (thread) =>
          thread.status.type !== "active" && !this.bindings.getByThread(thread.id),
      );
      if (candidate) {
        const resumed = await this.codex.resumeThread(candidate.id, workspace.cwd);
        const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
        this.bindings.bind(binding);
        return binding;
      }
    }

    const started = await this.codex.startThread(workspace.cwd);
    const binding = { target, workspaceId: workspace.id, threadId: started.thread.id, sessionId: started.thread.sessionId };
    this.bindings.bind(binding);
    this.forceNew.delete(targetKey);
    return binding;
  }

  async resume(target: ConversationTarget, threadId: string): Promise<ConversationBinding> {
    const owner = this.bindings.getByThread(threadId);
    if (owner && this.key(owner.target) !== this.key(target)) {
      throw new Error("该 Codex Thread 已绑定到其他会话");
    }
    const workspace = this.workspace(target);
    await this.detach(target);
    const resumed = await this.codex.resumeThread(threadId, workspace.cwd);
    const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
    this.bindings.bind(binding);
    this.forceNew.delete(this.key(target));
    return binding;
  }

  async newSession(target: ConversationTarget): Promise<void> {
    await this.detach(target);
    this.forceNew.add(this.key(target));
  }

  async selectWorkspace(target: ConversationTarget, workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.require(workspaceId);
    if (this.workspace(target).id === workspace.id) {
      return workspace;
    }
    await this.detach(target);
    this.bindings.selectWorkspace(target, workspace.id);
    this.forceNew.delete(this.key(target));
    return workspace;
  }

  async fork(target: ConversationTarget): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    if (!current) {
      throw new Error("当前还没有 Codex Thread");
    }
    const workspace = this.workspaces.require(current.workspaceId);
    const forked = await this.codex.forkThread(current.threadId, workspace.cwd);
    await this.detach(target);
    const binding = {
      target,
      workspaceId: workspace.id,
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
    const current = this.bindings.get(target);
    if (current) {
      await this.codex.unsubscribeThread(current.threadId);
      this.bindings.unbind(target);
    }
  }

  private key(target: ConversationTarget): string {
    return `${target.surface}:${target.conversationId}`;
  }
}
