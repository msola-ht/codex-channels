import {
  UserFacingError,
  conversationTargetKey,
  type ConversationTarget,
  type RoutedWorkspace,
} from "../conversation-core/index.js";
import type { Workspace, WorkspaceRegistry } from "../policy/index.js";
import type {
  BindingStore,
  BindingTransfer,
  ConversationBinding,
} from "../storage/index.js";
import type {
  ThreadLifecyclePort,
  ThreadSession,
  ThreadSnapshot,
  ThreadStartOptions,
  ThreadDynamicToolSpec,
} from "./thread-port.js";

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
  reason: "active-writer" | "unavailable" | "other";
}

export interface ThreadListOptions {
  fullScan?: boolean;
  archived?: boolean;
  searchTerm?: string;
  sectionId?: string;
  sortKey?: "created_at" | "updated_at" | "recency_at" | "section_position";
  sortDirection?: "asc" | "desc";
}

const maximumBackgroundThreadsPerConversation = 3;

export class SessionRouter {
  private readonly forceNew = new Set<string>();
  private readonly backgroundStartQueues = new Map<string, Promise<void>>();
  // 模型设置保留到进程结束：thread/list 不返回 model，
  // 会话列表需要借助本缓存标注已知模型的会话。
  private readonly modelSettingsByThread = new Map<string, ThreadModelSettings>();
  private readonly namesByThread = new Map<string, string | null>();
  private readonly contextCompactionItemIdsByThread = new Map<string, readonly string[]>();

  constructor(
    private readonly codex: ThreadLifecyclePort,
    private readonly bindings: BindingStore,
    private readonly workspaces: WorkspaceRegistry,
    private readonly dynamicTools: readonly ThreadDynamicToolSpec[] = [],
  ) {}

