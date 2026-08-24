import { randomUUID } from "node:crypto";

import {
  UserFacingError,
  conversationTargetKey,
  type ConversationTarget,
} from "../conversation-core/index.js";
import {
  calculateNextRunAt,
  normalizeSchedule,
  ScheduledTaskStateError,
  validateIanaTimeZone,
  type Schedule,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskSandbox,
  type ScheduledTaskStore,
} from "../scheduled-tasks/index.js";
import {
  parseNaturalScheduledTaskDraft,
  scheduledTaskCommandUsageText,
  splitModelMarker,
} from "./scheduled-task-command.js";

const taskPageSize = 8;
const runPageSize = 10;
const snapshotLifetimeMs = 5 * 60_000;
const confirmationLifetimeMs = 5 * 60_000;
const maximumSnapshots = 256;
const maximumConfirmations = 500;
const maximumTasksPerActorConversation = 100;
const maximumPromptCharacters = 20_000;
const maximumTaskNameCharacters = 80;

export interface ScheduledTaskCreationContext {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly cwd: string;
  readonly modelProvider: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly sandbox: ScheduledTaskSandbox;
  readonly approvalPolicy: "never";
  readonly permissions: string | null;
  readonly modelPending: boolean;
  readonly effortPending: boolean;
  readonly serviceTierPending: boolean;
}

export interface ScheduledTaskApplicationPort {
  isActorAuthorized(target: ConversationTarget, actorId: string): boolean;
  creationContext(target: ConversationTarget): ScheduledTaskCreationContext;
  runTaskNow(taskId: string): Promise<ScheduledRun>;
  /** Synchronous fail-closed check used when a Provider is explicitly requested. */
  isProviderConfigured(provider: string): boolean;
}

export interface ScheduledTaskCreateRequest {
  readonly schedule: Schedule;
  readonly timezone: string;
  readonly prompt: string;
  /** Optional explicit model ID or a provider/model composite; defaults to the current session. */
  readonly model?: string;
}

export interface ScheduledTaskView {
  readonly taskId: string;
  readonly name: string;
  readonly status: ScheduledTask["status"];
  readonly schedule: Schedule;
  readonly timezone: string;
  readonly nextRunAt: number | null;
  readonly workspaceId: string;
  readonly modelProvider: string;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly serviceTier: string | null;
  readonly sandbox: ScheduledTaskSandbox;
  readonly permissions: string | null;
  readonly promptPreview: string;
}

export interface ScheduledTaskListResult {
  readonly tasks: readonly ScheduledTaskView[];
  readonly selectors: readonly string[];
  readonly page: number;
  readonly pageCount: number;
  readonly totalTaskCount: number;
}

export interface ScheduledRunView extends ScheduledRun {
  readonly selector: string;
}

export interface ScheduledTaskRunListResult {
  readonly task: ScheduledTaskView;
  readonly runs: readonly ScheduledRunView[];
  readonly page: number;
  readonly pageCount: number;
  readonly totalRunCount: number;
}

export interface ScheduledTaskCreatePreview {
  readonly action: "create";
  readonly token: string;
  readonly expiresAt: number;
  readonly task: ScheduledTaskView;
}

export interface ScheduledTaskDeletePreview {
  readonly action: "delete";
  readonly token: string;
  readonly expiresAt: number;
  readonly task: ScheduledTaskView;
}

export type ScheduledTaskConfirmation =
  | ScheduledTaskCreatePreview
  | ScheduledTaskDeletePreview;

interface PendingCreate {
  readonly kind: "create";
  readonly token: string;
  readonly target: ConversationTarget;
  readonly actorId: string;
  readonly expiresAt: number;
  readonly input: Parameters<ScheduledTaskStore["createTask"]>[0];
  /** True when the caller explicitly chose a model independent of the snapshot. */
  readonly modelExplicit: boolean;
}

interface PendingDelete {
  readonly kind: "delete";
  readonly token: string;
  readonly target: ConversationTarget;
  readonly actorId: string;
  readonly expiresAt: number;
  readonly taskId: string;
}

type PendingConfirmation = PendingCreate | PendingDelete;

