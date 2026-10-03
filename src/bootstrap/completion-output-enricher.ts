import type { Logger } from "pino";
import type {
  CompletionAccountStatus,
  OutputEvent,
  TurnOutputTiming,
  TurnTaskMetricsSummary,
} from "../conversation-core/index.js";

/**
 * Turn 完成卡片需要指标写入落库后才读取聚合。整组读取共享一次总预算，
 * 超时回退到当前可用值；等待仅影响该 Conversation 的后续输出。
 */
const completionEnrichmentTimeoutMs = 250;

export interface CompletionOutputEnricherOptions {
  executionTiming?(threadId: string, turnId: string): {
    durationMs: number | null;
    sessionDurationMs: number | null;
    sessionTiming?: Extract<OutputEvent, { type: "turn.completed" }>["sessionTiming"];
  };
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

/** 投递前的完成信息补全；队列、授权复核与投递失败处理由调用方负责。 */
export class CompletionOutputEnricher {
  private stopping = false;
  private readonly accountQueriesAbort = new AbortController();

  constructor(
    private readonly logger: Logger,
    private readonly currentGitBranch: ((target: OutputEvent["target"]) => string | undefined) | undefined,
    private readonly options: CompletionOutputEnricherOptions,
  ) {}

  /** 禁止新账户查询，保留已在途查询直到 stop。 */
  beginShutdown(): void {
    this.stopping = true;
  }

  stop(): void {
    this.beginShutdown();
    this.accountQueriesAbort.abort();
  }

  /**
   * Turn 完成卡片需要指标写入落库后才读取聚合，整组读取共享一次总预算。
   *
   * 富化放在投递前而不是入队前：渠道不可用期间不读取指标库，被恢复缓冲裁掉的过程事件
   * 也不会触发读取，真正投递时再按当时已经落库的结果生成卡片。
   */
  async enrich(event: OutputEvent): Promise<OutputEvent> {
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
    let execution: ReturnType<NonNullable<CompletionOutputEnricherOptions["executionTiming"]>> | undefined;
    try {
      execution = this.options.executionTiming?.(event.threadId, event.turnId);
    } catch {
      this.logger.warn({ threadId: event.threadId, turnId: event.turnId }, "完成卡轮次耗时读取失败");
    }
    return {
      ...event,
      ...(accountStatus === undefined ? {} : { accountStatus }),
      gitBranch: this.currentGitBranch?.(event.target),
      ...(timing === undefined ? {} : { timing }),
      ...(taskAggregate === undefined ? {} : { taskAggregate }),
      ...(sessionAggregate === undefined ? {} : { sessionAggregate }),
      ...(execution?.durationMs == null ? {} : { durationMs: execution.durationMs }),
      sessionDurationMs: execution?.sessionDurationMs ?? undefined,
      sessionTiming: execution?.sessionTiming,
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
