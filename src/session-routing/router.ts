import {
  UserFacingError,
  conversationTargetKey,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { Workspace, WorkspaceRegistry } from "../policy/index.js";
import type {
  BindingStore,
  BindingTransfer,
  ConversationBinding,
} from "../storage/index.js";
import type { ThreadLifecyclePort, ThreadSnapshot, ThreadStartOptions } from "./thread-port.js";

export interface ThreadModelSettings {
  model: string;
  modelProvider?: string;
  effort: string | null;
  serviceTier: string | null;
  collaborationMode: "default" | "plan";
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
  private readonly contextCompactionItemIdsByThread = new Map<string, readonly string[]>();

  constructor(
    private readonly codex: ThreadLifecyclePort,
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

  modelSettingsForThread(threadId: string): ThreadModelSettings | undefined {
    return this.modelSettingsByThread.get(threadId);
  }

  contextCompactionItemIdsForThread(threadId: string): readonly string[] | undefined {
    return this.contextCompactionItemIdsByThread.get(threadId);
  }

  updateModelSettings(threadId: string, settings: ThreadModelSettings): void {
    if (this.bindings.getByThread(threadId)) {
      const current = this.modelSettingsByThread.get(threadId);
      this.modelSettingsByThread.set(threadId, {
        ...settings,
        ...(settings.modelProvider
          ? { modelProvider: settings.modelProvider }
          : current?.modelProvider
            ? { modelProvider: current.modelProvider }
            : {}),
      });
    }
  }

  updateCollaborationMode(
    threadId: string,
    collaborationMode: ThreadModelSettings["collaborationMode"],
  ): void {
    const current = this.modelSettingsByThread.get(threadId);
    if (current && this.bindings.getByThread(threadId)) {
      this.modelSettingsByThread.set(threadId, { ...current, collaborationMode });
    }
  }

  async restoreSubscriptions(
    shouldRestore: (target: ConversationTarget) => boolean = () => true,
    onRestored: (binding: ConversationBinding, thread: ThreadSnapshot) => void = () => undefined,
  ): Promise<SubscriptionRestoreFailure[]> {
    const failures: SubscriptionRestoreFailure[] = [];
    for (const binding of this.bindings.list()) {
      if (!shouldRestore(binding.target)) {
        continue;
      }
      let restoredBinding: ConversationBinding;
      let restoredThread: ThreadSnapshot;
      try {
        const workspace = this.workspaces.require(binding.workspaceId);
        const resumed = await this.codex.resumeThread(binding.threadId, workspace.cwd);
        this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort, resumed.serviceTier);
        this.contextCompactionItemIdsByThread.set(
          resumed.thread.id,
          resumed.contextCompactionItemIds,
        );
        restoredBinding = {
          target: binding.target,
          workspaceId: workspace.id,
          threadId: resumed.thread.id,
          sessionId: resumed.thread.sessionId,
        };
        restoredThread = resumed.thread;
        this.bindings.bind(restoredBinding);
      } catch (error) {
        if (!shouldRestore(binding.target)) {
          return failures;
        }
        const normalized = error instanceof Error ? error : new Error(String(error));
        const bindingRemoved = isUnavailableRestoreError(normalized);
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
        continue;
      }
      onRestored(restoredBinding, restoredThread);
    }
    return failures;
  }

  async list(target: ConversationTarget, options: ThreadListOptions = {}): Promise<ThreadSnapshot[]> {
    const workspace = this.workspace(target);
    const fast = await this.codex.listThreads(workspace.cwd, options);
    return fast.length > 0
      ? fast
      : this.codex.listThreads(workspace.cwd, { ...options, fullScan: true });
  }

  async ensure(
    target: ConversationTarget,
    startOptions: ThreadStartOptions = {},
  ): Promise<ConversationBinding> {
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
        this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort, resumed.serviceTier);
        this.contextCompactionItemIdsByThread.set(
          resumed.thread.id,
          resumed.contextCompactionItemIds,
        );
        const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
        this.bindings.bind(binding);
        return binding;
      }
    }

    const started = await this.codex.startThread(workspace.cwd, startOptions);
    this.captureModelSettings(started.thread.id, started.model, started.modelProvider, started.reasoningEffort, started.serviceTier);
    this.contextCompactionItemIdsByThread.set(
      started.thread.id,
      started.contextCompactionItemIds,
    );
    const binding = { target, workspaceId: workspace.id, threadId: started.thread.id, sessionId: started.thread.sessionId };
    this.bindings.bind(binding);
    this.forceNew.delete(targetKey);
    return binding;
  }

  async resume(target: ConversationTarget, threadId: string): Promise<ConversationBinding> {
    const owner = this.bindings.getByThread(threadId);
    if (owner && this.key(owner.target) !== this.key(target)) {
      throw new UserFacingError("thread.bound", "该 Codex Thread 已绑定到其他会话");
    }
    const workspace = this.workspace(target);
    const resumed = await this.codex.resumeThread(threadId, workspace.cwd);
    const current = this.bindings.get(target);
    if (current && current.threadId !== resumed.thread.id) {
      await this.detach(target);
    }
    this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort, resumed.serviceTier);
    this.contextCompactionItemIdsByThread.set(
      resumed.thread.id,
      resumed.contextCompactionItemIds,
    );
    const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
    this.bindings.bind(binding);
    this.forceNew.delete(this.key(target));
    return binding;
  }

  async transferBinding(
    target: ConversationTarget,
    threadId: string,
  ): Promise<BindingTransfer> {
    const owner = this.bindings.getByThread(threadId);
    if (!owner) {
      throw new UserFacingError(
        "thread.takeover.changed",
        "Codex Thread 绑定已变化，请重新选择",
      );
    }
    if (this.key(owner.target) === this.key(target)) {
      return { binding: owner, previousOwner: owner };
    }
    if (owner.target.surface === target.surface) {
      throw new UserFacingError(
        "thread.bound",
        "同一渠道中的其他 Conversation 已绑定该 Codex Thread",
      );
    }
    const workspace = this.workspace(target);
    if (owner.workspaceId !== workspace.id) {
      throw new UserFacingError(
        "thread.takeover.workspace",
        "只能接管当前 Workspace 中的 Codex Thread",
      );
    }
    const replaced = this.bindings.get(target);
    const threads = await Promise.all([
      this.codex.readThread(threadId),
      ...(replaced && replaced.threadId !== threadId
        ? [this.codex.readThread(replaced.threadId)]
        : []),
    ]);
    if (threads.some((thread) => thread.status.type !== "idle")) {
      throw new UserFacingError(
        "thread.takeover.busy",
        "原渠道或当前渠道仍有运行中的任务，暂不能接管",
      );
    }
    if (replaced && replaced.threadId !== threadId) {
      await this.codex.unsubscribeThread(replaced.threadId);
    }
    let transfer: BindingTransfer;
    try {
      transfer = this.bindings.transfer(threadId, target);
    } catch (error) {
      if (replaced && replaced.threadId !== threadId) {
        try {
          await this.codex.resumeThread(replaced.threadId, workspace.cwd);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Thread 绑定转移失败，且目标渠道原订阅恢复失败",
            { cause: restoreError },
          );
        }
      }
      throw error;
    }
    if (replaced && replaced.threadId !== threadId) {
      this.modelSettingsByThread.delete(replaced.threadId);
      this.contextCompactionItemIdsByThread.delete(replaced.threadId);
    }
    this.forceNew.add(this.key(owner.target));
    this.forceNew.delete(this.key(target));
    return transfer;
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

  async fork(
    target: ConversationTarget,
    startOptions: ThreadStartOptions = {},
  ): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    if (!current) {
      throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
    }
    const workspace = this.workspaces.require(current.workspaceId);
    const forked = await this.codex.forkThread(
      current.threadId,
      workspace.cwd,
      startOptions,
    );
    this.captureModelSettings(forked.thread.id, forked.model, forked.modelProvider, forked.reasoningEffort, forked.serviceTier);
    this.contextCompactionItemIdsByThread.set(
      forked.thread.id,
      forked.contextCompactionItemIds,
    );
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
      throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
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
      this.contextCompactionItemIdsByThread.delete(threadId);
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
      this.contextCompactionItemIdsByThread.delete(current.threadId);
      this.bindings.unbind(target);
    }
  }

  private key(target: ConversationTarget): string {
    return conversationTargetKey(target);
  }

  private captureModelSettings(
    threadId: string,
    model: string,
    modelProvider: string | undefined,
    effort: string | null,
    serviceTier: string | null | undefined,
  ): void {
    this.modelSettingsByThread.set(threadId, {
      model,
      modelProvider: modelProvider ?? "openai",
      effort,
      serviceTier: serviceTier ?? null,
      collaborationMode: "default",
    });
  }
}

function isUnavailableRestoreError(error: Error): boolean {
  return /(?:thread|session).*(?:not found|deleted|(?:is )?archived)|线程.*(?:不存在|删除|归档)/i
    .test(error.message);
}