interface SelectionSnapshot {
  readonly capturedAt: number;
  readonly ids: readonly string[];
}

export interface ScheduledTaskUseCases {
  previewNaturalLanguage(
    target: ConversationTarget,
    actorId: string,
    description: string,
  ): ScheduledTaskCreatePreview;
  previewCreate(
    target: ConversationTarget,
    actorId: string,
    request: ScheduledTaskCreateRequest,
  ): ScheduledTaskCreatePreview;
  confirm(
    target: ConversationTarget,
    actorId: string,
    token: string,
  ): { action: "created" | "deleted"; task: ScheduledTaskView };
  list(target: ConversationTarget, actorId: string, page?: number): ScheduledTaskListResult;
  runs(
    target: ConversationTarget,
    actorId: string,
    selector: string,
    page?: number,
  ): ScheduledTaskRunListResult;
  rename(target: ConversationTarget, actorId: string, selector: string, name: string): ScheduledTaskView;
  pause(target: ConversationTarget, actorId: string, selector: string): ScheduledTaskView;
  resume(target: ConversationTarget, actorId: string, selector: string): ScheduledTaskView;
  run(target: ConversationTarget, actorId: string, selector: string): Promise<ScheduledRun>;
  retry(target: ConversationTarget, actorId: string, selector: string): Promise<ScheduledRun>;
  previewDelete(
    target: ConversationTarget,
    actorId: string,
    selector: string,
  ): ScheduledTaskDeletePreview;
}

