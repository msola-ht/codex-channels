import {
  UserFacingError,
  conversationTargetKey,
  type ConversationTarget,
  type RoutedWorkspace,
  type ThreadApprovalsReviewer,
} from "../conversation-core/index.js";
import type { Workspace, WorkspaceRegistry } from "../policy/index.js";
import type {
  BindingStore,
  BindingTransfer,
  ConversationBinding,
  ConversationIdleState,
  ConversationModelPreference,
} from "../storage/index.js";
import type {
  ThreadLifecyclePort,
  ThreadExecutionContext,
  ThreadSession,
  ThreadResumeSession,
  ThreadSnapshot,
  ThreadStartOptions,
  ThreadDynamicToolSpec,
} from "./thread-port.js";
import { isThreadExecutionSettled } from "./thread-port.js";

export interface ThreadModelSettings {
  model: string;
  modelProvider?: string;
  effort: string | null;
  serviceTier: string | null;
  approvalsReviewer?: ThreadApprovalsReviewer | null;
  collaborationMode: "default" | "plan";
}

export interface SubscriptionRestoreFailure {
  binding: ConversationBinding;
  error: Error;
  bindingRemoved: boolean;
  reason: "active-writer" | "unavailable" | "other";
}

export interface ThreadListOptions {
  beforeSubmit?: () => void;
  fullScan?: boolean;
  archived?: boolean;
  searchTerm?: string;
  sectionId?: string;
  sortKey?: "created_at" | "updated_at" | "recency_at" | "section_position";
  sortDirection?: "asc" | "desc";
}

export interface ApprovalTarget {
  target: ConversationTarget;
  ownerThreadId: string;
  relatedThreadIds: readonly string[];
  isCurrent(): boolean;
}

interface ApprovalResolution {
  bindings: ReadonlyMap<string, ConversationBinding>;
  workspaceCwds: ReadonlyMap<string, string>;
  changedThreads: Set<string>;
  overflowed: boolean;
}

/** Open immediately before an authoritative restore request; consume its
 * snapshot only once the binding exists, and always stop the request window. */
export type ThreadRestoreObserver = (threadId: string) => {
  restored(binding: ConversationBinding, thread: ThreadSnapshot): void;
  stop(): void;
};

interface ThreadReleaseCondition {
  isCurrent(): boolean;
  verifyIdle(): Promise<boolean>;
  /** Recheck Queue, descendants, local work and observable new activity after
   * releasing a proven terminal Turn; must not reuse invalidated evidence. */
  verifyAfterTerminalUnsubscribe?(): Promise<boolean>;
  canRestore(): boolean;
  observeRestore?: ThreadRestoreObserver;
  restoreRequired?(): void;
}

const maximumBackgroundThreadsPerConversation = 3;
const foregroundThreadSources = new Set(["cli", "vscode", "appServer"]);
class SupersededRestoreError extends Error {}

export class SessionRouter {
  private readonly forceNew = new Set<string>();
  private readonly backgroundStartQueues = new Map<string, Promise<void>>();
  private readonly backgroundReservations = new Map<string, number>();
  private readonly threadLifecycleQueues = new Map<string, Promise<void>>();
  private readonly approvalResolutions = new Set<ApprovalResolution>();
  // Bindings survive unloads and failed detaches, but need a subscription before use.
  private readonly unsubscribedBindings = new Set<string>();
  // 模型设置保留到进程结束：thread/list 不返回 model，
  // 会话列表需要借助本缓存标注已知模型的会话。
  private readonly modelSettingsByThread = new Map<string, ThreadModelSettings>();
  private readonly namesByThread = new Map<string, string | null>();
  private readonly sessionDiagnosticsByThread = new Map<string, Pick<ThreadSession, "contextCompactionItemIds" | "instructionSources"> & { executionContext: ThreadExecutionContext | undefined }>();
  private executionContextRevision = 0;
  private readonly executionContextChanges: (string | undefined | ((threadId: string) => boolean))[] = [];
  private subscriptionRevision = 0;
  private readonly subscriptionChanges: (string | ((threadId: string) => boolean))[] = [];
  private readonly sessionContextRevisions = new WeakMap<ThreadSession, { context: number; subscription: number }>();

  constructor(
    private readonly codex: ThreadLifecyclePort,
    private readonly bindings: BindingStore,
    private readonly workspaces: WorkspaceRegistry,
    private readonly dynamicTools: readonly ThreadDynamicToolSpec[] = [],
    private readonly onBindingsChanged?: () => void,
    private readonly onSubscriptionRestoreRequired?: (binding: ConversationBinding) => void,
  ) {}

  workspace(target: ConversationTarget): Workspace {
    return this.workspaces.require(this.selectedWorkspaceId(target));
  }

