import type { Logger } from "pino";

import type { ScheduledTaskConfirmation } from "../application/index.js";
import {
  surfaceAccountKey,
  type ConversationTarget,
  type OutputEvent,
  type TurnOutputTiming,
  type TurnTaskMetricsSummary,
} from "../conversation-core/index.js";
import type { EventBus } from "../event-bus/index.js";
import {
  resolveSurfaceDelivery,
  type SurfaceAdapter,
  type SurfaceConfigurationChange,
} from "../surfaces/index.js";

const defaultRetryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

/**
 * Turn 完成卡片需要指标写入落库后才读取聚合。共享输出路由只有一个消费者，
 * 因此整组读取必须有一次总预算，超时回退到当前可用值，避免一个慢指标库
 * 阻塞所有 Surface 与 Conversation 的输出路由。
 */
const completionEnrichmentTimeoutMs = 250;

interface SurfaceRuntime {
  state: "idle" | "starting" | "running" | "retrying";
  retryAttempt: number;
  retryTimer?: NodeJS.Timeout;
  pendingCriticalOutput: PendingOutputEntry[];
}

interface PendingOutputEntry {
  event: OutputEvent;
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
  private removeOutputSubscription: (() => void) | undefined;
  private acceptingOutput = true;
  private stopping = false;

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
    this.maximumPendingCriticalOutput = options.maximumPendingCriticalOutput
      ?? 100;
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
      });
    }
    this.removeOutputSubscription = output.subscribe(
      "surface-output-router",
      (event) => this.routeOutput(event),
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
      { err: error, surface: surface.surface, accountId: surface.accountId },
      "Surface 连接已中断，将独立重试",
    );
    this.scheduleRetry(surface);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.acceptingOutput = false;
    this.active.clear();
    this.removeOutputSubscription?.();
    this.removeOutputSubscription = undefined;
    for (const runtime of this.runtimeBySurface.values()) {
      if (runtime.retryTimer) {
        clearTimeout(runtime.retryTimer);
        delete runtime.retryTimer;
      }
      runtime.pendingCriticalOutput.length = 0;
    }
    for (const surface of this.surfaces) {
      this.setInteractionAvailable(surface, false, "Gateway 已停止");
    }
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

  private async routeOutput(event: OutputEvent): Promise<void> {
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
    let routedEvent = event;
    if (event.type === "turn.completed") {
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
      routedEvent = {
        ...event,
        gitBranch: this.currentGitBranch?.(event.target),
        ...(timing === undefined ? {} : { timing }),
        ...(taskAggregate === undefined ? {} : { taskAggregate }),
        ...(sessionAggregate === undefined ? {} : { sessionAggregate }),
      };
    }
    if (!this.active.has(surface)) {
      const runtime = this.requireRuntime(surface);
      const decision = resolveSurfaceDelivery(surface.surface, routedEvent);
      if (decision.disposition !== "ignore" && decision.critical) {
        this.bufferPendingOutput(surface, runtime, routedEvent, decision.coalesceKey);
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
    await this.deliverOutput(surface, routedEvent);
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
    coalesceKey: string | undefined,
  ): void {
    if (coalesceKey !== undefined) {
      const existing = runtime.pendingCriticalOutput.findIndex(
        (entry) => entry.coalesceKey === coalesceKey,
      );
      if (existing >= 0) {
        runtime.pendingCriticalOutput[existing] = { event, coalesceKey };
        return;
      }
    }
    if (runtime.pendingCriticalOutput.length >= this.maximumPendingCriticalOutput) {
      this.logger.error(
        {
          surface: surface.surface,
          accountId: surface.accountId,
          eventType: event.type,
          pending: runtime.pendingCriticalOutput.length,
        },
        "Surface 恢复队列达到告警阈值，关键输出继续保留",
      );
    }
    runtime.pendingCriticalOutput.push(
      coalesceKey === undefined ? { event } : { event, coalesceKey },
    );
  }

  private resolveCompletionMetrics<T>(
    event: Extract<OutputEvent, { type: "turn.completed" }>,
    scope: "turn" | "task" | "session",
    read: () => T | undefined | Promise<T | undefined>,
    deadlineAtMs: number,
    fallback?: T,
  ): T | undefined | Promise<T | undefined> {
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
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      return this.expireCompletionMetrics(event, scope, fallback);
    }
    return withDeadline(
      result.then((value) => value ?? fallback, recover),
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
    const pending = runtime.pendingCriticalOutput.splice(0);
    for (const entry of pending) {
      void this.deliverOutput(surface, entry.event);
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

  private async deliverOutput(
    surface: SurfaceAdapter,
    event: OutputEvent,
  ): Promise<void> {
    try {
      await surface.output.handle(event);
      if (event.type !== "text.delta") {
        this.logger.debug(
          {
            surface: surface.surface,
            accountId: surface.accountId,
            eventType: event.type,
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
          eventType: event.type,
        },
        "Surface 拒绝输出事件",
      );
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