export class ScheduledTaskApplicationService implements ScheduledTaskUseCases {
  private readonly taskSnapshots = new Map<string, SelectionSnapshot>();
  private readonly runSnapshots = new Map<string, SelectionSnapshot>();
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly confirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: ScheduledTaskStore,
    private readonly application: ScheduledTaskApplicationPort,
    private readonly now: () => number = Date.now,
  ) {}

  previewNaturalLanguage(
    target: ConversationTarget,
    actorId: string,
    description: string,
  ): ScheduledTaskCreatePreview {
    this.requireActor(target, actorId);
    this.requireTaskCapacity(target, actorId);
    const normalizedDescription = normalizeDraftDescription(description);
    const { rest, model } = splitModelMarker(normalizedDescription);
    const deterministic = parseNaturalScheduledTaskDraft(rest, this.now());
    if (deterministic) {
      return this.previewCreate(
        target,
        actorId,
        model === undefined ? deterministic : { ...deterministic, model },
      );
    }
    throw scheduledError(
      "scheduled-task.command.invalid",
      scheduledTaskCommandUsageText,
    );
  }

  previewCreate(
    target: ConversationTarget,
    actorId: string,
    request: ScheduledTaskCreateRequest,
  ): ScheduledTaskCreatePreview {
    this.requireActor(target, actorId);
    this.requireTaskCapacity(target, actorId);
    const now = this.now();
    const prompt = normalizePrompt(request.prompt);
    const timezone = validateIanaTimeZone(request.timezone);
    const schedule = normalizeSchedule(request.schedule);
    const context = this.requireCreationContext(target);
    const modelSelection = resolveCreationModel(request.model, context, this.application);
    const previewNextRunAt = calculateNextRunAt(schedule, timezone, now);
    if (previewNextRunAt === null) {
      throw scheduledError("scheduled-task.command.invalid", "一次性计划时间已过去，请选择未来时间");
    }
    const input = {
      name: defaultTaskName(prompt),
      surface: target.surface,
      accountId: target.accountId,
      conversationId: target.conversationId,
      actorId,
      workspaceId: context.workspaceId,
      prompt,
      schedule,
      timezone,
      modelProvider: modelSelection.modelProvider,
      model: modelSelection.model,
      reasoningEffort: context.reasoningEffort,
      serviceTier: context.serviceTier,
      sandbox: context.sandbox,
      approvalPolicy: context.approvalPolicy,
      permissions: context.permissions,
      createdAt: now,
    } satisfies Parameters<ScheduledTaskStore["createTask"]>[0];
    const token = randomUUID();
    const expiresAt = now + confirmationLifetimeMs;
    this.rememberConfirmation({
      kind: "create",
      token,
      target,
      actorId,
      expiresAt,
      input,
      modelExplicit: request.model !== undefined && request.model.trim() !== "",
    });
    return {
      action: "create",
      token,
      expiresAt,
      task: toTaskView({
        ...input,
        taskId: "pending",
        status: "active",
        updatedAt: now,
        nextRunAt: previewNextRunAt,
        permission: {
          sandbox: context.sandbox,
          approvalPolicy: "never",
          permissions: context.permissions,
        },
      }),
    };
  }

  private requireCreationContext(target: ConversationTarget): ScheduledTaskCreationContext {
    const context = this.application.creationContext(target);
    if (context.modelPending || context.effortPending || context.serviceTierPending) {
      throw scheduledError("scheduled-task.state.invalid", "模型设置仍在等待生效，请稍后重试");
    }
    return context;
  }

  confirm(
    target: ConversationTarget,
    actorId: string,
    token: string,
  ): { action: "created" | "deleted"; task: ScheduledTaskView } {
    this.requireActor(target, actorId);
    const confirmation = this.consumeConfirmation(target, actorId, token);
    if (confirmation.kind === "create") {
      this.requireTaskCapacity(target, actorId);
      const current = this.application.creationContext(target);
      if (
        current.workspaceId !== confirmation.input.workspaceId
        || (!confirmation.modelExplicit
          && (current.modelProvider !== confirmation.input.modelProvider
            || current.model !== confirmation.input.model))
        || current.reasoningEffort !== confirmation.input.reasoningEffort
        || current.serviceTier !== confirmation.input.serviceTier
        || current.sandbox !== confirmation.input.sandbox
        || current.permissions !== confirmation.input.permissions
      ) {
        throw scheduledError("scheduled-task.confirmation.invalid", "计划任务创建上下文已变化，请重新预览");
      }
      const task = this.mutateTask(() => this.store.createTask(confirmation.input));
      this.invalidateTarget(target, actorId);
      return { action: "created", task: toTaskView(task) };
    }
    const task = this.requireOwnedTask(target, actorId, confirmation.taskId);
    const deleted = this.mutateTask(() => this.store.deleteTask(task.taskId, this.now()));
    this.invalidateTarget(target, actorId);
    return { action: "deleted", task: toTaskView(deleted, task) };
  }

  list(target: ConversationTarget, actorId: string, page = 1): ScheduledTaskListResult {
    this.requireActor(target, actorId);
    const tasks = this.store.listTasks({ conversation: target })
      .filter((task) => task.actorId === actorId);
    const pageCount = Math.max(1, Math.ceil(tasks.length / taskPageSize));
    requirePage(page, pageCount);
    const offset = (page - 1) * taskPageSize;
    const visible = tasks.slice(offset, offset + taskPageSize);
    this.rememberSnapshot(this.taskSnapshots, snapshotKey(target, actorId), tasks.map((task) => task.taskId));
    return {
      tasks: visible.map((task) => toTaskView(task)),
      selectors: visible.map((_task, index) => String(offset + index + 1)),
      page,
      pageCount,
      totalTaskCount: tasks.length,
    };
  }

  runs(
    target: ConversationTarget,
    actorId: string,
    selector: string,
    page = 1,
  ): ScheduledTaskRunListResult {
    const task = this.resolveTask(target, actorId, selector);
    const runs = this.store.listRuns(task.taskId, { limit: 1_000 });
    const pageCount = Math.max(1, Math.ceil(runs.length / runPageSize));
    requirePage(page, pageCount);
    const offset = (page - 1) * runPageSize;
    const visible = runs.slice(offset, offset + runPageSize);
    this.rememberSnapshot(
      this.runSnapshots,
      snapshotKey(target, actorId),
      runs.map((run) => run.runId),
    );
    return {
      task: toTaskView(task),
      runs: visible.map((run, index) => ({ ...run, selector: String(offset + index + 1) })),
      page,
      pageCount,
      totalRunCount: runs.length,
    };
  }

  rename(
    target: ConversationTarget,
    actorId: string,
    selector: string,
    name: string,
  ): ScheduledTaskView {
    const task = this.resolveTask(target, actorId, selector);
    const updated = this.mutateTask(() =>
      this.store.renameTask(task.taskId, normalizeName(name), this.now())
    );
    return toTaskView(updated);
  }

  pause(target: ConversationTarget, actorId: string, selector: string): ScheduledTaskView {
    const task = this.resolveTask(target, actorId, selector);
    const updated = this.mutateTask(() => this.store.pauseTask(task.taskId, this.now()));
    return toTaskView(updated);
  }

  resume(target: ConversationTarget, actorId: string, selector: string): ScheduledTaskView {
    const task = this.resolveTask(target, actorId, selector);
    const updated = this.mutateTask(() => this.store.resumeTask(task.taskId, this.now()));
    return toTaskView(updated);
  }

  async run(
    target: ConversationTarget,
    actorId: string,
    selector: string,
  ): Promise<ScheduledRun> {
    const task = this.resolveTask(target, actorId, selector);
    if (task.status === "blocked") {
      throw scheduledError("scheduled-task.state.invalid", "阻塞的计划任务不能立即运行");
    }
    return await this.mutateTaskAsync(async () => await this.application.runTaskNow(task.taskId));
  }

  async retry(
    target: ConversationTarget,
    actorId: string,
    selector: string,
  ): Promise<ScheduledRun> {
    const run = this.resolveRun(target, actorId, selector);
    const task = this.requireOwnedTask(target, actorId, run.taskId);
    if (run.state !== "uncertain") {
      throw scheduledError("scheduled-task.state.invalid", "只有 uncertain Run 可以显式解除后重试");
    }
    this.mutateTask(() => this.store.resolveUncertain(run.runId, "failed", this.now()));
    this.invalidateTarget(target, actorId);
    return await this.mutateTaskAsync(async () => await this.application.runTaskNow(task.taskId));
  }

  previewDelete(
    target: ConversationTarget,
    actorId: string,
    selector: string,
  ): ScheduledTaskDeletePreview {
    const task = this.resolveTask(target, actorId, selector);
    const token = randomUUID();
    const expiresAt = this.now() + confirmationLifetimeMs;
    this.rememberConfirmation({
      kind: "delete",
      token,
      target,
      actorId,
      expiresAt,
      taskId: task.taskId,
    });
    return { action: "delete", token, expiresAt, task: toTaskView(task) };
  }

  private requireActor(target: ConversationTarget, actorId: string): void {
    if (!actorId || !this.application.isActorAuthorized(target, actorId)) {
      throw scheduledError("scheduled-task.forbidden", "当前用户无权管理该会话的计划任务");
    }
  }

  private resolveTask(
    target: ConversationTarget,
    actorId: string,
    selector: string,
  ): ScheduledTask {
    this.requireActor(target, actorId);
    const normalized = selector.trim();
    if (!normalized) throw scheduledError("scheduled-task.command.invalid", "需要提供任务 ID 或列表序号");
    if (/^[1-9]\d*$/u.test(normalized)) {
      const snapshot = this.taskSnapshots.get(snapshotKey(target, actorId));
      if (!snapshot || this.now() - snapshot.capturedAt > snapshotLifetimeMs) {
        throw scheduledError("scheduled-task.snapshot.required", "请先使用 /schedule list 获取最新任务列表");
      }
      const taskId = snapshot.ids[Number(normalized) - 1];
      if (!taskId) throw scheduledError("scheduled-task.not-found", "计划任务列表序号不存在");
      return this.requireOwnedTask(target, actorId, taskId);
    }
    return this.requireOwnedTask(target, actorId, normalized);
  }

  private resolveRun(
    target: ConversationTarget,
    actorId: string,
    selector: string,
  ): ScheduledRun {
    this.requireActor(target, actorId);
    const normalized = selector.trim();
    if (!normalized) throw scheduledError("scheduled-task.command.invalid", "需要提供 Run ID");
    if (/^[1-9]\d*$/u.test(normalized)) {
      const snapshot = this.runSnapshots.get(snapshotKey(target, actorId));
      if (!snapshot || this.now() - snapshot.capturedAt > snapshotLifetimeMs) {
        throw scheduledError("scheduled-task.snapshot.required", "请先使用 /schedule runs <任务> 获取最新 Run 列表");
      }
      const runId = snapshot.ids[Number(normalized) - 1];
      if (!runId) throw scheduledError("scheduled-task.not-found", "Run 列表序号不存在");
      const run = this.store.getRun(runId);
      if (!run) throw scheduledError("scheduled-task.not-found", "找不到指定 Run");
      this.requireOwnedTask(target, actorId, run.taskId);
      return run;
    }
    const run = this.store.getRun(normalized);
    if (!run) throw scheduledError("scheduled-task.not-found", "找不到指定 Run");
    this.requireOwnedTask(target, actorId, run.taskId);
    return run;
  }

  private requireOwnedTask(
    target: ConversationTarget,
    actorId: string,
    taskId: string,
  ): ScheduledTask {
    const task = this.store.getTask(taskId);
    if (
      !task
      || task.status === "deleted"
      || task.surface !== target.surface
      || task.accountId !== target.accountId
      || task.conversationId !== target.conversationId
      || task.actorId !== actorId
    ) {
      throw scheduledError("scheduled-task.not-found", "找不到指定计划任务");
    }
    return task;
  }

  private consumeConfirmation(
    target: ConversationTarget,
    actorId: string,
    token: string,
  ): PendingConfirmation {
    this.pruneExpiredConfirmations();
    const confirmation = this.confirmations.get(token);
    if (
      !confirmation
      || confirmation.expiresAt < this.now()
      || conversationTargetKey(confirmation.target) !== conversationTargetKey(target)
      || confirmation.actorId !== actorId
    ) {
      throw scheduledError("scheduled-task.confirmation.invalid", "计划任务确认令牌无效、已过期或已使用");
    }
    this.forgetConfirmation(token);
    return confirmation;
  }

  private rememberConfirmation(confirmation: PendingConfirmation): void {
    this.pruneExpiredConfirmations();
    this.confirmations.set(confirmation.token, confirmation);
    const timer = setTimeout(() => {
      this.forgetConfirmation(confirmation.token);
    }, Math.max(0, confirmation.expiresAt - this.now() + 1));
    timer.unref();
    this.confirmationTimers.set(confirmation.token, timer);
    while (this.confirmations.size > maximumConfirmations) {
      const oldest = this.confirmations.keys().next().value;
      if (oldest === undefined) break;
      this.forgetConfirmation(oldest);
    }
  }

  private pruneExpiredConfirmations(): void {
    const now = this.now();
    for (const [token, confirmation] of this.confirmations) {
      if (confirmation.expiresAt < now) this.forgetConfirmation(token);
    }
  }

  private forgetConfirmation(token: string): void {
    this.confirmations.delete(token);
    const timer = this.confirmationTimers.get(token);
    if (timer) clearTimeout(timer);
    this.confirmationTimers.delete(token);
  }

  private requireTaskCapacity(target: ConversationTarget, actorId: string): void {
    const taskCount = this.store.listTasks({ conversation: target })
      .filter((task) => task.actorId === actorId)
      .length;
    if (taskCount >= maximumTasksPerActorConversation) {
      throw scheduledError(
        "scheduled-task.state.invalid",
        `每个用户在同一会话最多创建 ${maximumTasksPerActorConversation} 个计划任务，请先删除不再使用的任务`,
      );
    }
  }

  private mutateTask<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof ScheduledTaskStateError) {
        throw scheduledError("scheduled-task.state.invalid", error.message);
      }
      throw error;
    }
  }

  private async mutateTaskAsync(operation: () => Promise<ScheduledRun>): Promise<ScheduledRun> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ScheduledTaskStateError) {
        throw scheduledError("scheduled-task.state.invalid", error.message);
      }
      throw error;
    }
  }

  private rememberSnapshot(
    snapshots: Map<string, SelectionSnapshot>,
    key: string,
    ids: readonly string[],
  ): void {
    snapshots.delete(key);
    snapshots.set(key, { capturedAt: this.now(), ids });
    trimMap(snapshots, maximumSnapshots);
  }

  private invalidateTarget(target: ConversationTarget, actorId: string): void {
    const key = snapshotKey(target, actorId);
    this.taskSnapshots.delete(key);
    this.runSnapshots.delete(key);
  }
}

