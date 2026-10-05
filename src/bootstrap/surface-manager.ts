import type { Logger } from "pino";
import { CompletionOutputEnricher, type CompletionOutputEnricherOptions } from "./completion-output-enricher.js";
import { PersistentSurfaceOutput, type PersistentSurfaceOutputOptions } from "./persistent-surface-output.js";

import type { ScheduledTaskConfirmation } from "../application/index.js";
import {
  surfaceAccountKey,
  type ConversationTarget,
  type OutputEvent,
} from "../conversation-core/index.js";
import type { EventBus } from "../event-bus/index.js";
import {
  ConversationDeliveryQueue,
  SurfaceOutputCoalescer,
  surfaceOutputSnapshotKey,
  supersedesSurfaceSnapshot,
  isPersistentOutput,
  isSheddableBacklogEvent,
  resolveSurfaceDelivery,
  surfaceErrorMetadata,
  type SurfaceAdapter,
  type SurfaceConfigurationChange,
} from "../surfaces/index.js";

const defaultRetryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

/**
 * pino 的错误序列化只保留受控类型与大写错误码，渠道错误码多是小写 kebab，会整条丢失。
 * 这里显式展开最多四层 cause 的白名单元数据：既能定位失败原因，也不会写入错误正文。
 */
function surfaceErrorChain(error: unknown, maximumDepth = 4): string[] {
  const chain: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < maximumDepth; depth += 1) {
    if (current === undefined || current === null) {
      break;
    }
    const metadata = surfaceErrorMetadata(current);
    chain.push(
      metadata.errorCode === undefined
        ? metadata.errorType
        : `${metadata.errorType}:${String(metadata.errorCode)}`,
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

interface SurfaceRuntime {
  state: "idle" | "starting" | "running" | "retrying";
  retryAttempt: number;
  retryTimer?: NodeJS.Timeout;
  pendingCriticalOutput: PendingOutputEntry[];
  nextOutputOrder: number;
  /** 富化与恢复重放按 Conversation 有界排队，彼此独立。 */
  delivery: ConversationDeliveryQueue;
  shedBacklogCount: number;
  nextShedBacklogReport: number;
  nextPendingThresholdReport: number;
}

interface PendingOutputEntry {
  event: OutputEvent;
  order: number;
  /** 可合并中间状态在故障期只保留同键的最新一份。 */
  coalesceKey?: string;
}

interface PendingSnapshot {
  event: OutputEvent;
  owner: string;
  bytes: number;
  queued: boolean;
  revision: number;
  order: number;
  controller: AbortController;
  active?: { event: OutputEvent; bytes: number; revision: number; controller: AbortController };
}

export interface SurfaceManagerOptions extends CompletionOutputEnricherOptions {
  persistence?: Pick<PersistentSurfaceOutputOptions, "directory" | "owner" | "authorized" | "fault" | "workerUrl">;
  retryDelaysMs?: readonly number[];
  maximumPendingCriticalOutput?: number;
  setInteractionAvailable?(
    surface: string,
    accountId: string,
    available: boolean,
    outcome?: string,
  ): void;
}

export class SurfaceManager {
  private readonly attempted = new Set<SurfaceAdapter>();
  private readonly active = new Set<SurfaceAdapter>();
  private readonly surfacesByAccount = new Map<string, SurfaceAdapter>();
  private readonly runtimeBySurface = new Map<SurfaceAdapter, SurfaceRuntime>();
  private readonly retryDelaysMs: readonly number[];
  private readonly maximumPendingCriticalOutput: number;
  private readonly shedPendingOutputAt: number;
  private removeOutputSubscription: (() => void) | undefined;
  private acceptingOutput = true;
  private stopping = false;
  private readonly completionEnricher: CompletionOutputEnricher;
  private readonly outputCoalescer = new SurfaceOutputCoalescer();
  private readonly persistent: PersistentSurfaceOutput | undefined;
  private persistenceStart: Promise<void> | undefined;
  private removePersistenceObserver: (() => void) | undefined;
  private readonly suspended = new Set<string>();
  private readonly surfaceStops = new Map<SurfaceAdapter, Promise<void>>();
  private readonly snapshots = new Map<string, PendingSnapshot>();
  private snapshotBytes = 0;
  private readonly snapshotOwners = new Set<PendingSnapshot>();

  constructor(
    private readonly surfaces: readonly SurfaceAdapter[],
    output: EventBus<OutputEvent>,
    private readonly logger: Logger,
    currentGitBranch?: (
      target: OutputEvent["target"],
      signal: AbortSignal,
    ) => Promise<string | undefined>,
    private readonly options: SurfaceManagerOptions = {},
  ) {
    this.completionEnricher = new CompletionOutputEnricher(logger, currentGitBranch, options);
    this.retryDelaysMs = options.retryDelaysMs?.length
      ? options.retryDelaysMs
      : defaultRetryDelaysMs;
    this.maximumPendingCriticalOutput = Math.max(
      1,
      options.maximumPendingCriticalOutput ?? 100,
    );
    this.shedPendingOutputAt = this.maximumPendingCriticalOutput * 10;
    for (const surface of surfaces) {
      const key = surfaceAccountKey(surface.surface, surface.accountId);
      if (this.surfacesByAccount.has(key)) {
        throw new Error(`Surface 重复注册：${key}`);
      }
      this.surfacesByAccount.set(key, surface);
      this.runtimeBySurface.set(surface, {
        state: "idle",
        retryAttempt: 0,
        pendingCriticalOutput: [],
        nextOutputOrder: 0,
        delivery: new ConversationDeliveryQueue(logger, {
          component: "SurfaceRouting", logIntermediateStages: false,
          maximumPendingOperations: 512,
          onOverload: () => this.suspendPersistentAccount(key),
        }),
        shedBacklogCount: 0,
        nextShedBacklogReport: 1,
        nextPendingThresholdReport: this.maximumPendingCriticalOutput,
      });
    }
    this.persistent = options.persistence ? new PersistentSurfaceOutput({
      ...options.persistence,
      changed: () => {
        if (this.stopping) return;
        for (const [key, snapshot] of this.snapshots) {
          const surface = this.surfacesByAccount.get(surfaceAccountKey(snapshot.event.target.surface, snapshot.event.target.accountId));
          if (surface) this.scheduleSnapshot(surface, key, snapshot);
        }
      },
      accounts: () => [...this.active].map((surface) => surfaceAccountKey(surface.surface, surface.accountId)),
      deliver: async (event, signal, checkpoint, authorized, liveOrder) => {
        const surface = this.surfacesByAccount.get(surfaceAccountKey(event.target.surface, event.target.accountId));
        if (!surface || !this.active.has(surface) || !surface.output.deliver) throw new Error("可靠投递端口不可用");
        const enriched = await this.enrichSafely(event, signal);
        signal.throwIfAborted();
        if (!this.acceptingOutput) throw new Error("可靠投递已停止");
        if (!authorized()) throw new Error("可靠投递授权已变化");
        if (liveOrder !== undefined) {
          // Coordinator has settled every preceding durable record in this Conversation.
          // Admit earlier live input now, without letting it bypass recovered/uncertain results.
          for (const [key, snapshot] of this.snapshots) {
            if (snapshot.event.type === "user.message" && snapshot.order < liveOrder
              && snapshot.event.target.surface === event.target.surface
              && snapshot.event.target.accountId === event.target.accountId
              && snapshot.event.target.conversationId === event.target.conversationId) {
              this.scheduleSnapshot(surface, key, snapshot, true);
            }
          }
        }
        await this.requireRuntime(surface).delivery.runOrdered(event.target.conversationId, async (active) => {
          if (!this.acceptingOutput) throw new Error("可靠投递已停止");
          if (!authorized()) throw new Error("可靠投递授权已变化");
          await surface.output.deliver!(enriched, active, checkpoint);
        }, signal);
      },
    }) : undefined;
    if (this.persistent) this.removePersistenceObserver = output.observe((event) => {
      if (!this.acceptingOutput) return;
      const key = surfaceAccountKey(event.target.surface, event.target.accountId);
      const surface = this.surfacesByAccount.get(key);
      if (!surface || this.suspended.has(key)) return;
      const order = this.requireRuntime(surface).nextOutputOrder++;
      try { surface.output.observe?.(event); }
      catch { this.options.persistence?.fault("surface-state-failed", key); return; }
      for (const [snapshotKey, snapshot] of this.snapshots) {
        if (supersedesSurfaceSnapshot(event, snapshot.event)) this.removeSnapshot(snapshotKey, snapshot);
      }
      if (isPersistentOutput(event)) {
        if (surface.output.retains?.(event) ?? true) this.persistent!.accept(event, order);
      } else if (resolveSurfaceDelivery(event.target.surface, event).disposition !== "ignore") {
        const snapshotKey = surfaceOutputSnapshotKey(event);
        if (snapshotKey !== undefined) this.retainSnapshot(surface, snapshotKey, event, order);
      }
    });
    this.removeOutputSubscription = output.subscribe(
      "surface-output-router",
      (event, _signal, eventBusWaitMs) => {
        if (this.persistent) {
          if (isPersistentOutput(event) || surfaceOutputSnapshotKey(event) !== undefined) return;
          const surface = this.surfacesByAccount.get(surfaceAccountKey(event.target.surface, event.target.accountId));
          if (surface && (!this.active.has(surface) || this.persistent.hasOutstanding(event))) {
            // Intermediate output is not a second restart/recovery backlog.
            // Only streaming deltas remain here. The complete Item is retained separately.
            return;
          }
        }
        const started = performance.now();
        const fields = {
          surface: event.target.surface, accountId: event.target.accountId,
          conversationId: event.target.conversationId, eventType: event.type,
          ...("threadId" in event ? { threadId: event.threadId } : {}),
          ...("turnId" in event ? { turnId: event.turnId } : {}),
          ...("itemId" in event ? { itemId: event.itemId } : {}),
          stage: "routing", eventBusWaitMs,
        };
        try {
          this.routeOutput(event);
        } finally {
          const routingMs = Math.max(0, Math.round(performance.now() - started));
          if (eventBusWaitMs + routingMs >= 5_000) {
            this.logger.warn({ ...fields, routingMs }, "Surface 共享输出路由耗时较长");
          } else if (event.type === "text.completed" || event.type === "turn.completed") {
            this.logger.info({ ...fields, routingMs }, "Surface 终态输出路由入队完成");
          }
        }
      },
    );
  }

  async start(): Promise<void> {
    await this.preparePersistence();
    if (this.stopping) {
      throw new Error("SurfaceManager 正在停止");
    }
    await Promise.all(this.surfaces.map((surface) => this.startSurface(surface)));
  }

  preparePersistence(): Promise<void> {
    this.persistenceStart ??= this.persistent?.start() ?? Promise.resolve();
    return this.persistenceStart;
  }

  acceptsExecution(target: ConversationTarget): boolean {
    return this.executionBlockReason(target) === undefined;
  }

  executionBlockReason(target: ConversationTarget): "unavailable" | "global-capacity" | "account-capacity" | undefined {
    const account = surfaceAccountKey(target.surface, target.accountId);
    if (this.stopping || this.suspended.has(account)) return "unavailable";
    return this.persistent?.executionBlockReason(target);
  }

  waitForPersistentOutput(target: ConversationTarget, signal: AbortSignal): Promise<void> {
    return this.persistent?.waitForIdle(target, signal) ?? Promise.resolve();
  }

  suspendPersistentAccount(account: string): void {
    if (this.suspended.has(account)) return;
    this.suspended.add(account);
    const surface = this.surfacesByAccount.get(account);
    if (!surface) return;
    this.active.delete(surface);
    for (const [key, snapshot] of this.snapshots) {
      if (surfaceAccountKey(snapshot.event.target.surface, snapshot.event.target.accountId) === account) {
        this.removeSnapshot(key, snapshot);
      }
    }
    this.setInteractionAvailable(surface, false, "可靠投递存储不可接收新结果，请检查本地状态");
    const runtime = this.requireRuntime(surface);
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    void this.stopSurface(surface).catch(() => this.logger.error({ account }, "超载渠道停止失败"));
  }

  private stopSurface(surface: SurfaceAdapter): Promise<void> {
    const pending = this.surfaceStops.get(surface);
    if (pending) return pending;
    const task = Promise.resolve().then(() => surface.stop());
    this.surfaceStops.set(surface, task);
    const clear = (): void => { if (this.surfaceStops.get(surface) === task) this.surfaceStops.delete(surface); };
    void task.then(clear, clear);
    return task;
  }

  async sendChannelImage(
    target: ConversationTarget,
    imagePath: string,
  ): Promise<void> {
    if (this.stopping) {
      throw new Error("Gateway 正在停止，无法发送渠道图片");
    }
    const surface = this.surfacesByAccount.get(
      surfaceAccountKey(target.surface, target.accountId),
    );
    if (surface === undefined) {
      throw new Error(
        `未找到渠道账号：${surfaceAccountKey(target.surface, target.accountId)}`,
      );
    }
    if (surface.sendChannelImage === undefined) {
      throw new Error(`${target.surface} 渠道不支持发送图片`);
    }
    return surface.sendChannelImage(target.conversationId, imagePath);
  }

  presentScheduledTaskConfirmation(
    target: ConversationTarget,
    actorId: string,
    preview: ScheduledTaskConfirmation,
  ): boolean {
    const surface = this.surfacesByAccount.get(
      surfaceAccountKey(target.surface, target.accountId),
    );
    if (surface?.presentScheduledTaskConfirmation === undefined) {
      return false;
    }
    void Promise.resolve(
      surface.presentScheduledTaskConfirmation(target, actorId, preview),
    ).catch((error: unknown) => {
      this.logger.warn(
        {
          err: error,
          surface: target.surface,
          accountId: target.accountId,
          conversationId: target.conversationId,
        },
        "计划任务确认界面发送失败",
      );
    });
    return true;
  }

  reportFatal(surfaceId: string, accountId: string, error: Error): void {
    if (this.stopping) {
      return;
    }
    const surface = this.surfacesByAccount.get(
      surfaceAccountKey(surfaceId, accountId),
    );
    if (!surface) {
      this.logger.error(
        { err: error, surface: surfaceId, accountId },
        "未注册的 Surface 报告连接故障",
      );
      return;
    }
    const runtime = this.requireRuntime(surface);
    if (runtime.state === "retrying") {
      return;
    }
    this.active.delete(surface);
    runtime.state = "retrying";
    runtime.retryAttempt = 0;
    this.setInteractionAvailable(
      surface,
      false,
      "渠道连接已中断，请恢复后重试",
    );
    this.logger.error(
      {
        err: error,
        surface: surface.surface,
        accountId: surface.accountId,
        errorChain: surfaceErrorChain(error),
      },
      "Surface 连接已中断，将独立重试",
    );
    this.scheduleRetry(surface);
  }

  /** Fence new execution/interaction while accepted notifications still enter the journal. */
  beginShutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.completionEnricher.beginShutdown();
    for (const surface of this.surfaces) {
      this.setInteractionAvailable(surface, false, "Gateway 正在停止");
    }
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    this.completionEnricher.stop();
    this.acceptingOutput = false;
    this.removePersistenceObserver?.();
    for (const [key, snapshot] of this.snapshots) this.removeSnapshot(key, snapshot);
    let persistenceError: unknown;
    try { await this.persistent?.close(); }
    catch (error) { persistenceError = error; }
    this.outputCoalescer.clear();
    this.removeOutputSubscription?.();
    this.removeOutputSubscription = undefined;
    for (const runtime of this.runtimeBySurface.values()) {
      if (runtime.retryTimer) {
        clearTimeout(runtime.retryTimer);
        delete runtime.retryTimer;
      }
      runtime.pendingCriticalOutput.length = 0;
      runtime.shedBacklogCount = 0;
      runtime.nextShedBacklogReport = 1;
      runtime.nextPendingThresholdReport = this.maximumPendingCriticalOutput;
    }
    for (const surface of this.surfaces) {
      this.setInteractionAvailable(surface, false, "Gateway 已停止");
    }
    await Promise.all([...this.runtimeBySurface.values()].map((runtime) => runtime.delivery.close()));
    this.active.clear();
    const failures: Array<{ surface: SurfaceAdapter; error: unknown }> = [];
    const attempted = [...this.attempted];
    this.attempted.clear();
    for (const surface of attempted.reverse()) {
      try {
        await this.stopSurface(surface);
      } catch (error) {
        failures.push({ surface, error });
        this.logger.error(
          {
            err: error,
            surface: surface.surface,
            accountId: surface.accountId,
          },
          "Surface 停止失败",
        );
      }
    }
    if (failures.length > 0) {
      for (const { surface } of failures.reverse()) {
        this.attempted.add(surface);
      }
      throw new AggregateError(
        failures.map(({ error }) => error),
        "部分 Surface 未能停止",
      );
    }
    if (persistenceError) throw new AggregateError([persistenceError], "持久输出关闭失败");
  }

  configurationChanged(change: SurfaceConfigurationChange): void {
    for (const surface of this.surfaces) {
      if (!this.active.has(surface)) {
        continue;
      }
      const scopedChange = configurationChangeForSurface(surface, change);
      if (!scopedChange) {
        continue;
      }
      try {
        surface.configurationChanged?.(scopedChange);
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            surface: surface.surface,
            accountId: surface.accountId,
          },
          "Surface 配置变更通知失败",
        );
      }
    }
  }

  async deliverConfigurationChange(change: SurfaceConfigurationChange): Promise<void> {
    if (this.active.size !== this.surfaces.length) {
      throw new Error("部分 Surface 当前不可用，不能确认持久化配置事件");
    }
    const surfaces = [...this.surfaces];
    const results = await Promise.allSettled(
      surfaces.map(async (surface) => {
        const scopedChange = configurationChangeForSurface(surface, change);
        if (scopedChange) {
          await surface.deliverConfigurationChange(scopedChange);
        }
        return surface;
      }),
    );
    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") {
        return [];
      }
      const surface = surfaces[index]!;
      this.logger.warn(
        {
          errorType: result.reason instanceof Error ? result.reason.name : typeof result.reason,
          surface: surface.surface,
          accountId: surface.accountId,
        },
        "Surface 持久化配置事件投递失败",
      );
      return [result.reason as unknown];
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, "部分 Surface 未收到配置事件");
    }
  }

  private routeOutput(event: OutputEvent): void {
    if (!this.acceptingOutput) {
      return;
    }
    const surface = this.surfacesByAccount.get(
      surfaceAccountKey(event.target.surface, event.target.accountId),
    );
    if (!surface) {
      this.logger.debug(
        {
          surface: event.target.surface,
          accountId: event.target.accountId,
          eventType: event.type,
        },
        "输出事件没有已启用的 Surface",
      );
      return;
    }
    const runtime = this.requireRuntime(surface);
    const order = runtime.nextOutputOrder++;
    if (!this.active.has(surface)) {
      const decision = resolveSurfaceDelivery(surface.surface, event);
      if (decision.disposition !== "ignore" && decision.critical) {
        this.bufferPendingOutput(surface, runtime, event, order, decision.coalesceKey);
      } else {
        this.logger.debug(
          {
            surface: surface.surface,
            accountId: surface.accountId,
            eventType: event.type,
          },
          "Surface 不可用，输出事件未投递",
        );
      }
      return;
    }
    this.deliverOutput(surface, event, order);
  }

  /**
   * 渠道不可用时暂存必须保留的输出。可合并的中间状态（例如每秒刷新的思考状态）
   * 按策略合并键保留最新一份，避免长时间断线时内存按秒增长；审批、错误和
   * 完成事件仍然全部保留，超过阈值只告警不静默丢弃。被渠道策略忽略的事件（例如
   * 微信的推理状态）不进入缓冲。
   */
  private bufferPendingOutput(
    surface: SurfaceAdapter,
    runtime: SurfaceRuntime,
    event: OutputEvent,
    order: number,
    coalesceKey: string | undefined,
  ): void {
    if (coalesceKey !== undefined) {
      const existing = runtime.pendingCriticalOutput.findIndex(
        (entry) => entry.coalesceKey === coalesceKey,
      );
      if (existing >= 0) {
        const previous = runtime.pendingCriticalOutput[existing]!;
        if (previous.order < order) {
          runtime.pendingCriticalOutput.splice(existing, 1);
        } else {
          return;
        }
      }
    }
    if (this.shedBacklogOutput(surface, runtime, event)) {
      return;
    }
    const pending = runtime.pendingCriticalOutput.length;
    if (pending >= runtime.nextPendingThresholdReport) {
      // 与队列溢出告警一致：首次越过阈值和之后数量翻倍时各记录一次，避免断线期间刷屏。
      const threshold = runtime.nextPendingThresholdReport;
      runtime.nextPendingThresholdReport = pending * 2;
      this.logger.error(
        {
          surface: surface.surface,
          accountId: surface.accountId,
          eventType: event.type,
          pending,
          threshold,
        },
        "Surface 恢复队列达到告警阈值，关键输出继续保留",
      );
    }
    runtime.pendingCriticalOutput.push(
      coalesceKey === undefined ? { event, order } : { event, order, coalesceKey },
    );
    // 在途事件可能比故障期间的新事件更晚回到缓冲。
    if (pending > 0 && runtime.pendingCriticalOutput[pending - 1]!.order > order) {
      runtime.pendingCriticalOutput.sort((left, right) => left.order - right.order);
    }
  }

  /**
   * 恢复缓冲的减载阈值。只丢弃过程、状态与生命周期输出，结果与错误始终保留，
   * 因此长时间断线只会让过程通知缺席，不会丢掉最终回答或完成统计。
   * 返回 true 表示当前事件本身被丢弃。
   */
  private shedBacklogOutput(
    surface: SurfaceAdapter,
    runtime: SurfaceRuntime,
    incoming: OutputEvent,
  ): boolean {
    if (runtime.pendingCriticalOutput.length < this.shedPendingOutputAt) {
      return false;
    }
    const index = runtime.pendingCriticalOutput.findIndex(
      (entry) => isSheddableBacklogEvent(entry.event),
    );
    if (index >= 0) {
      const [shed] = runtime.pendingCriticalOutput.splice(index, 1);
      this.reportShedBacklogOutput(surface, runtime, shed?.event, incoming);
      return false;
    }
    if (!isSheddableBacklogEvent(incoming)) {
      return false;
    }
    this.reportShedBacklogOutput(surface, runtime, incoming, incoming);
    return true;
  }

  private reportShedBacklogOutput(
    surface: SurfaceAdapter,
    runtime: SurfaceRuntime,
    shed: OutputEvent | undefined,
    incoming: OutputEvent,
  ): void {
    runtime.shedBacklogCount += 1;
    // 与队列溢出告警一致：只在首次和数量翻倍时记录，避免长时间断线刷屏。
    if (runtime.shedBacklogCount < runtime.nextShedBacklogReport) {
      return;
    }
    runtime.nextShedBacklogReport = runtime.shedBacklogCount * 2;
    this.logger.warn(
      {
        surface: surface.surface,
        accountId: surface.accountId,
        shedEventType: shed?.type,
        incomingEventType: incoming.type,
        conversationId: incoming.target.conversationId,
        ...("threadId" in incoming ? { threadId: incoming.threadId } : {}),
        ...("turnId" in incoming ? { turnId: incoming.turnId } : {}),
        shedCount: runtime.shedBacklogCount,
        pending: runtime.pendingCriticalOutput.length,
        shedPendingOutputAt: this.shedPendingOutputAt,
      },
      "Surface 恢复缓冲已减载过程状态输出",
    );
  }

  private async startSurface(surface: SurfaceAdapter): Promise<void> {
    if (this.suspended.has(surfaceAccountKey(surface.surface, surface.accountId))) return;
    if (this.stopping) {
      return;
    }
    const runtime = this.requireRuntime(surface);
    if (runtime.state === "starting" || runtime.state === "running") {
      return;
    }
    if (runtime.retryTimer) {
      clearTimeout(runtime.retryTimer);
      delete runtime.retryTimer;
    }
    runtime.state = "starting";
    this.attempted.add(surface);
    try {
      if (!await runtime.delivery.waitForIdle()) {
        throw new Error("Surface 旧投递队列尚未排空，延后恢复");
      }
      if (this.stopping) return;
      await surface.start();
    } catch (error) {
      if (this.stopping) {
        return;
      }
      runtime.state = "retrying";
      this.logger.warn(
        {
          err: error,
          surface: surface.surface,
          accountId: surface.accountId,
          retryAttempt: runtime.retryAttempt + 1,
          errorChain: surfaceErrorChain(error),
        },
        "Surface 启动失败，将独立重试",
      );
      this.scheduleRetry(surface);
      return;
    }
    if (this.stopping || this.suspended.has(surfaceAccountKey(surface.surface, surface.accountId))) {
      await this.stopSurface(surface);
      return;
    }
    runtime.state = "running";
    runtime.retryAttempt = 0;
    this.setInteractionAvailable(surface, true);
    this.active.add(surface);
    this.persistent?.wake();
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.event.target.surface === surface.surface && snapshot.event.target.accountId === surface.accountId) {
        this.scheduleSnapshot(surface, key, snapshot);
      }
    }
    runtime.shedBacklogCount = 0;
    runtime.nextShedBacklogReport = 1;
    runtime.nextPendingThresholdReport = this.maximumPendingCriticalOutput;
    const pending = runtime.pendingCriticalOutput.splice(0);
    for (const entry of pending) {
      this.deliverOutput(surface, entry.event, entry.order);
    }
    this.logger.info(
      {
        surface: surface.surface,
        accountId: surface.accountId,
        recoveredOutputEvents: pending.length,
      },
      "Surface 已就绪",
    );
  }

  private releaseSnapshot(snapshot: PendingSnapshot): void {
    if (!this.snapshotOwners.delete(snapshot)) return;
    this.snapshotBytes -= snapshot.bytes;
    snapshot.bytes = 0;
  }

  private removeSnapshot(key: string, snapshot: PendingSnapshot): void {
    if (this.snapshots.get(key) !== snapshot) return;
    this.snapshots.delete(key);
    snapshot.controller.abort();
    // Queued closures and in-flight sends still own their memory until settlement.
    if (!snapshot.queued) this.releaseSnapshot(snapshot);
  }

  private retainSnapshot(surface: SurfaceAdapter, key: string, event: OutputEvent, order: number): void {
    const previous = this.snapshots.get(key);
    const account = surfaceAccountKey(surface.surface, surface.accountId);
    let owner: string;
    try { owner = this.options.persistence!.owner(event); }
    catch { this.options.persistence?.fault("authorization-changed", account); return; }
    const bytes = Buffer.byteLength(JSON.stringify(event)) + Buffer.byteLength(owner);
    const replaceableBytes = previous && previous.revision !== previous.active?.revision ? previous.bytes : 0;
    if ((!previous && this.snapshotOwners.size >= 512) || this.snapshotBytes - replaceableBytes + bytes > 8 * 1024 * 1024) {
      this.options.persistence?.fault("mailbox-full", account);
      return;
    }
    const snapshot = previous ?? { event, owner, bytes: 0, queued: false, revision: 0, order, controller: new AbortController() };
    this.snapshotBytes += bytes - replaceableBytes;
    Object.assign(snapshot, { event, owner, bytes, revision: snapshot.revision + 1 });
    this.snapshotOwners.add(snapshot);
    this.snapshots.set(key, snapshot);
    this.scheduleSnapshot(surface, key, snapshot);
  }

  private scheduleSnapshot(surface: SurfaceAdapter, key: string, snapshot: PendingSnapshot, precedesCurrentResult = false): void {
    if (this.stopping || snapshot.queued || !this.active.has(surface)
      || (!precedesCurrentResult && this.persistent?.hasOutstanding(snapshot.event))) return;
    snapshot.queued = true;
    let active: PendingSnapshot["active"];
    const accepted = this.requireRuntime(surface).delivery.enqueue(snapshot.event.target.conversationId, async (signal) => {
      try {
        if (this.snapshots.get(key) !== snapshot || !this.active.has(surface)) return;
        const { event, owner, bytes, revision } = snapshot;
        const authorized = (): boolean => this.options.persistence!.authorized(event, owner);
        if (!authorized()) {
          this.logger.warn({ surface: surface.surface, accountId: surface.accountId,
            conversationId: event.target.conversationId, eventType: event.type }, "Surface 最新状态归属已变化，取消展示");
          this.removeSnapshot(key, snapshot);
          return;
        }
        active = { event, bytes, revision, controller: snapshot.controller };
        snapshot.active = active;
        if (!surface.output.deliverSnapshot) throw new Error("Surface 缺少状态投递结算端口");
        await surface.output.deliverSnapshot(event, AbortSignal.any([signal, active.controller.signal]), authorized);
      } catch {
        if (!active?.controller.signal.aborted) {
          this.logger.warn({ surface: surface.surface, accountId: surface.accountId,
            conversationId: snapshot.event.target.conversationId, eventType: active?.event.type ?? snapshot.event.type },
          "Surface 状态投递未确认；不自动重试本次状态，后续更新可继续展示");
        }
      }
    }, true, { signal: snapshot.controller.signal, settled: () => {
        if (active && active.revision !== snapshot.revision) this.snapshotBytes -= active.bytes;
        delete snapshot.active;
        snapshot.queued = false;
        if (this.snapshots.get(key) !== snapshot) this.releaseSnapshot(snapshot);
        else if (active?.revision === snapshot.revision) this.removeSnapshot(key, snapshot);
        else if (active) this.scheduleSnapshot(surface, key, snapshot);
      },
    });
    if (!accepted) {
      snapshot.queued = false;
      this.removeSnapshot(key, snapshot);
    }
  }

  private scheduleRetry(surface: SurfaceAdapter): void {
    const runtime = this.requireRuntime(surface);
    if (this.stopping || runtime.retryTimer) {
      return;
    }
    const delayIndex = Math.min(
      runtime.retryAttempt,
      this.retryDelaysMs.length - 1,
    );
    const delayMs = this.retryDelaysMs[delayIndex]!;
    runtime.retryAttempt += 1;
    runtime.retryTimer = setTimeout(() => {
      delete runtime.retryTimer;
      void this.startSurface(surface);
    }, delayMs);
    runtime.retryTimer.unref();
  }

  /** 恢复重放与实时输出共用同一 Conversation 队列，富化不阻塞共享路由。 */
  private deliverOutput(
    surface: SurfaceAdapter,
    event: OutputEvent,
    order: number,
  ): void {
    const decision = resolveSurfaceDelivery(surface.surface, event);
    if (decision.disposition === "ignore") return;
    const runtime = this.requireRuntime(surface);
    const enqueuedAt = performance.now();
    const coalesceKey = this.outputCoalescer.key(event);
    runtime.delivery.enqueue(event.target.conversationId, async () => {
      const started = performance.now();
      if (!this.active.has(surface)) {
        if (!this.stopping && decision.critical) {
          this.bufferPendingOutput(surface, runtime, event, order, decision.coalesceKey);
        }
        return;
      }
      await this.deliverOne(surface, event, order);
      const fields = {
        surface: surface.surface, accountId: surface.accountId,
        conversationId: event.target.conversationId, eventType: event.type,
        ...("threadId" in event ? { threadId: event.threadId } : {}),
        ...("turnId" in event ? { turnId: event.turnId } : {}),
        stage: "enrichment",
        queueWaitMs: Math.max(0, Math.round(started - enqueuedAt)),
        executionMs: Math.max(0, Math.round(performance.now() - started)),
      };
      if (fields.queueWaitMs + fields.executionMs >= 5_000) {
        this.logger.warn(fields, "Surface 会话输出准备耗时较长");
      } else if (event.type === "turn.completed") {
        this.logger.info(fields, "Surface 完成统计准备结束");
      }
    }, decision.critical, coalesceKey === undefined ? undefined : { coalesceKey });
  }

  private async deliverOne(
    surface: SurfaceAdapter,
    event: OutputEvent,
    order: number,
  ): Promise<void> {
    const routedEvent = await this.enrichSafely(event);
    if (!this.acceptingOutput) return;
    if (!this.active.has(surface)) {
      if (!this.stopping) {
        const decision = resolveSurfaceDelivery(surface.surface, event);
        if (decision.critical) this.bufferPendingOutput(surface, this.requireRuntime(surface), event, order, decision.coalesceKey);
      }
      return;
    }
    try {
      await surface.output.handle(routedEvent);
      if (routedEvent.type !== "text.delta") {
        this.logger.debug(
          {
            surface: surface.surface,
            accountId: surface.accountId,
            eventType: routedEvent.type,
          },
          "输出事件已提交到 Surface 队列",
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          surface: surface.surface,
          accountId: surface.accountId,
          eventType: routedEvent.type,
        },
        "Surface 拒绝输出事件",
      );
    }
  }

  private async enrichSafely(event: OutputEvent, signal?: AbortSignal): Promise<OutputEvent> {
    try {
      return await this.completionEnricher.enrich(event, signal);
    } catch (error) {
      // 完成卡不能因为统计读取失败而缺席，也不能在恢复重放里变成未处理的拒绝；
      // 退化为未富化输出，并保留可观测性。
      this.logger.warn(
        {
          errorChain: surfaceErrorChain(error),
          surface: event.target.surface,
          accountId: event.target.accountId,
          eventType: event.type,
        },
        "Turn 完成统计富化失败，改用未富化输出",
      );
      return event;
    }
  }

  private requireRuntime(surface: SurfaceAdapter): SurfaceRuntime {
    const runtime = this.runtimeBySurface.get(surface);
    if (!runtime) {
      throw new Error(`Surface 运行状态不存在：${surface.surface}`);
    }
    return runtime;
  }

  private setInteractionAvailable(
    surface: SurfaceAdapter,
    available: boolean,
    outcome?: string,
  ): void {
    try {
      this.options.setInteractionAvailable?.(
        surface.surface,
        surface.accountId,
        available,
        outcome,
      );
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          surface: surface.surface,
          accountId: surface.accountId,
          available,
        },
        "Surface 交互可用状态更新失败",
      );
    }
  }
}

function configurationChangeForSurface(
  surface: SurfaceAdapter,
  change: SurfaceConfigurationChange,
): SurfaceConfigurationChange | undefined {
  const changes = change.changes.filter(
    (item) => item.scope === "global" || item.scope === surface.surface,
  );
  if (
    changes.length === 0
    && change.addedWorkspaces.length === 0
    && change.action === "reloaded"
  ) {
    return undefined;
  }
  return {
    ...change,
    changes,
  };
}
