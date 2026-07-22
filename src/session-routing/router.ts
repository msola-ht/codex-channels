import { JsonRpcError, type CodexAppServerClient } from "../codex-client/index.js";
import type { Thread } from "../codex-protocol/index.js";
import type { ConversationTarget } from "../conversation-core/index.js";
import type { Workspace, WorkspaceRegistry } from "../policy/index.js";
import type { BindingStore, ConversationBinding } from "../storage/index.js";

export interface ThreadModelSettings {
  model: string;
  effort: string | null;
}

export interface SubscriptionRestoreFailure {
  binding: ConversationBinding;
  error: Error;
  bindingRemoved: boolean;
}

export interface ThreadListOptions {
  archived?: boolean;
  searchTerm?: string;
}

export class SessionRouter {
  private readonly forceNew = new Set<string>();
  private readonly modelSettingsByThread = new Map<string, ThreadModelSettings>();

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

  modelSettings(target: ConversationTarget): ThreadModelSettings | undefined {
    const binding = this.current(target);
    return binding ? this.modelSettingsByThread.get(binding.threadId) : undefined;
  }

  updateModelSettings(threadId: string, settings: ThreadModelSettings): void {
    if (this.bindings.getByThread(threadId)) {
      this.modelSettingsByThread.set(threadId, settings);
    }
  }

  async restoreSubscriptions(): Promise<SubscriptionRestoreFailure[]> {
    const failures: SubscriptionRestoreFailure[] = [];
    for (const binding of this.bindings.list()) {
      try {
        const workspace = this.workspaces.require(binding.workspaceId);
        const resumed = await this.codex.resumeThread(binding.threadId, workspace.cwd);
        this.captureModelSettings(resumed.thread.id, resumed.model, resumed.reasoningEffort);
        this.bindings.bind({
          target: binding.target,
          workspaceId: workspace.id,
          threadId: resumed.thread.id,
          sessionId: resumed.thread.sessionId,
        });
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        const bindingRemoved = !isTransientRestoreError(normalized);
        if (bindingRemoved) {
          this.bindings.unbind(binding.target);
          const workspace = this.workspaces.get(binding.workspaceId) ?? this.workspaces.default();
          this.bindings.selectWorkspace(binding.target, workspace.id);
        }
        failures.push({
          binding,
          error: normalized,
          bindingRemoved,
        });
      }
    }
    return failures;
  }

  async list(target: ConversationTarget, options: ThreadListOptions = {}): Promise<Thread[]> {
    const workspace = this.workspace(target);
    const fast = await this.codex.listThreads(workspace.cwd, options);
    return fast.length > 0
      ? fast
      : this.codex.listThreads(workspace.cwd, { ...options, fullScan: true });
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
        this.captureModelSettings(resumed.thread.id, resumed.model, resumed.reasoningEffort);
        const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
        this.bindings.bind(binding);
        return binding;
      }
    }

    const started = await this.codex.startThread(workspace.cwd);
    this.captureModelSettings(started.thread.id, started.model, started.reasoningEffort);
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
    this.captureModelSettings(resumed.thread.id, resumed.model, resumed.reasoningEffort);
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
    this.captureModelSettings(forked.thread.id, forked.model, forked.reasoningEffort);
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

  async archive(target: ConversationTarget): Promise<string> {
    const current = this.bindings.get(target);
    if (!current) {
      throw new Error("当前还没有 Codex Thread");
    }
    await this.codex.archiveThread(current.threadId);
    this.forgetThread(current.threadId);
    this.forceNew.add(this.key(target));
    return current.threadId;
  }

  async unarchive(target: ConversationTarget, threadId: string): Promise<ConversationBinding> {
    await this.codex.unarchiveThread(threadId);
    return this.resume(target, threadId);
  }

  forgetThread(threadId: string): ConversationTarget | undefined {
    const binding = this.bindings.getByThread(threadId);
    if (binding) {
      this.modelSettingsByThread.delete(threadId);
      this.bindings.unbind(binding.target);
      return binding.target;
    }
    return undefined;
  }

  async detach(target: ConversationTarget): Promise<void> {
    const current = this.bindings.get(target);
    if (current) {
      await this.codex.unsubscribeThread(current.threadId);
      this.modelSettingsByThread.delete(current.threadId);
      this.bindings.unbind(target);
    }
  }

  private key(target: ConversationTarget): string {
    return `${target.surface}:${target.conversationId}`;
  }

  private captureModelSettings(threadId: string, model: string, effort: string | null): void {
    this.modelSettingsByThread.set(threadId, { model, effort });
  }
}

function isTransientRestoreError(error: Error): boolean {
  if (error instanceof JsonRpcError && error.code === -32001) {
    return true;
  }
  const message = error.message.toLowerCase();
  if (/thread.*(not found|deleted|archived|closed)|线程.*(不存在|删除|归档|关闭)/i.test(message)) {
    return false;
  }
  return /(timeout|timed out|connection|socket|econn|epipe|reset|overload|超时|连接|断开|过载)/i.test(message);
}