  private workspacePermissions(workspace: Workspace): ThreadStartOptions {
    return {
      ...(workspace.sandbox === undefined
        ? {}
        : { sandbox: workspace.sandbox }),
      ...(workspace.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: workspace.approvalPolicy }),
      ...(workspace.permissions === undefined
        ? {}
        : { permissions: workspace.permissions }),
    };
  }

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

  backgroundBindings(target: ConversationTarget): ConversationBinding[] {
    return this.bindings.backgrounds(target);
  }

  isBackgroundThread(threadId: string): boolean {
    return this.bindings.isBackground(threadId);
  }

  targetForThread(threadId: string): ConversationTarget | undefined {
    return this.bindings.getByThread(threadId)?.target;
  }

  workspaceForThread(threadId: string): RoutedWorkspace | undefined {
    const binding = this.bindings.getByThread(threadId);
    if (!binding) {
      return undefined;
    }
    const workspace = this.workspaces.get(binding.workspaceId);
    return workspace ? { id: workspace.id, name: workspace.name } : undefined;
  }

  readThread(threadId: string): Promise<ThreadSnapshot> {
    return this.codex.readThread(threadId);
  }

  foregroundThreadId(target: ConversationTarget): string | undefined {
    return this.bindings.get(target)?.threadId;
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

  threadNameForThread(threadId: string): string | null | undefined {
    return this.namesByThread.get(threadId);
  }

  updateThreadName(threadId: string, name: string | null): void {
    if (this.bindings.getByThread(threadId)) this.namesByThread.set(threadId, name);
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
    shouldRestore: (
      target: ConversationTarget,
      binding: ConversationBinding,
    ) => boolean = () => true,
    onRestored: (binding: ConversationBinding, thread: ThreadSnapshot) => void = () => undefined,
    optionsForBinding: (binding: ConversationBinding) => ThreadStartOptions = () => ({}),
    retainBackground: (
      binding: ConversationBinding,
      thread: ThreadSnapshot,
    ) => boolean = () => false,
  ): Promise<SubscriptionRestoreFailure[]> {
    const failures: SubscriptionRestoreFailure[] = [];
    for (const binding of this.bindings.list()) {
      if (!shouldRestore(binding.target, binding)) {
        continue;
      }
      let restoredBinding: ConversationBinding;
      let restoredThread: ThreadSnapshot;
      const wasBackground = this.bindings.isBackground(binding.threadId);
      try {
        const workspace = this.workspaces.require(binding.workspaceId);
        const resumed = await this.codex.resumeThread(
          binding.threadId,
          workspace.cwd,
          {
            ...this.workspacePermissions(workspace),
            ...optionsForBinding(binding),
          },
        );
        this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort, resumed.serviceTier);
        this.namesByThread.set(resumed.thread.id, resumed.thread.name);
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
        if (wasBackground) {
          this.bindings.bindBackground(restoredBinding);
        } else {
          this.bindings.bind(restoredBinding);
        }
      } catch (error) {
        if (!shouldRestore(binding.target, binding)) {
          return failures;
        }
        const normalized = error instanceof Error ? error : new Error(String(error));
        const bindingRemoved = isUnavailableRestoreError(normalized);
        if (bindingRemoved) {
          this.bindings.removeThread(binding.threadId);
          const workspace = this.workspaces.get(binding.workspaceId) ?? this.workspaces.default();
          if (!this.bindings.get(binding.target)) {
            this.bindings.selectWorkspace(binding.target, workspace.id);
          }
        }
        failures.push({
          binding,
          error: normalized,
          bindingRemoved,
          reason: bindingRemoved
            ? "unavailable"
            : isActiveWriterRestoreError(normalized)
              ? "active-writer"
              : "other",
        });
        continue;
      }
      onRestored(restoredBinding, restoredThread);
      if (
        wasBackground
        && restoredThread.status.type !== "active"
        && !retainBackground(restoredBinding, restoredThread)
      ) {
        try {
          await this.codex.unsubscribeThread(restoredBinding.threadId);
          this.bindings.removeThread(restoredBinding.threadId);
        } catch (error) {
          failures.push({
            binding: restoredBinding,
            error: error instanceof Error ? error : new Error(String(error)),
            bindingRemoved: false,
            reason: "other",
          });
        }
      }
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
          thread.status.type !== "active"
          && !this.bindings.getByThread(thread.id)
          && (
            startOptions.modelProvider === undefined
            || thread.modelProvider === startOptions.modelProvider
          ),
      );
      if (candidate) {
        const resumed = await this.codex.resumeThread(
          candidate.id,
          workspace.cwd,
          this.workspacePermissions(workspace),
        );
        this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort, resumed.serviceTier);
        this.namesByThread.set(resumed.thread.id, resumed.thread.name);
        this.contextCompactionItemIdsByThread.set(
          resumed.thread.id,
          resumed.contextCompactionItemIds,
        );
        const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
        this.bindings.bind(binding);
        return binding;
      }
    }

    const started = await this.codex.startThread(workspace.cwd, {
      ...this.workspacePermissions(workspace),
      ...startOptions,
      ...(this.dynamicTools.length > 0
        ? { dynamicTools: this.dynamicTools }
        : {}),
    });
    this.captureModelSettings(started.thread.id, started.model, started.modelProvider, started.reasoningEffort, started.serviceTier);
    this.namesByThread.set(started.thread.id, started.thread.name);
    this.contextCompactionItemIdsByThread.set(
      started.thread.id,
      started.contextCompactionItemIds,
    );
    const binding = { target, workspaceId: workspace.id, threadId: started.thread.id, sessionId: started.thread.sessionId };
    this.bindings.bind(binding);
    this.forceNew.delete(targetKey);
    return binding;
  }

  /**
   * Start a fresh App Server Thread as a background binding.
   *
   * This is intentionally separate from ensure(): scheduled execution must
   * never inspect or resume an idle historical Thread.  The optional
   * workspaceId is used by unattended runs so a removed or changed Workspace
   * cannot silently fall back to the Conversation default.
   */
  async startBackground(
    target: ConversationTarget,
    startOptions: ThreadStartOptions = {},
    workspaceId?: string,
  ): Promise<{ binding: ConversationBinding; session: ThreadSession }> {
    const key = this.key(target);
    const previous = this.backgroundStartQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.backgroundStartQueues.set(key, queued);
    await previous;
    try {
      return await this.startBackgroundUnlocked(target, startOptions, workspaceId);
    } finally {
      release();
      if (this.backgroundStartQueues.get(key) === queued) {
        this.backgroundStartQueues.delete(key);
      }
    }
  }

  private async startBackgroundUnlocked(
    target: ConversationTarget,
    startOptions: ThreadStartOptions,
    workspaceId?: string,
  ): Promise<{ binding: ConversationBinding; session: ThreadSession }> {
    if (startOptions.sandbox === "danger-full-access") {
      throw new UserFacingError(
        "workspace.permission.conflict",
        "后台计划任务不允许 danger-full-access",
      );
    }
    if (
      startOptions.approvalPolicy !== undefined
      && startOptions.approvalPolicy !== "never"
    ) {
      throw new UserFacingError(
        "workspace.permission.conflict",
        "后台计划任务必须使用 approvalPolicy=never",
      );
    }
    const backgroundStartOptions: ThreadStartOptions = { ...startOptions };
    delete backgroundStartOptions.dynamicTools;
    if (this.backgroundBindings(target).length >= maximumBackgroundThreadsPerConversation) {
      throw new UserFacingError(
        "conversation.background-limit",
        `后台任务已满，最多同时运行 ${maximumBackgroundThreadsPerConversation} 个`,
      );
    }
    const workspace = workspaceId === undefined
      ? this.workspace(target)
      : this.workspaces.require(workspaceId);
    const session = await this.codex.startThread(workspace.cwd, {
      ...this.workspacePermissions(workspace),
      ...backgroundStartOptions,
      threadSource: "automation",
    });
    if (this.bindings.getByThread(session.thread.id)) {
      throw new UserFacingError(
        "thread.bound",
        "App Server 返回的计划任务 Thread 已绑定，已拒绝覆盖现有会话",
      );
    }
    const binding = {
      target,
      workspaceId: workspace.id,
      threadId: session.thread.id,
      sessionId: session.thread.sessionId,
    };
    try {
      this.bindings.bindBackground(binding);
    } catch (error) {
      await this.codex.unsubscribeThread(session.thread.id).catch(() => undefined);
      throw error;
    }
    this.captureModelSettings(
      session.thread.id,
      session.model,
      session.modelProvider,
      session.reasoningEffort,
      session.serviceTier,
    );
    this.namesByThread.set(session.thread.id, session.thread.name);
    this.contextCompactionItemIdsByThread.set(
      session.thread.id,
      session.contextCompactionItemIds,
    );
    return { binding, session };
  }

  async resume(
    target: ConversationTarget,
    threadId: string,
    preserveCurrent = false,
  ): Promise<ConversationBinding> {
    const owner = this.bindings.getByThread(threadId);
    if (owner && this.key(owner.target) !== this.key(target)) {
      throw new UserFacingError("thread.bound", "该 Codex Thread 已绑定到其他会话");
    }
    const workspace = this.workspace(target);
    const resumed = await this.codex.resumeThread(
      threadId,
      workspace.cwd,
      this.workspacePermissions(workspace),
    );
    const current = this.bindings.get(target);
    if (current && current.threadId !== resumed.thread.id && !preserveCurrent) {
      await this.detach(target);
    }
    this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort, resumed.serviceTier);
    this.namesByThread.set(resumed.thread.id, resumed.thread.name);
    this.contextCompactionItemIdsByThread.set(
      resumed.thread.id,
      resumed.contextCompactionItemIds,
    );
    const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
    this.bindings.switchForeground(binding, preserveCurrent);
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
          await this.codex.resumeThread(
            replaced.threadId,
            workspace.cwd,
            this.workspacePermissions(workspace),
          );
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
      this.contextCompactionItemIdsByThread.delete(replaced.threadId);
    }
    this.forceNew.add(this.key(owner.target));
    this.forceNew.delete(this.key(target));
    return transfer;
  }

  async newSession(target: ConversationTarget, preserveCurrent = false): Promise<void> {
    if (preserveCurrent) {
      this.bindings.demote(target);
    } else {
      await this.detach(target);
    }
    this.forceNew.add(this.key(target));
  }

  async releaseBackground(threadId: string): Promise<ConversationTarget | undefined> {
    if (!this.bindings.isBackground(threadId)) return undefined;
    const binding = this.bindings.getByThread(threadId);
    if (!binding) return undefined;
    await this.codex.unsubscribeThread(threadId);
    this.bindings.removeThread(threadId);
    this.contextCompactionItemIdsByThread.delete(threadId);
    return binding.target;
  }

  async selectWorkspace(target: ConversationTarget, workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces.require(workspaceId);
    if (this.workspace(target).id === workspace.id) {
      return workspace;
    }
    await this.detach(target);
    this.bindings.selectWorkspace(target, workspace.id);
    // Workspace changes start a fresh conversation.  Keep the marker until
    // ensure() creates the first Thread so it cannot auto-resume history from
    // the newly selected workspace.
    this.forceNew.add(this.key(target));
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
    this.namesByThread.set(forked.thread.id, forked.thread.name);
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

  async archiveThread(threadId: string): Promise<void> {
    await this.codex.archiveThread(threadId);
    this.forgetThread(threadId);
  }

  async unarchive(target: ConversationTarget, threadId: string): Promise<ConversationBinding> {
    await this.codex.unarchiveThread(threadId);
    return this.resume(target, threadId);
  }

  forgetThread(threadId: string): ConversationTarget | undefined {
    const binding = this.bindings.getByThread(threadId);
    this.contextCompactionItemIdsByThread.delete(threadId);
    this.namesByThread.delete(threadId);
    if (binding) {
      this.bindings.removeThread(threadId);
      return binding.target;
    }
    return undefined;
  }

  forgetDeletedThread(threadId: string): ConversationTarget | undefined {
    this.modelSettingsByThread.delete(threadId);
    return this.forgetThread(threadId);
  }

  async detach(target: ConversationTarget): Promise<void> {
    const current = this.bindings.get(target);
    if (current) {
      await this.codex.unsubscribeThread(current.threadId);
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
  return /(?:thread|session).*(?:not found|deleted|(?:is )?archived)|线程.*(?:不存在|删除|归档)|模型 Provider 未配置独立 App Server/i
    .test(error.message);
}

function isActiveWriterRestoreError(error: Error): boolean {
  return /already has an active writer/u.test(error.message);
}