function toTaskView(task: ScheduledTask, deletedSource?: ScheduledTask): ScheduledTaskView {
  const source = deletedSource ?? task;
  if (!source.schedule || !source.timezone || !source.permission) {
    throw new Error("计划任务持久字段不完整");
  }
  return {
    taskId: task.taskId,
    name: source.name,
    status: task.status,
    schedule: source.schedule,
    timezone: source.timezone,
    nextRunAt: task.nextRunAt,
    workspaceId: source.workspaceId,
    modelProvider: source.modelProvider ?? "openai",
    model: source.model,
    reasoningEffort: source.reasoningEffort,
    serviceTier: source.serviceTier,
    sandbox: source.permission.sandbox,
    permissions: source.permission.permissions,
    promptPreview: boundedPreview(source.prompt),
  };
}

function normalizePrompt(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw scheduledError("scheduled-task.command.invalid", "计划任务文本不能为空");
  if ([...normalized].length > maximumPromptCharacters) {
    throw scheduledError("scheduled-task.command.invalid", `计划任务文本不能超过 ${maximumPromptCharacters} 个字符`);
  }
  return normalized;
}

function normalizeDraftDescription(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw scheduledError("scheduled-task.command.invalid", "计划任务描述不能为空");
  if ([...normalized].length > maximumPromptCharacters) {
    throw scheduledError("scheduled-task.command.invalid", `计划任务描述不能超过 ${maximumPromptCharacters} 个字符`);
  }
  return normalized;
}