  selectedWorkspaceId(target: ConversationTarget): string {
    return this.bindings.getWorkspace(target) ?? this.workspaces.defaultWorkspaceId;
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

  /** Authorize a bound Thread from a fresh read; diagnostic snapshots never grant access. */
  async prepareThreadWorkspaceGuard(threadId: string, beforeSubmit?: () => void): Promise<() => void> {
    beforeSubmit?.();
    const binding = this.bindings.getByThread(threadId);
    if (!binding) throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
    const workspace = this.workspaces.require(binding.workspaceId);
    const background = this.bindings.isBackground(threadId);
    const revision = this.executionContextRevision;
    const assertCurrent = (): void => {
      beforeSubmit?.();
      const changes = this.executionContextRevision - revision;
      if (!this.sameBinding(binding, this.bindings.getByThread(threadId))
        || this.bindings.isBackground(threadId) !== background
        || this.workspaces.get(binding.workspaceId)?.cwd !== workspace.cwd
        || this.unsubscribedBindings.has(threadId)
        || changes > this.executionContextChanges.length
        || (changes > 0 && this.executionContextChanges.slice(-changes)
          .some(changed => typeof changed === "function" ? changed(threadId)
            : changed === undefined || changed === threadId))) {
        throw new UserFacingError("thread.workspace.changed", "会话目录或订阅在等待期间已变化，请用 /status 核对后重试");
      }
    };
    assertCurrent();
    const thread = await this.codex.readThread(threadId, undefined, assertCurrent);
    assertCurrent();
    if (thread.id !== threadId || thread.cwd !== workspace.cwd
      || (!foregroundThreadSources.has(thread.source) && !(background && thread.source === "automation"))) {
      throw new UserFacingError("thread.workspace.changed", "会话执行目录或来源与授权工作区不一致；请在原生端恢复目录，或用 /workspace 选择已登记的工作区后重新选择会话");
    }
    return assertCurrent;
  }

  backgroundBindings(target: ConversationTarget): ConversationBinding[] {
    return this.bindings.backgrounds(target);
  }

  availableBackgroundCapacity(target: ConversationTarget): number {
    return Math.max(0, maximumBackgroundThreadsPerConversation
      - this.backgroundBindings(target).length
      - (this.backgroundReservations.get(this.key(target)) ?? 0));
  }

  isBackgroundThread(threadId: string): boolean {
    return this.bindings.isBackground(threadId);
  }

  targetForThread(threadId: string): ConversationTarget | undefined {
    return this.bindings.getByThread(threadId)?.target;
  }

  /** Resolve only official spawned ancestry, without binding the child Thread. */
  async resolveApprovalTarget(
    threadId: string,
    isPending: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<ApprovalTarget | undefined> {
    if (signal?.aborted || !isPending() || this.approvalResolutions.size >= 100) return undefined;
    const initialBindings = new Map(this.bindings.list().map(binding => [binding.threadId, {
      ...binding, target: { ...binding.target },
    }]));
    const visited = new Set<string>();
    const initialWorkspaceCwds = new Map(this.workspaces.list().map(workspace => [workspace.id, workspace.cwd]));
    const resolution: ApprovalResolution = {
      bindings: initialBindings, workspaceCwds: initialWorkspaceCwds, changedThreads: new Set(), overflowed: false,
    };
    this.approvalResolutions.add(resolution);
    const release = (): void => { this.approvalResolutions.delete(resolution); };
    signal?.addEventListener("abort", release, { once: true });
    const relatedThreadIds: string[] = [];
    let expectedCwd: string | undefined;
    let expectedProvider: string | undefined;
    let currentId: string | null | undefined = threadId;
    let retainObserver = false;
    try {
      // A malformed or unexpectedly deep tree must not create unbounded RPC work.
      for (let depth = 0; currentId && depth < 16; depth += 1) {
        if (!isPending() || signal?.aborted || resolution.overflowed || visited.has(currentId)) return undefined;
        visited.add(currentId);
        relatedThreadIds.push(currentId);
        const snapshot = await this.codex.readThread(currentId, signal);
        if (!isPending() || signal?.aborted || resolution.overflowed
          || relatedThreadIds.some(id => resolution.changedThreads.has(id))) return undefined;
        if (snapshot.id !== currentId || snapshot.source === "automation" || !snapshot.modelProvider
          || !this.isProviderSelectable(snapshot.modelProvider)
          || (expectedCwd !== undefined && snapshot.cwd !== expectedCwd)
          || (expectedProvider !== undefined && snapshot.modelProvider !== expectedProvider)) return undefined;
        expectedCwd = snapshot.cwd;
        expectedProvider = snapshot.modelProvider;
        const binding = initialBindings.get(currentId);
        const currentBinding = this.bindings.getByThread(currentId);
        if (!binding && currentBinding) return undefined;
        if (binding) {
          const workspace = this.workspaces.get(binding.workspaceId);
          if (!workspace || workspace.cwd !== snapshot.cwd || workspace.cwd !== initialWorkspaceCwds.get(binding.workspaceId)) return undefined;
          const ownerThreadId = currentId;
          const provider = snapshot.modelProvider;
          const cwd = workspace.cwd;
          const isCurrent = (): boolean => {
            const currentProvider = this.modelSettingsByThread.get(ownerThreadId)?.modelProvider;
            return !signal?.aborted && !resolution.overflowed
              && !relatedThreadIds.some(id => resolution.changedThreads.has(id))
              && this.sameBinding(binding, this.bindings.getByThread(ownerThreadId))
              && this.workspaces.get(binding.workspaceId)?.cwd === cwd
              && this.isProviderSelectable(provider)
              && (currentProvider === undefined || currentProvider === provider)
              && relatedThreadIds.every(id => id === ownerThreadId || !this.bindings.getByThread(id));
          };
          if (!isCurrent()) return undefined;
          // The coordinator owns the signal through routing, queueing and the final response.
          // Keep observing across the promise handoff so an unbind/rebind cannot revive this route.
          retainObserver = signal !== undefined;
          return { target: binding.target, ownerThreadId, relatedThreadIds, isCurrent };
        }
        // forked_from_id is intentionally absent from the stable routing snapshot.
        currentId = snapshot.parentThreadId;
      }
      return undefined;
    } finally {
      if (!retainObserver) {
        release();
        signal?.removeEventListener("abort", release);
      }
    }
  }

  workspaceForThread(threadId: string): RoutedWorkspace | undefined {
    const binding = this.bindings.getByThread(threadId);
    if (!binding) {
      return undefined;
    }
    const workspace = this.workspaces.get(binding.workspaceId);
    return workspace ? { id: workspace.id, name: workspace.name } : undefined;
  }

  readThread(threadId: string, signal?: AbortSignal, beforeSubmit?: () => void): Promise<ThreadSnapshot> {
    return this.codex.readThread(threadId, signal, beforeSubmit);
  }

  hasActiveDescendants(threadId: string, signal?: AbortSignal): Promise<boolean> {
    return this.codex.hasActiveDescendants(threadId, signal);
  }

  foregroundThreadId(target: ConversationTarget): string | undefined {
    return this.bindings.get(target)?.threadId;
  }

  touchActivity(target: ConversationTarget, atMs: number): void {
    // Distinguish inputs arriving in the same millisecond from an idle scan.
    this.bindings.touchActivity(target, Math.max(atMs, this.bindings.idleState(target).lastActivityAt + 1));
  }

  ensureIdleState(target: ConversationTarget, atMs: number): void {
    this.bindings.ensureIdleState(target, atMs);
  }

  idleState(target: ConversationTarget): ConversationIdleState {
    return this.bindings.idleState(target);
  }

  allBindings(): ConversationBinding[] {
    return this.bindings.list();
  }

  modelPreference(target: ConversationTarget): ConversationModelPreference | undefined {
    return this.bindings.get(target) ? undefined : this.bindings.modelPreference(target);
  }

  setModelPreference(target: ConversationTarget, preference: ConversationModelPreference | undefined): void {
    this.bindings.setModelPreference(target, preference);
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
    return this.sessionDiagnosticsByThread.get(threadId)?.contextCompactionItemIds;
  }

  instructionSourcesForThread(threadId: string): readonly string[] | undefined {
    if (!this.bindings.getByThread(threadId) || this.unsubscribedBindings.has(threadId)) return undefined;
    return this.sessionDiagnosticsByThread.get(threadId)?.instructionSources;
  }

  updateModelSettings(threadId: string, settings: ThreadModelSettings): void {
    if (this.bindings.getByThread(threadId)) {
      const current = this.modelSettingsByThread.get(threadId);
      this.modelSettingsByThread.set(threadId, {
        ...(current?.approvalsReviewer === undefined ? {} : { approvalsReviewer: current.approvalsReviewer }),
        ...settings,
        ...(settings.modelProvider
          ? { modelProvider: settings.modelProvider }
          : current?.modelProvider
            ? { modelProvider: current.modelProvider }
            : {}),
      });
    }
  }

  executionContextForThread(threadId: string): ThreadExecutionContext | undefined {
    if (!this.bindings.getByThread(threadId) || this.unsubscribedBindings.has(threadId)) return undefined;
    const context = this.sessionDiagnosticsByThread.get(threadId)?.executionContext;
    return context && { cwd: context.cwd, workspaceRootsSnapshot: {
      cwd: context.workspaceRootsSnapshot.cwd, roots: [...context.workspaceRootsSnapshot.roots],
    } };
  }

  invalidateExecutionContext(threadId?: string): void {
    this.invalidateThreadContext(threadId, false);
  }

  /** The connection owner resolves canonical Provider identity, including unbound responses. */
  invalidateSubscriptions(isAffected: (threadId: string) => boolean): void {
    this.invalidateThreadContext(undefined, false, isAffected);
    this.subscriptionRevision += 1;
    this.subscriptionChanges.push(isAffected);
    if (this.subscriptionChanges.length > 256) this.subscriptionChanges.shift();
    for (const binding of this.bindings.list()) {
      if (!isAffected(binding.threadId)) continue;
      this.invalidateExecutionContext(binding.threadId);
      this.unsubscribedBindings.add(binding.threadId);
    }
  }

  private invalidateThreadContext(threadId: string | undefined, subscriptionLost: boolean,
    connectionScope?: (threadId: string) => boolean): void {
    this.executionContextRevision += 1;
    this.executionContextChanges.push(connectionScope ?? threadId);
    if (this.executionContextChanges.length > 256) this.executionContextChanges.shift();
    if (subscriptionLost && threadId !== undefined) {
      this.subscriptionRevision += 1;
      this.subscriptionChanges.push(threadId);
      if (this.subscriptionChanges.length > 256) this.subscriptionChanges.shift();
    }
    if (threadId === undefined) return; // A disconnect also invalidates unbound in-flight creations.
    const diagnostics = this.sessionDiagnosticsByThread.get(threadId);
    if (diagnostics) diagnostics.executionContext = undefined;
    for (const resolution of this.approvalResolutions) {
      resolution.changedThreads.add(threadId);
      if (resolution.changedThreads.size > 1_024) {
        resolution.overflowed = true;
        resolution.changedThreads.clear();
        this.approvalResolutions.delete(resolution);
      }
    }
  }

  observeThreadCwd(threadId: string, cwd: string): void {
    const diagnostics = this.sessionDiagnosticsByThread.get(threadId);
    const context = this.executionContextForThread(threadId);
    // Unknown/closed contexts require a successful lifecycle response, not a late notification.
    if (!context || context.cwd !== cwd) this.invalidateExecutionContext(threadId);
    if (context && diagnostics) diagnostics.executionContext = { ...context, cwd };
  }

  private async observeSessionContext<T extends ThreadSession>(operation: () => Promise<T>): Promise<T> {
    const revision = { context: this.executionContextRevision, subscription: this.subscriptionRevision };
    const session = await operation();
    this.sessionContextRevisions.set(session, revision);
    return session;
  }

  private sessionExecutionContext(session: ThreadSession): ThreadExecutionContext | undefined {
    if (!this.isSessionContextCurrent(session)) return undefined;
    return { cwd: session.effectiveSettings.cwd, workspaceRootsSnapshot: {
      cwd: session.effectiveSettings.cwd, roots: [...session.runtimeWorkspaceRoots],
    } };
  }

  private isSessionContextCurrent(session: ThreadSession, subscriptionOnly = false): boolean {
    const revision = this.sessionContextRevisions.get(session);
    if (revision === undefined) return false;
    const changes = subscriptionOnly
      ? this.subscriptionRevision - revision.subscription
      : this.executionContextRevision - revision.context;
    const history = subscriptionOnly ? this.subscriptionChanges : this.executionContextChanges;
    // Cwd-only diagnostic overflow cannot invalidate a live subscription.
    if (changes > history.length
      || (changes > 0 && history.slice(-changes)
        // Diagnostic snapshots retain their conservative disconnect behavior;
        // submission guards use the connection scope stored in the same history.
        .some(change => typeof change === "function" ? !subscriptionOnly || change(session.thread.id)
          : change === undefined || change === session.thread.id))) return false;
    return true;
  }

  private requireCurrentSubscription(session: ThreadSession): void {
    if (!this.isSessionContextCurrent(session, true)) {
      this.markThreadUnsubscribed(session.thread.id);
      this.requestSubscriptionRestore(session.thread.id);
      throw new UserFacingError("conversation.busy", "会话订阅已失效，请等待恢复后重试", { reason: "subscription-restoring" });
    }
  }

  private captureSessionDiagnostics(session: ThreadSession): void {
    this.requireCurrentSubscription(session);
    this.sessionDiagnosticsByThread.set(session.thread.id, {
      contextCompactionItemIds: session.contextCompactionItemIds,
      instructionSources: session.instructionSources,
      executionContext: this.sessionExecutionContext(session),
    });
    this.unsubscribedBindings.delete(session.thread.id);
  }

  private async unsubscribeThread(threadId: string, beforeSubmit?: () => void): Promise<void> {
    await this.codex.unsubscribeThread(threadId, beforeSubmit);
    this.markThreadUnsubscribed(threadId);
  }

  /** Record subscription loss without scheduling recovery before its owner is ready. */
  markThreadUnsubscribed(threadId: string): () => boolean {
    this.invalidateThreadContext(threadId, true);
    if (this.bindings.getByThread(threadId)) this.unsubscribedBindings.add(threadId);
    const diagnostics = this.sessionDiagnosticsByThread.get(threadId);
    return () => {
      const current = this.sessionDiagnosticsByThread.get(threadId);
      return current === undefined || current === diagnostics;
    };
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
    observeRestore?: ThreadRestoreObserver,
    optionsForBinding: (binding: ConversationBinding) => ThreadStartOptions = () => ({}),
  ): Promise<SubscriptionRestoreFailure[]> {
    const failures: SubscriptionRestoreFailure[] = [];
    for (const binding of this.bindings.list()) {
      const failure = await this.withThreadLifecycle([binding.threadId], async (): Promise<SubscriptionRestoreFailure | undefined> => {
        const isCurrent = () => this.sameBinding(binding, this.bindings.getByThread(binding.threadId))
          && shouldRestore(binding.target, binding);
        if (!isCurrent()) return undefined;
        let observation: ReturnType<ThreadRestoreObserver> | undefined;
        try {
          let restoredBinding: ConversationBinding;
          let restoredThread: ThreadSnapshot;
          const wasBackground = this.bindings.isBackground(binding.threadId);
          try {
            const workspace = this.workspaces.require(binding.workspaceId);
            const historical = await this.codex.readThread(binding.threadId);
            if (!isCurrent()) return undefined;
            observation = observeRestore?.(binding.threadId);
            const resumed = await this.resumeInWorkspace(
              historical,
              workspace,
              optionsForBinding(binding),
              false,
              isCurrent,
            );
            this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort, resumed.serviceTier, resumed.collaborationMode, resumed.approvalsReviewer);
            this.namesByThread.set(resumed.thread.id, resumed.thread.name);
            this.captureSessionDiagnostics(resumed);
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
            if (!this.sameBinding(binding, restoredBinding)) this.notifyBindingsChanged();
          } catch (error) {
            if (error instanceof SupersededRestoreError) return undefined;
            const normalized = error instanceof Error ? error : new Error(String(error));
            const incompatible = isIncompatibleRestoreError(normalized);
            if (!incompatible && !isCurrent()) return undefined;
            const bindingRemoved = incompatible || isUnavailableRestoreError(normalized);
            if (incompatible) {
              this.invalidateThreadBinding(binding.threadId);
            } else if (bindingRemoved) {
              this.bindings.removeThread(binding.threadId);
              this.sessionDiagnosticsByThread.delete(binding.threadId);
              // Removing an unavailable Thread must not replace the saved Workspace
              // selection, including an ID absent from the current configuration.
              this.notifyBindingsChanged();
            }
            return {
              binding,
              error: normalized,
              bindingRemoved,
              reason: bindingRemoved
                ? "unavailable"
                : isActiveWriterRestoreError(normalized)
                  ? "active-writer"
                  : "other",
            };
          }
          observation?.restored(restoredBinding, restoredThread);
          return undefined;
        } finally {
          observation?.stop();
        }
      });
      if (failure) failures.push(failure);
    }
    return failures;
  }

  async list(target: ConversationTarget, options: ThreadListOptions = {}): Promise<ThreadSnapshot[]> {
    options.beforeSubmit?.();
    const workspace = this.workspace(target);
    const fast = await this.codex.listThreads(workspace.cwd, options);
    options.beforeSubmit?.();
    return fast.length > 0
      ? fast
      : this.codex.listThreads(workspace.cwd, { ...options, fullScan: true });
  }

  async ensure(
    target: ConversationTarget,
    startOptions: ThreadStartOptions = {},
    observeRestore?: ThreadRestoreObserver,
  ): Promise<ConversationBinding> {
    startOptions.beforeSubmit?.();
    const current = this.bindings.get(target);
    if (current) {
      const pending = this.threadLifecycleQueues.get(current.threadId);
      if (pending) {
        await pending;
        return this.ensure(target, startOptions, observeRestore);
      }
      const observation = observeRestore?.(current.threadId);
      let thread: ThreadSnapshot;
      try {
        thread = await this.codex.readThread(current.threadId, undefined, startOptions.beforeSubmit);
        startOptions.beforeSubmit?.();
        if (this.sameBinding(current, this.bindings.get(target))
          && !this.threadLifecycleQueues.has(current.threadId)) {
          const workspace = this.workspaces.require(current.workspaceId);
          if (thread.id === current.threadId && thread.cwd === workspace.cwd
            && foregroundThreadSources.has(thread.source)
            && thread.status.type !== "notLoaded"
            && !this.unsubscribedBindings.has(current.threadId)) {
            observation?.restored(current, thread);
          }
        }
      } finally {
        observation?.stop();
      }
      if (!this.sameBinding(current, this.bindings.get(target))
        || this.threadLifecycleQueues.has(current.threadId)) {
        return this.ensure(target, startOptions, observeRestore);
      }
      const workspace = this.workspaces.require(current.workspaceId);
      if (thread.id !== current.threadId || thread.cwd !== workspace.cwd
        || !foregroundThreadSources.has(thread.source)) {
        await this.withThreadLifecycle([current.threadId], async () => {
          if (!this.sameBinding(current, this.bindings.get(target))) return;
          const latest = await this.codex.readThread(current.threadId, undefined, startOptions.beforeSubmit);
          if (!this.sameBinding(current, this.bindings.get(target))) return;
          const latestWorkspace = this.workspaces.require(current.workspaceId);
          if (latest.id !== current.threadId || latest.cwd !== latestWorkspace.cwd
            || !foregroundThreadSources.has(latest.source)) {
            await this.rejectIncompatibleThread(current.threadId, new UserFacingError(
              "thread.takeover.changed", "当前会话与授权工作区或可恢复来源不一致，已解除绑定",
            ), true);
          }
        });
        return this.ensure(target, startOptions, observeRestore);
      }
      if (thread.status.type === "notLoaded") this.unsubscribedBindings.add(current.threadId);
      if (this.unsubscribedBindings.has(current.threadId)) {
        if (!observeRestore && this.onSubscriptionRestoreRequired) {
          this.onSubscriptionRestoreRequired(current);
          throw new UserFacingError("conversation.busy", "会话订阅正在恢复，请稍后重试", { reason: "subscription-restoring" });
        }
        const failures = await this.restoreSubscriptions((_target, binding) =>
          this.sameBinding(current, binding), observeRestore,
        () => startOptions.beforeSubmit ? { beforeSubmit: startOptions.beforeSubmit } : {});
        if (failures[0]) throw failures[0].error;
        const restored = this.bindings.get(target);
        if (restored && this.sameBinding(current, restored)
          && !this.unsubscribedBindings.has(restored.threadId)) return restored;
        return this.ensure(target, startOptions, observeRestore);
      }
      return current;
    }
    const workspace = this.workspace(target);
    this.bindings.selectWorkspace(target, workspace.id);
    if (!this.shouldForceNew(target)) {
      const sessions = await this.list(target, { ...(startOptions.beforeSubmit ? { beforeSubmit: startOptions.beforeSubmit } : {}) });
      startOptions.beforeSubmit?.();
      const candidate = sessions.find(
        (thread) =>
          thread.status.type !== "active"
          && foregroundThreadSources.has(thread.source)
          && !this.bindings.getByThread(thread.id)
          && (
            startOptions.modelProvider === undefined
            || thread.modelProvider === startOptions.modelProvider
          )
          && this.isProviderSelectable(thread.modelProvider),
      );
      if (candidate) {
        return this.withThreadLifecycle([candidate.id], async () => {
          if (this.bindings.getByThread(candidate.id)) {
            throw new UserFacingError("thread.bound", "该 Codex Thread 已绑定到其他会话");
          }
          const historical = await this.codex.readThread(candidate.id, undefined, startOptions.beforeSubmit);
          const observation = observeRestore?.(candidate.id);
          try {
            const resumed = await this.resumeInWorkspace(historical, workspace, startOptions);
            if (resumed.thread.status.type === "active") {
              await this.cleanupFailedResume(candidate.id, new UserFacingError(
                "conversation.busy", "历史会话已有运行中的任务，请显式恢复会话",
              ));
            }
            const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
            try {
              this.requireCurrentSubscription(resumed);
              this.bindings.bind(binding);
            } catch (error) {
              await this.cleanupFailedResume(resumed.thread.id, error);
            }
            this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort, resumed.serviceTier, resumed.collaborationMode, resumed.approvalsReviewer);
            this.namesByThread.set(resumed.thread.id, resumed.thread.name);
            this.captureSessionDiagnostics(resumed);
            this.clearForceNew(target, Date.now());
            observation?.restored(binding, resumed.thread);
            this.notifyBindingsChanged();
            return binding;
          } finally {
            observation?.stop();
          }
        });
      }
    }

    const started = await this.observeSessionContext(() => this.codex.startThread(workspace.cwd, {
      ...startOptions,
      ...(this.dynamicTools.length > 0
        ? { dynamicTools: this.dynamicTools }
        : {}),
    }));
    try { startOptions.beforeSubmit?.(); }
    catch (error) { await this.cleanupFailedResume(started.thread.id, error, false); }
    const binding = { target, workspaceId: workspace.id, threadId: started.thread.id, sessionId: started.thread.sessionId };
    try {
      this.requireCurrentSubscription(started);
      this.bindings.bind(binding);
    } catch (error) {
      await this.cleanupFailedResume(started.thread.id, error);
    }
    this.captureModelSettings(started.thread.id, started.model, started.modelProvider, started.reasoningEffort, started.serviceTier, "default", started.approvalsReviewer);
    this.namesByThread.set(started.thread.id, started.thread.name);
    this.captureSessionDiagnostics(started);
    this.clearForceNew(target, Date.now());
    this.notifyBindingsChanged();
    return binding;
  }

