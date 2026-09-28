import type { Logger } from "pino";

import type { ScheduledTaskConfirmation } from "../application/index.js";
import {
  surfaceAccountKey,
  type ConversationTarget,
  type CompletionAccountStatus,
  type OutputEvent,
  type TurnOutputTiming,
  type TurnTaskMetricsSummary,
} from "../conversation-core/index.js";
import type { EventBus } from "../event-bus/index.js";
import {
  ConversationDeliveryQueue,
  SurfaceOutputCoalescer,
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

/**
 * Turn 完成卡片需要指标写入落库后才读取聚合。整组读取共享一次总预算，
 * 超时回退到当前可用值；等待仅影响该 Conversation 的后续输出。
 */
const completionEnrichmentTimeoutMs = 250;

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

export interface SurfaceManagerOptions {
  retryDelaysMs?: readonly number[];
  maximumPendingCriticalOutput?: number;
  setInteractionAvailable?(
    surface: string,
    accountId: string,
    available: boolean,
    outcome?: string,
  ): void;
  completionAccountStatus?(provider: string, signal: AbortSignal): Promise<CompletionAccountStatus | undefined>;
  completionTiming?(
    threadId: string,
    turnId: string,
    current: TurnOutputTiming | undefined,
  ): TurnOutputTiming | undefined | Promise<TurnOutputTiming | undefined>;
  taskAggregate?(
    threadId: string,
    turnId: string,
  ): TurnTaskMetricsSummary | undefined | Promise<TurnTaskMetricsSummary | undefined>;
  sessionAggregate?(
    threadId: string,
  ): TurnTaskMetricsSummary | undefined | Promise<TurnTaskMetricsSummary | undefined>;
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
  private readonly accountQueriesAbort = new AbortController();
  private readonly outputCoalescer = new SurfaceOutputCoalescer();

  constructor(
    private readonly surfaces: readonly SurfaceAdapter[],
    output: EventBus<OutputEvent>,
    private readonly logger: Logger,
    private readonly currentGitBranch?: (
      target: OutputEvent["target"],
    ) => string | undefined,
    private readonly options: SurfaceManagerOptions = {},
  ) {
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
        delivery: new ConversationDeliveryQueue(logger, { component: "SurfaceRouting", logIntermediateStages: false }),
        shedBacklogCount: 0,
        nextShedBacklogReport: 1,
        nextPendingThresholdReport: this.maximumPendingCriticalOutput,
      });
    }
    this.removeOutputSubscription = output.subscribe(
      "surface-output-router",
      (event, _signal, eventBusWaitMs) => {
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
    if (this.stopping) {
      throw new Error("SurfaceManager 正在停止");
    }
    await Promise.all(this.surfaces.map((surface) => this.startSurface(surface)));
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

  async stop(): Promise<void> {
    this.stopping = true;
    this.accountQueriesAbort.abort();
    this.acceptingOutput = false;
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
        await surface.stop();
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
        shedCount: runtime.shedBacklogCount,
        pending: runtime.pendingCriticalOutput.length,
        shedPendingOutputAt: this.shedPendingOutputAt,
      },
      "Surface 恢复队列超过硬上限，已丢弃过程状态输出",
    );
  }

  private resolveCompletionMetrics<T>(
    event: Extract<OutputEvent, { type: "turn.completed" }>,
    scope: "turn" | "task" | "session",
    read: () => T | undefined | Promise<T | undefined>,
    deadlineAtMs: number,
    fallback?: T,
  ): T | undefined | Promise<T | undefined> {
    if (Date.now() >= deadlineAtMs) {
      return this.expireCompletionMetrics(event, scope, fallback);
    }
    const recover = (error: unknown): T | undefined => {
      this.logger.warn(
        {
          err: error,
          threadId: event.threadId,
          turnId: event.turnId,
          scope,
        },
        "Turn 完成统计读取失败",
      );
      return fallback;
    };
    let result: T | undefined | Promise<T | undefined>;
    try {
      result = read();
    } catch (error) {
      return recover(error);
    }
    if (!(result instanceof Promise)) {
      return result ?? fallback;
    }
    // read 的同步部分也可能耗尽预算；所有已启动查询必须先接住迟到的拒绝。
    const recovered = result.then((value) => value ?? fallback, recover);
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return this.expireCompletionMetrics(event, scope, fallback);
    }
    return withDeadline(
      recovered,
      remainingMs,
      () => this.expireCompletionMetrics(event, scope, fallback),
    );
  }

  private expireCompletionMetrics<T>(
    event: Extract<OutputEvent, { type: "turn.completed" }>,
    scope: "turn" | "task" | "session",
    fallback: T | undefined,
  ): T | undefined {
    this.logger.warn(
      {
        threadId: event.threadId,
        turnId: event.turnId,
        scope,
        timeoutMs: completionEnrichmentTimeoutMs,
      },
      "Turn 完成统计读取超时，使用当前可用值",
    );
    return fallback;
  }

  private async startSurface(surface: SurfaceAdapter): Promise<void> {
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
    if (this.stopping) {
      return;
    }
    runtime.state = "running";
    runtime.retryAttempt = 0;
    this.setInteractionAvailable(surface, true);
    this.active.add(surface);
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
    let routedEvent: OutputEvent;
    try {
      routedEvent = await this.enrichCompletionOutput(event);
    } catch (error) {
      // 完成卡不能因为统计读取失败而缺席，也不能在恢复重放里变成未处理的拒绝；
      // 退化为未富化输出，并保留可观测性。
      this.logger.warn(
        {
          err: error,
          surface: surface.surface,
          accountId: surface.accountId,
          eventType: event.type,
        },
        "Turn 完成统计富化失败，改用未富化输出",
      );
      routedEvent = event;
    }
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

  /**
   * Turn 完成卡片需要指标写入落库后才读取聚合，整组读取共享一次总预算。
   *
   * 富化放在投递前而不是入队前：渠道不可用期间不读取指标库，被恢复缓冲裁掉的过程事件
   * 也不会触发读取，真正投递时再按当时已经落库的结果生成卡片。
   */
  private async enrichCompletionOutput(event: OutputEvent): Promise<OutputEvent> {
    if (event.type !== "turn.completed") {
      return event;
    }
    const accountStatusResult = this.readCompletionAccountStatus(event);
    const enrichmentDeadline = Date.now() + completionEnrichmentTimeoutMs;
    const timingResult = this.resolveCompletionMetrics(
      event,
      "turn",
      () => this.options.completionTiming?.(
        event.threadId,
        event.turnId,
        event.timing,
      ),
      enrichmentDeadline,
      event.timing,
    );
    const timing = timingResult instanceof Promise
      ? await timingResult
      : timingResult;
    const taskAggregateResult = this.resolveCompletionMetrics(
      event,
      "task",
      () => this.options.taskAggregate?.(event.threadId, event.turnId),
      enrichmentDeadline,
    );
    const taskAggregate = taskAggregateResult instanceof Promise
      ? await taskAggregateResult
      : taskAggregateResult;
    const sessionAggregateResult = this.resolveCompletionMetrics(
      event,
      "session",
      () => this.options.sessionAggregate?.(event.threadId),
      enrichmentDeadline,
    );
    const sessionAggregate = sessionAggregateResult instanceof Promise
      ? await sessionAggregateResult
      : sessionAggregateResult;
    const accountStatus = await accountStatusResult;
    return {
      ...event,
      ...(accountStatus === undefined ? {} : { accountStatus }),
      gitBranch: this.currentGitBranch?.(event.target),
      ...(timing === undefined ? {} : { timing }),
      ...(taskAggregate === undefined ? {} : { taskAggregate }),
      ...(sessionAggregate === undefined ? {} : { sessionAggregate }),
    };
  }

  private async readCompletionAccountStatus(
    event: Extract<OutputEvent, { type: "turn.completed" }>,
  ): Promise<CompletionAccountStatus | undefined> {
    const provider = event.modelProvider;
    if (!provider || provider === "openai" || !this.options.completionAccountStatus || this.stopping) return undefined;
    const deadline = new AbortController();
    const signal = AbortSignal.any([deadline.signal, this.accountQueriesAbort.signal]);
    try {
      const query = this.options.completionAccountStatus(provider, signal);
      const result = await withDeadline(query, 2_000, () => {
        deadline.abort();
        this.logger.warn({ provider }, "完成卡账户查询超时，省略账户状态");
        return undefined;
      });
      return !signal.aborted && result?.provider === provider ? result : undefined;
    } catch {
      this.logger.warn({ provider }, "完成卡账户查询失败，省略账户状态");
      return undefined;
    } finally {
      deadline.abort();
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

async function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