function normalizeName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) throw scheduledError("scheduled-task.command.invalid", "计划任务名称不能为空");
  if ([...normalized].length > maximumTaskNameCharacters) {
    throw scheduledError("scheduled-task.command.invalid", `计划任务名称不能超过 ${maximumTaskNameCharacters} 个字符`);
  }
  return normalized;
}

function resolveCreationModel(
  selector: string | undefined,
  context: ScheduledTaskCreationContext,
  application: ScheduledTaskApplicationPort,
): { model: string; modelProvider: string } {
  if (selector === undefined || selector.trim() === "") {
    return { model: context.model, modelProvider: context.modelProvider };
  }
  const normalized = selector.trim();
  const separator = normalized.indexOf("/");
  const model = separator >= 0 ? normalized.slice(separator + 1).trim() : normalized;
  const provider = separator >= 0
    ? normalized.slice(0, separator).trim()
    : context.modelProvider;
  if (!model) {
    throw scheduledError("scheduled-task.command.invalid", "计划任务模型不能为空");
  }
  if (!provider) {
    throw scheduledError("scheduled-task.command.invalid", "计划任务模型 Provider 不能为空");
  }
  if (!application.isProviderConfigured(provider)) {
    throw scheduledError(
      "scheduled-task.command.invalid",
      `所选模型 Provider 未配置：${provider}`,
    );
  }
  return { model, modelProvider: provider };
}

function defaultTaskName(prompt: string): string {
  return [...(prompt.split(/\r?\n/u, 1)[0] ?? prompt).trim().replace(/\s+/gu, " ")]
    .slice(0, 40)
    .join("");
}

function boundedPreview(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length <= 120 ? normalized : `${characters.slice(0, 119).join("")}…`;
}

function snapshotKey(target: ConversationTarget, actorId: string): string {
  return `${conversationTargetKey(target)}:${actorId}`;
}

function requirePage(page: number, pageCount: number): void {
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
    throw scheduledError("scheduled-task.command.invalid", "计划任务页码超出范围");
  }
}

function trimMap<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function scheduledError(
  code:
    | "scheduled-task.command.invalid"
    | "scheduled-task.confirmation.invalid"
    | "scheduled-task.forbidden"
    | "scheduled-task.not-found"
    | "scheduled-task.snapshot.required"
    | "scheduled-task.state.invalid",
  message: string,
): UserFacingError {
  return new UserFacingError(code, message);
}