  requestSubscriptionRestore(threadId: string): void {
    const binding = this.bindings.getByThread(threadId);
    if (!binding || !this.unsubscribedBindings.has(threadId)) return;
    this.onSubscriptionRestoreRequired?.(binding);
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
      startOptions.beforeSubmit?.();
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
        "scheduled-task.state.invalid",
        "后台计划任务不允许 danger-full-access",
      );
    }
    if (
      startOptions.approvalPolicy !== undefined
      && startOptions.approvalPolicy !== "never"
    ) {
      throw new UserFacingError(
        "scheduled-task.state.invalid",
        "后台计划任务必须使用 approvalPolicy=never",
      );
    }
    const backgroundStartOptions: ThreadStartOptions = { ...startOptions };
    delete backgroundStartOptions.dynamicTools;
    return this.withBackgroundCapacity(target, 1, async () => {
      const workspace = workspaceId === undefined
        ? this.workspace(target)
        : this.workspaces.require(workspaceId);
      const session = await this.observeSessionContext(() => this.codex.startThread(workspace.cwd, {
        ...backgroundStartOptions,
        threadSource: "automation",
      }));
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
        this.requireCurrentSubscription(session);
        this.bindings.bindBackground(binding);
      } catch (error) {
        await this.cleanupFailedResume(session.thread.id, error);
      }
      this.captureModelSettings(
        session.thread.id,
        session.model,
        session.modelProvider,
        session.reasoningEffort,
        session.serviceTier,
        "default",
        session.approvalsReviewer,
      );
      this.namesByThread.set(session.thread.id, session.thread.name);
      this.captureSessionDiagnostics(session);
      this.notifyBindingsChanged();
      return { binding, session };
    });
  }

  async resume(
    target: ConversationTarget,
    threadId: string,
    preserveCurrent = false,
    expectedCwd?: string,
    transition?: {
      assertCurrent: () => void;
      observeRestore?: ThreadRestoreObserver;
      verifyPreviousIdle?: () => Promise<boolean>;
      verifyPreviousAfterTerminalUnsubscribe?: () => Promise<boolean>;
      observePreviousRestore?: ThreadRestoreObserver;
      restorePreviousFailed?: () => void;
    },
    assertAuthorized?: () => void,
  ): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    const assertCurrent = this.lifecycleGuard(target, current, assertAuthorized);
    return this.withThreadLifecycle([threadId, ...(current ? [current.threadId] : [])], () => {
      assertCurrent();
      const additional = preserveCurrent && current && current.threadId !== threadId
        && !this.bindings.isBackground(threadId) ? 1 : 0;
      return this.withBackgroundCapacity(target, additional,
        () => this.resumeUnlocked(target, threadId, preserveCurrent, expectedCwd, transition, assertCurrent));
    });
  }

  private async resumeUnlocked(
    target: ConversationTarget,
    threadId: string,
    preserveCurrent = false,
    expectedCwd?: string,
    transition?: Parameters<SessionRouter["resume"]>[4],
    assertAuthorized?: () => void,
  ): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    const assertCurrent = (): void => {
      assertAuthorized?.();
      transition?.assertCurrent();
    };
    assertCurrent();
    const owner = this.bindings.getByThread(threadId);
    if (owner && this.key(owner.target) !== this.key(target)) {
      throw new UserFacingError("thread.bound", "该 Codex Thread 已绑定到其他会话");
    }
    const thread = await this.codex.readThread(threadId, undefined, assertCurrent);
    assertCurrent();
    if (owner && thread.cwd !== this.workspaces.require(owner.workspaceId).cwd) {
      await this.rejectIncompatibleThread(threadId, new UserFacingError(
        "thread.takeover.changed", "历史目录与现有绑定不一致，已解除绑定",
      ), true);
    }
    if (expectedCwd !== undefined && thread.cwd !== expectedCwd) {
      throw new UserFacingError("thread.takeover.changed", "Codex Thread 工作目录已变化，请重新选择");
    }
    const workspace = this.workspace(target);
    if (thread.cwd !== workspace.cwd) {
      throw new UserFacingError("thread.takeover.workspace", "不允许跨工作区恢复历史，请先切换工作区");
    }
    if (!foregroundThreadSources.has(thread.source)) {
      throw new UserFacingError("session.selector.not-found", "找不到已授权工作区中的可恢复会话");
    }
    const observation = transition?.observeRestore?.(threadId);
    try {
      const resumed = await this.resumeInWorkspace(thread, workspace, { beforeSubmit: assertCurrent });
      let previousUnsubscribed = false;
      try {
        assertCurrent();
        this.requireCurrentSubscription(resumed);
        if (current && current.threadId !== resumed.thread.id && !preserveCurrent) {
          const previous = await this.codex.readThread(current.threadId, undefined, assertCurrent);
          const terminalRelease = previous.status.type === "systemError" && isThreadExecutionSettled(previous);
          if (transition?.verifyPreviousIdle && !await transition.verifyPreviousIdle()) {
            throw new UserFacingError("thread.takeover.changed", "原会话仍有活动，请重新选择会话");
          }
          assertCurrent();
          await this.unsubscribeThread(current.threadId, assertCurrent);
          previousUnsubscribed = true;
          const verifyPrevious = terminalRelease
            ? transition?.verifyPreviousAfterTerminalUnsubscribe ?? transition?.verifyPreviousIdle
            : transition?.verifyPreviousIdle;
          if (verifyPrevious && !await verifyPrevious()) {
            throw new UserFacingError("thread.takeover.changed", "原会话活动已变化，请重新选择会话");
          }
        }
        assertCurrent();
        this.requireCurrentSubscription(resumed);
        const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
        this.bindings.switchForeground(binding, preserveCurrent);
      } catch (error) {
        let failure = error;
        if (previousUnsubscribed && current && this.sameBinding(current, this.bindings.get(target))) {
          try {
            await this.restoreUnsubscribedBinding(current, undefined, undefined, transition?.observePreviousRestore);
          } catch (restoreError) {
            transition?.restorePreviousFailed?.();
            failure = new AggregateError([error, restoreError], "绑定切换失败，且原订阅恢复失败", { cause: error });
          }
        }
        await this.cleanupFailedResume(threadId, failure);
      }
      if (previousUnsubscribed && current) this.sessionDiagnosticsByThread.delete(current.threadId);
      this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort, resumed.serviceTier, resumed.collaborationMode, resumed.approvalsReviewer);
      this.namesByThread.set(resumed.thread.id, resumed.thread.name);
      this.captureSessionDiagnostics(resumed);
      const binding = { target, workspaceId: workspace.id, threadId: resumed.thread.id, sessionId: resumed.thread.sessionId };
      this.clearForceNew(target, Date.now());
      observation?.restored(binding, resumed.thread);
      this.notifyBindingsChanged();
      return binding;
    } finally {
      observation?.stop();
    }
  }

  private async resumeInWorkspace(
    thread: ThreadSnapshot,
    workspace: Workspace,
    options: ThreadStartOptions = {},
    preserveSubscription = this.bindings.getByThread(thread.id) !== undefined,
    isCurrent?: () => boolean,
  ): Promise<ThreadResumeSession> {
    if (thread.cwd !== workspace.cwd) {
      await this.rejectIncompatibleThread(thread.id, new UserFacingError(
        "thread.takeover.changed", "历史目录与工作区不一致，请显式恢复会话",
      ), preserveSubscription);
    }
    const threadId = thread.id;
    const session = await this.observeSessionContext(() => this.codex.resumeThread(threadId, workspace.cwd, options));
    try { options.beforeSubmit?.(); }
    catch (error) { await this.cleanupFailedResume(threadId, error, preserveSubscription); }
    if (isCurrent && !isCurrent()) {
      await this.cleanupFailedResume(threadId, new SupersededRestoreError(), this.bindings.getByThread(threadId) !== undefined);
    }
    const effective = session.effectiveSettings;
    if (
      session.thread.id !== threadId
      || effective.cwd !== workspace.cwd
      || !session.settingsMatch
      || (session.thread.status.type === "active" && session.thread.activeTurnId === null)
    ) {
      await this.rejectIncompatibleThread(threadId, new UserFacingError(
        "thread.takeover.changed", "恢复后的实际目录、请求约束或活动状态不符合要求，未切换会话",
      ), true);
    }
    // Restore authoritative settings and active-turn management without
    // changing the reviewer based on Provider or model identity.
    return session;
  }

  private invalidateThreadBinding(threadId: string): void {
    const binding = this.bindings.getByThread(threadId);
    if (!binding) return;
    const wasForeground = this.bindings.get(binding.target)?.threadId === threadId;
    this.bindings.removeThread(threadId);
    this.sessionDiagnosticsByThread.delete(threadId);
    if (wasForeground) this.markForceNew(binding.target, Date.now());
    this.notifyBindingsChanged();
  }

  private async rejectIncompatibleThread(
    threadId: string,
    error: UserFacingError,
    subscribed: boolean,
  ): Promise<never> {
    this.invalidateThreadBinding(threadId);
    if (subscribed) await this.cleanupFailedResume(threadId, error, false);
    throw error;
  }

  private async cleanupFailedResume(
    threadId: string,
    error: unknown,
    preserveSubscription = this.bindings.getByThread(threadId) !== undefined,
  ): Promise<never> {
    if (!preserveSubscription) {
      try {
        await this.unsubscribeThread(threadId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "恢复失败，且新订阅清理失败", { cause: cleanupError });
      }
    }
    throw error;
  }

  async transferBinding(
    target: ConversationTarget,
    threadId: string,
    assertAuthorized?: () => void,
    observeRestore?: ThreadRestoreObserver,
  ): Promise<BindingTransfer> {
    const current = this.bindings.get(target);
    const owner = this.bindings.getByThread(threadId);
    const assertCurrent = this.lifecycleGuard(target, current, assertAuthorized);
    const assertTransferCurrent = (): void => {
      assertCurrent();
      if (!owner || !this.sameBinding(owner, this.bindings.getByThread(threadId))) {
        throw new UserFacingError("thread.takeover.changed", "Codex Thread 绑定已变化，请重新选择");
      }
    };
    return this.withThreadLifecycle([threadId, ...(current ? [current.threadId] : [])], () => {
      assertTransferCurrent();
      return this.transferBindingUnlocked(target, threadId, assertTransferCurrent, observeRestore);
    });
  }

  private async transferBindingUnlocked(target: ConversationTarget, threadId: string, assertAuthorized?: () => void,
    observeRestore?: ThreadRestoreObserver): Promise<BindingTransfer> {
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
      this.codex.readThread(threadId, undefined, assertAuthorized),
      ...(replaced && replaced.threadId !== threadId
        ? [this.codex.readThread(replaced.threadId, undefined, assertAuthorized)]
        : []),
    ]);
    assertAuthorized?.();
    if (threads[0]?.cwd !== workspace.cwd) {
      await this.rejectIncompatibleThread(threadId, new UserFacingError(
        "thread.takeover.changed", "Codex Thread 工作目录与绑定已不一致，请重新选择",
      ), true);
    }
    if (threads.some((thread) => thread.status.type !== "idle")) {
      throw new UserFacingError(
        "thread.takeover.busy",
        "原渠道或当前渠道仍有运行中的任务，暂不能接管",
      );
    }
    if (replaced && replaced.threadId !== threadId) {
      assertAuthorized?.();
      await this.unsubscribeThread(replaced.threadId, assertAuthorized);
    }
    let transfer: BindingTransfer;
    try {
      assertAuthorized?.();
      transfer = this.bindings.transfer(threadId, target);
    } catch (error) {
      if (replaced && replaced.threadId !== threadId && this.sameBinding(replaced, this.bindings.get(target))) {
        try {
          await this.restoreUnsubscribedBinding(replaced, undefined, undefined, observeRestore);
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
      this.sessionDiagnosticsByThread.delete(replaced.threadId);
    }
    this.markForceNew(owner.target, Date.now());
    this.clearForceNew(target, Date.now());
    this.notifyBindingsChanged();
    return transfer;
  }

  async newSession(target: ConversationTarget, preserveCurrent = false, preference?: ConversationModelPreference,
    condition?: ThreadReleaseCondition, assertAuthorized?: () => void, onCommitted?: () => void): Promise<void> {
    const current = this.bindings.get(target);
    const assertCurrent = this.lifecycleGuard(target, current, assertAuthorized);
    return this.withThreadLifecycle(current ? [current.threadId] : [], async () => {
      assertCurrent();
      if (preserveCurrent) {
        if (this.bindings.get(target)) this.requireBackgroundCapacity(target, 1);
        this.bindings.demote(target, preference);
        onCommitted?.();
      } else if (current && condition) {
        const snapshot = await this.codex.readThread(current.threadId);
        assertCurrent();
        if (!condition.isCurrent() || !await condition.verifyIdle()
          || !await this.releaseIdleUnlocked(target, current, snapshot, condition, preference, assertCurrent, onCommitted)) {
          throw new UserFacingError("thread.takeover.changed", "当前会话活动已变化，请重新新建会话");
        }
      } else {
        await this.detachUnlocked(target, preference, assertCurrent, onCommitted);
      }
      // Both unbind and demote persist the marker with the binding change.
      if (!current) {
        assertCurrent();
        this.markForceNew(target, Date.now());
      }
    });
  }

  async releaseIdle(
    target: ConversationTarget,
    expected: ConversationBinding,
    snapshot: ThreadSnapshot,
    condition: ThreadReleaseCondition,
    preference?: ConversationModelPreference,
  ): Promise<boolean> {
    return this.withThreadLifecycle([expected.threadId], () =>
      this.releaseIdleUnlocked(target, expected, snapshot, condition, preference));
  }

  private async releaseIdleUnlocked(
    target: ConversationTarget,
    expected: ConversationBinding,
    snapshot: ThreadSnapshot,
    condition: ThreadReleaseCondition,
    preference?: ConversationModelPreference,
    assertAuthorized?: () => void,
    onCommitted?: () => void,
  ): Promise<boolean> {
    const ownsBinding = () => this.sameBinding(expected, this.bindings.get(target));
    if (!ownsBinding() || !condition.isCurrent()) return false;
    // For a proven failed Turn, the last authoritative check must run while
    // subscribed. Unsubscribe invalidates the live notification evidence; a
    // later metadata-only read cannot prove that another client stayed idle.
    const terminalRelease = snapshot.status.type === "systemError" && isThreadExecutionSettled(snapshot);
    if (terminalRelease && !await condition.verifyIdle()) return false;
    if (!ownsBinding() || !condition.isCurrent()) return false;
    assertAuthorized?.();
    await this.unsubscribeThread(expected.threadId, assertAuthorized);
    this.unsubscribedBindings.add(expected.threadId);
    let verified = false;
    try {
      verified = ownsBinding() && condition.isCurrent() && await (terminalRelease && condition.verifyAfterTerminalUnsubscribe
        ? condition.verifyAfterTerminalUnsubscribe() : condition.verifyIdle());
    } catch {
      // An inconclusive final read must preserve the binding and restore its
      // subscription just like activity arriving during unsubscribe.
    }
    if (!verified || !ownsBinding() || !condition.isCurrent()) {
      // Unsubscribe is already effective on the server. Keep the local binding
      // and restore its subscription when cancellation came from new activity.
      // Shutdown/disconnection instead leaves restoration to reconnect.
      await this.restoreUnsubscribedBinding(expected, snapshot, condition);
      return false;
    }
    try {
      assertAuthorized?.();
      this.bindings.unbind(target, preference);
    } catch (error) {
      try {
        await this.restoreUnsubscribedBinding(expected, snapshot, condition);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "解除绑定失败，且原订阅恢复失败", { cause: restoreError });
      }
      throw error;
    }
    onCommitted?.();
    this.unsubscribedBindings.delete(expected.threadId);
    this.sessionDiagnosticsByThread.delete(expected.threadId);
    this.notifyBindingsChanged();
    return true;
  }

  async releaseBackground(threadId: string, condition?: ThreadReleaseCondition): Promise<ConversationTarget | undefined> {
    return this.withThreadLifecycle([threadId], async () => {
      const binding = this.bindings.getByThread(threadId);
      // Revocation may already have removed the local binding while a fresh
      // background Thread was being created. Still cancel our subscription;
      // never unsubscribe a Thread that has since become a valid foreground.
      if (binding && !this.bindings.isBackground(threadId)) return undefined;
      let snapshot: ThreadSnapshot | undefined;
      const isCurrent = () => binding !== undefined && this.sameBinding(binding, this.bindings.getByThread(threadId))
        && this.bindings.isBackground(threadId) && condition?.isCurrent() === true;
      if (condition) {
        if (!isCurrent() || !await condition.verifyIdle() || !isCurrent()) return undefined;
        snapshot = await this.codex.readThread(threadId);
        if (!isCurrent() || !isThreadExecutionSettled(snapshot)) return undefined;
      }
      const terminalRelease = snapshot?.status.type === "systemError" && isThreadExecutionSettled(snapshot);
      if (terminalRelease && condition && (!await condition.verifyIdle() || !isCurrent())) return undefined;
      await this.unsubscribeThread(threadId, condition ? () => {
        if (!isCurrent()) throw new UserFacingError("thread.takeover.changed", "会话活动或绑定已变化，请重新操作");
      } : undefined);
      if (condition && binding && snapshot) {
        let verified = false;
        let verificationFailed = false;
        let verificationError: unknown;
        try { verified = isCurrent() && await (terminalRelease && condition.verifyAfterTerminalUnsubscribe
          ? condition.verifyAfterTerminalUnsubscribe() : condition.verifyIdle()) && isCurrent(); } catch (error) {
          // Keep the binding when the final observation is inconclusive.
          verificationFailed = true;
          verificationError = error;
        }
        if (!verified) {
          if (this.sameBinding(binding, this.bindings.getByThread(threadId)) && condition.canRestore()) {
            const observation = condition.observeRestore?.(threadId);
            try {
              const resumed = await this.resumeInWorkspace(snapshot, this.workspaces.require(binding.workspaceId), {}, false,
                () => this.sameBinding(binding, this.bindings.getByThread(threadId)) && condition.canRestore());
              this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort,
                resumed.serviceTier, resumed.collaborationMode, resumed.approvalsReviewer);
              this.namesByThread.set(resumed.thread.id, resumed.thread.name);
              this.captureSessionDiagnostics(resumed);
              observation?.restored(binding, resumed.thread);
            } finally {
              observation?.stop();
            }
          }
          if (verificationFailed) throw verificationError;
          return undefined;
        }
      }
      if (binding) this.bindings.removeThread(threadId);
      this.sessionDiagnosticsByThread.delete(threadId);
      this.notifyBindingsChanged();
      return binding?.target;
    });
  }

  async selectWorkspace(target: ConversationTarget, workspaceId: string, preference?: ConversationModelPreference,
    assertAuthorized?: () => void): Promise<Workspace> {
    const current = this.bindings.get(target);
    const workspace = this.workspaces.require(workspaceId);
    const assertCurrent = this.lifecycleGuard(target, current, assertAuthorized);
    const assertDetached = this.lifecycleGuard(target, undefined, assertAuthorized);
    const assertSelectionCurrent = (): void => {
      assertCurrent();
      if (this.workspaces.get(workspaceId)?.cwd !== workspace.cwd) {
        throw new UserFacingError("thread.takeover.changed", "Workspace 已变化，请重新选择");
      }
    };
    return this.withThreadLifecycle(current ? [current.threadId] : [], async () => {
      assertSelectionCurrent();
      if (this.selectedWorkspaceId(target) === workspace.id) {
        return workspace;
      }
      await this.detachUnlocked(target, preference, assertSelectionCurrent);
      // The previous detach may have committed. Require its resulting empty
      // foreground instead of accepting a newer binding after the await.
      assertDetached();
      if (this.workspaces.get(workspaceId)?.cwd !== workspace.cwd) {
        throw new UserFacingError("thread.takeover.changed", "Workspace 已变化，请重新选择");
      }
      this.bindings.selectWorkspace(target, workspace.id);
      // Workspace changes start a fresh conversation.  Keep the marker until
      // ensure() creates the first Thread so it cannot auto-resume history from
      // the newly selected workspace.
      this.markForceNew(target, Date.now());
      return workspace;
    });
  }

  async fork(
    target: ConversationTarget,
    startOptions: ThreadStartOptions = {},
    assertAuthorized?: () => void,
    observeRestore?: ThreadRestoreObserver,
  ): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    const assertCurrent = this.lifecycleGuard(target, current, assertAuthorized);
    return this.withThreadLifecycle(current ? [current.threadId] : [], () => {
      assertCurrent();
      return this.forkUnlocked(target, startOptions, assertCurrent, observeRestore);
    });
  }

  private async forkUnlocked(target: ConversationTarget, startOptions: ThreadStartOptions, assertAuthorized?: () => void,
    observeRestore?: ThreadRestoreObserver): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    if (!current) {
      throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
    }
    const workspace = this.workspaces.require(current.workspaceId);
    const forked = await this.observeSessionContext(() => this.codex.forkThread(
      current.threadId,
      workspace.cwd,
      {
        beforeSubmit: () => {
          assertAuthorized?.();
          startOptions.beforeSubmit?.();
        },
        ...(startOptions.model === undefined ? {} : { model: startOptions.model }),
        ...(startOptions.modelProvider === undefined
          ? {}
          : { modelProvider: startOptions.modelProvider }),
      },
    ));
    const binding = {
      target,
      workspaceId: workspace.id,
      threadId: forked.thread.id,
      sessionId: forked.thread.sessionId,
    };
    let previousUnsubscribed = false;
    const assertCurrent = (): void => {
      assertAuthorized?.();
      startOptions.beforeSubmit?.();
      if (!this.sameBinding(current, this.bindings.get(target))) {
        throw new UserFacingError("thread.takeover.changed", "等待期间会话绑定已变化，请重新选择");
      }
    };
    try {
      assertCurrent();
      this.requireCurrentSubscription(forked);
      await this.unsubscribeThread(current.threadId, assertCurrent);
      previousUnsubscribed = true;
      assertCurrent();
      this.requireCurrentSubscription(forked);
      this.bindings.switchForeground(binding, false);
    } catch (error) {
      let failure = error;
      if (previousUnsubscribed && this.sameBinding(current, this.bindings.get(target))) {
        try {
          await this.restoreUnsubscribedBinding(current, undefined, undefined, observeRestore);
        } catch (restoreError) {
          failure = new AggregateError([error, restoreError], "分叉绑定切换失败，且原订阅恢复失败", { cause: error });
        }
      }
      await this.cleanupFailedResume(forked.thread.id, failure);
    }
    this.sessionDiagnosticsByThread.delete(current.threadId);
    this.captureModelSettings(forked.thread.id, forked.model, forked.modelProvider, forked.reasoningEffort, forked.serviceTier, "default", forked.approvalsReviewer);
    this.namesByThread.set(forked.thread.id, forked.thread.name);
    this.captureSessionDiagnostics(forked);
    this.clearForceNew(target, Date.now());
    this.notifyBindingsChanged();
    return binding;
  }

  async archive(target: ConversationTarget, assertAuthorized?: () => void): Promise<string> {
    const expected = this.bindings.get(target);
    const assertCurrent = this.lifecycleGuard(target, expected, assertAuthorized);
    return this.withThreadLifecycle(expected ? [expected.threadId] : [], async () => {
      assertCurrent();
      const current = this.bindings.get(target);
      if (!current) {
        throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
      }
      await this.codex.archiveThread(current.threadId, assertCurrent);
      // Archive has committed remotely. Reconcile the known Thread even if
      // authorization changes before its response; do not retry the write.
      this.forgetThread(current.threadId);
      if (!this.bindings.get(target)) this.markForceNew(target, Date.now());
      return current.threadId;
    });
  }

  async archiveThread(threadId: string, assertAuthorized?: () => void): Promise<void> {
    return this.withThreadLifecycle([threadId], async () => {
      assertAuthorized?.();
      await this.codex.archiveThread(threadId, assertAuthorized);
      this.forgetThread(threadId);
    });
  }

  async unarchive(target: ConversationTarget, threadId: string, assertAuthorized?: () => void,
    observeRestore?: ThreadRestoreObserver): Promise<ConversationBinding> {
    const current = this.bindings.get(target);
    const assertCurrent = this.lifecycleGuard(target, current, assertAuthorized);
    return this.withThreadLifecycle([threadId, ...(current ? [current.threadId] : [])], async () => {
      assertCurrent();
      await this.codex.unarchiveThread(threadId, assertCurrent);
      assertCurrent();
      return this.resumeUnlocked(target, threadId, false, undefined, {
        assertCurrent,
        ...(observeRestore ? { observeRestore, observePreviousRestore: observeRestore } : {}),
      }, assertCurrent);
    });
  }

  forgetThread(threadId: string): ConversationTarget | undefined {
    const binding = this.bindings.getByThread(threadId);
    this.sessionDiagnosticsByThread.delete(threadId);
    this.namesByThread.delete(threadId);
    if (binding) {
      this.bindings.removeThread(threadId);
      this.notifyBindingsChanged();
      return binding.target;
    }
    return undefined;
  }

  forgetDeletedThread(threadId: string): ConversationTarget | undefined {
    this.modelSettingsByThread.delete(threadId);
    return this.forgetThread(threadId);
  }

  async detach(target: ConversationTarget, assertAuthorized?: () => void): Promise<void> {
    const current = this.bindings.get(target);
    const assertCurrent = this.lifecycleGuard(target, current, assertAuthorized);
    return this.withThreadLifecycle(current ? [current.threadId] : [], () => {
      assertCurrent();
      return this.detachUnlocked(target, undefined, assertCurrent);
    });
  }

  private async detachUnlocked(target: ConversationTarget, preference?: ConversationModelPreference,
    assertAuthorized?: () => void, onCommitted?: () => void): Promise<void> {
    const current = this.bindings.get(target);
    assertAuthorized?.();
    if (current) {
      await this.unsubscribeThread(current.threadId, assertAuthorized);
      this.unsubscribedBindings.add(current.threadId);
      try {
        assertAuthorized?.();
        this.bindings.unbind(target, preference);
      } catch (error) {
        try {
          if (this.sameBinding(current, this.bindings.get(target))) {
            if (this.onSubscriptionRestoreRequired) this.onSubscriptionRestoreRequired(current);
            else await this.restoreUnsubscribedBinding(current);
          }
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], "解除绑定失败，且原订阅恢复失败", { cause: restoreError });
        }
        throw error;
      }
      onCommitted?.();
      this.unsubscribedBindings.delete(current.threadId);
      this.sessionDiagnosticsByThread.delete(current.threadId);
      this.notifyBindingsChanged();
    } else {
      this.bindings.setModelPreference(target, preference);
      onCommitted?.();
    }
  }

  private async restoreUnsubscribedBinding(
    expected: ConversationBinding,
    snapshot?: ThreadSnapshot,
    condition?: ThreadReleaseCondition,
    observeRestore = condition?.observeRestore,
  ): Promise<void> {
    const isCurrent = () => this.sameBinding(expected, this.bindings.get(expected.target))
      && (condition?.canRestore() ?? true);
    if (!isCurrent()) return;
    try {
      const workspace = this.workspaces.require(expected.workspaceId);
      const historical = snapshot ?? await this.codex.readThread(expected.threadId);
      if (!isCurrent()) return;
      const observation = observeRestore?.(expected.threadId);
      try {
        const resumed = await this.resumeInWorkspace(historical, workspace, {}, false, isCurrent);
        this.captureModelSettings(resumed.thread.id, resumed.model, resumed.modelProvider, resumed.reasoningEffort,
          resumed.serviceTier, resumed.collaborationMode, resumed.approvalsReviewer);
        this.namesByThread.set(resumed.thread.id, resumed.thread.name);
        this.captureSessionDiagnostics(resumed);
        observation?.restored(expected, resumed.thread);
      } finally {
        observation?.stop();
      }
    } catch (error) {
      if (isCurrent()) condition?.restoreRequired?.();
      throw error;
    }
  }

  private shouldForceNew(target: ConversationTarget): boolean {
    return this.forceNew.has(this.key(target))
      || this.bindings.idleState(target).forceNew;
  }

  /**
   * 自动接续的候选必须落在当前仍然可用的模型 Provider 上。
   * 操作员移除某个 Provider 后，其历史 Thread 属于永久不可用（与
   * `isUnavailableRestoreError` 的分类一致），不能被空闲候选选中，
   * 否则会话会一直卡在恢复失败上而无法新建 Thread。
   */
  private isProviderSelectable(provider: string): boolean {
    return this.codex.isProviderConfigured?.(provider) ?? true;
  }

  private sameBinding(expected: ConversationBinding, current: ConversationBinding | undefined): boolean {
    return current !== undefined && current.threadId === expected.threadId
      && current.sessionId === expected.sessionId && current.workspaceId === expected.workspaceId
      && this.key(current.target) === this.key(expected.target);
  }

  private notifyBindingsChanged(): void {
    for (const threadId of this.unsubscribedBindings) {
      if (!this.bindings.getByThread(threadId)) this.unsubscribedBindings.delete(threadId);
    }
    if (this.approvalResolutions.size > 0) {
      const currentBindings = new Map(this.bindings.list().map(binding => [binding.threadId, binding]));
      for (const resolution of this.approvalResolutions) {
        const changed = (id: string): void => {
          resolution.changedThreads.add(id);
          if (resolution.changedThreads.size > 1_024) {
            resolution.overflowed = true;
            resolution.changedThreads.clear();
            this.approvalResolutions.delete(resolution);
          }
        };
        for (const [id, binding] of resolution.bindings) {
          if (!this.sameBinding(binding, currentBindings.get(id))
            || this.workspaces.get(binding.workspaceId)?.cwd !== resolution.workspaceCwds.get(binding.workspaceId)) changed(id);
          if (resolution.overflowed) break;
        }
        if (resolution.overflowed) continue;
        for (const [id, binding] of currentBindings) {
          const original = resolution.bindings.get(id);
          if (!original || !this.sameBinding(original, binding)) changed(id);
          if (resolution.overflowed) break;
        }
      }
    }
    this.onBindingsChanged?.();
  }

  private assertLifecycleCurrent(target: ConversationTarget, expected: ConversationBinding | undefined): void {
    const current = this.bindings.get(target);
    if (expected ? !this.sameBinding(expected, current) : current !== undefined) {
      throw new UserFacingError("thread.takeover.changed", "等待期间会话绑定已变化，请重新选择");
    }
  }

  private lifecycleGuard(
    target: ConversationTarget,
    expected: ConversationBinding | undefined,
    assertAuthorized?: () => void,
  ): () => void {
    const workspaceId = this.selectedWorkspaceId(target);
    // A removed old selection may still be explicitly replaced. Preserve its
    // identity without requiring it to resolve to a registered Workspace.
    const cwd = this.workspaces.get(workspaceId)?.cwd;
    return () => {
      assertAuthorized?.();
      this.assertLifecycleCurrent(target, expected);
      if (this.selectedWorkspaceId(target) !== workspaceId || this.workspaces.get(workspaceId)?.cwd !== cwd) {
        throw new UserFacingError("thread.takeover.changed", "等待期间 Workspace 已变化，请重新选择");
      }
    };
  }

  private requireBackgroundCapacity(target: ConversationTarget, additional: number): void {
    if (additional > this.availableBackgroundCapacity(target)) {
      throw new UserFacingError(
        "conversation.background-limit",
        `后台任务已满，最多同时运行 ${maximumBackgroundThreadsPerConversation} 个`,
      );
    }
  }

  /** Reserve before asynchronous creation/switching; every background-producing path shares this budget. */
  private async withBackgroundCapacity<T>(target: ConversationTarget, additional: number, action: () => Promise<T>): Promise<T> {
    if (additional === 0) return action();
    this.requireBackgroundCapacity(target, additional);
    const key = this.key(target);
    this.backgroundReservations.set(key, (this.backgroundReservations.get(key) ?? 0) + additional);
    try {
      return await action();
    } finally {
      const remaining = (this.backgroundReservations.get(key) ?? 0) - additional;
      if (remaining === 0) this.backgroundReservations.delete(key);
      else this.backgroundReservations.set(key, remaining);
    }
  }

  private withThreadLifecycle<T>(threadIds: readonly string[], action: () => Promise<T>): Promise<T> {
    const ids = [...new Set(threadIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      const id = ids[index];
      if (id === undefined) return action();
      const previous = this.threadLifecycleQueues.get(id) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const queued = previous.then(() => held);
      this.threadLifecycleQueues.set(id, queued);
      await previous;
      try { return await acquire(index + 1); }
      finally {
        release();
        if (this.threadLifecycleQueues.get(id) === queued) this.threadLifecycleQueues.delete(id);
      }
    };
    return acquire(0);
  }

  private markForceNew(target: ConversationTarget, atMs: number): void {
    this.forceNew.add(this.key(target));
    this.bindings.setForceNew(target, atMs, true);
  }

  private clearForceNew(target: ConversationTarget, atMs: number): void {
    this.forceNew.delete(this.key(target));
    this.bindings.setForceNew(target, atMs, false);
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
    collaborationMode: ThreadModelSettings["collaborationMode"] = "default",
    approvalsReviewer: ThreadApprovalsReviewer | null = null,
  ): void {
    this.modelSettingsByThread.set(threadId, {
      model,
      modelProvider: modelProvider ?? "openai",
      effort,
      serviceTier: serviceTier ?? null,
      collaborationMode,
      approvalsReviewer,
    });
  }
}

function isIncompatibleRestoreError(error: unknown): boolean {
  return error instanceof UserFacingError && error.code === "thread.takeover.changed"
    || error instanceof AggregateError && error.errors.some(isIncompatibleRestoreError);
}

function isUnavailableRestoreError(error: Error): boolean {
  return (
    error instanceof UserFacingError
    && error.code === "workspace.missing"
  ) || /(?:thread|session).*(?:not found|deleted|(?:is )?archived)|线程.*(?:不存在|删除|归档)|模型 Provider 未配置独立 App Server/i
    .test(error.message);
}

function isActiveWriterRestoreError(error: Error): boolean {
  return /already has an active writer/u.test(error.message);
}
