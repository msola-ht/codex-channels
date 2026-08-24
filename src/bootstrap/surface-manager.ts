import type { Logger } from "pino";

import type { ScheduledTaskConfirmation } from "../application/index.js";
import {
  isCriticalOutputEvent,
  surfaceAccountKey,
  type ConversationTarget,
  type OutputEvent,
  type ReferenceCostSummary,
  type TurnOutputTiming,
  type TurnTaskMetricsSummary,
} from "../conversation-core/index.js";
import type { EventBus } from "../event-bus/index.js";
import type {
  SurfaceAdapter,
  SurfaceConfigurationChange,
} from "../surfaces/index.js";

const defaultRetryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

interface SurfaceRuntime {
  state: "idle" | "starting" | "running" | "retrying";
  retryAttempt: number;
  retryTimer?: NodeJS.Timeout;
  pendingCriticalOutput: OutputEvent[];
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
  sessionReferenceCost?(
    threadId: string,
    turnId: string,
    current: ReferenceCostSummary | undefined,
  ): ReferenceCostSummary | undefined;
  completionTiming?(
    threadId: string,
    turnId: string,
    current: TurnOutputTiming | undefined,
  ): TurnOutputTiming | undefined | Promise<TurnOutputTiming | undefined>;
  taskAggregate?(
    threadId: string,
    turnId: string,
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
      const timingResult = this.options.completionTiming?.(
        event.threadId,
        event.turnId,
        event.timing,
      );
      const timing = timingResult instanceof Promise
        ? await timingResult ?? event.timing
        : timingResult ?? event.timing;
      const taskAggregateResult = this.options.taskAggregate?.(
        event.threadId,
        event.turnId,
      );
      const taskAggregate = taskAggregateResult instanceof Promise
        ? await taskAggregateResult
        : taskAggregateResult;
      const sessionReferenceCost = this.options.sessionReferenceCost?.(
        event.threadId,
        event.turnId,
        timing?.referenceCost,
      );
      routedEvent = {
        ...event,
        gitBranch: this.currentGitBranch?.(event.target),
        ...(timing === undefined ? {} : { timing }),
        ...(sessionReferenceCost === undefined ? {} : { sessionReferenceCost }),
        ...(taskAggregate === undefined ? {} : { taskAggregate }),
      };
    }
    if (!this.active.has(surface)) {
      const runtime = this.requireRuntime(surface);
      if (isCriticalOutputEvent(routedEvent)) {
        if (
          runtime.pendingCriticalOutput.length
          >= this.maximumPendingCriticalOutput
        ) {
          const dropped = runtime.pendingCriticalOutput.shift();
          this.logger.error(
            {
              surface: surface.surface,
              accountId: surface.accountId,
              droppedEventType: dropped?.type,
            },
            "Surface 恢复队列已满，最早的关键输出被丢弃",
          );
        }
        runtime.pendingCriticalOutput.push(routedEvent);
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
    for (const event of pending) {
      void this.deliverOutput(surface, event);
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
