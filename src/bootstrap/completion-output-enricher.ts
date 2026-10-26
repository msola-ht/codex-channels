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

type CompletedEvent = Extract<OutputEvent, { type: "turn.completed" }>;
type ExecutionTimingResult = {
  value?: Awaited<ReturnType<NonNullable<CompletionOutputEnricherOptions["executionTiming"]>>>;
  status?: CompletedEvent["executionTimingStatus"];
};

export interface CompletionOutputEnricherOptions {
  autoApprovalReview?(threadId: string, turnId: string, signal: AbortSignal): Promise<Extract<OutputEvent, { type: "turn.completed" }>["autoApprovalReview"]>;
  sessionAutoApprovalReview?(threadId: string, signal: AbortSignal): Promise<Extract<OutputEvent, { type: "turn.completed" }>["sessionAutoApprovalReview"]>;
  subagentMetadata?(agentThreadId: string, signal: AbortSignal): Promise<{
    id: string;
    parentThreadId?: string | null;
    sessionId?: string | null;
    modelProvider?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
  }>;
  executionTiming?(threadId: string, turnId: string, signal: AbortSignal): Promise<{
    durationMs: number | null;
    sessionDurationMs: number | null;
    sessionTiming?: Extract<OutputEvent, { type: "turn.completed" }>["sessionTiming"];
  }>;
  completionAccountStatus?(provider: string, signal: AbortSignal): Promise<CompletionAccountStatus | undefined>;
  completionTiming?(
    threadId: string,
    turnId: string,
    current: TurnOutputTiming | undefined,
    signal: AbortSignal,
  ): TurnOutputTiming | undefined | Promise<TurnOutputTiming | undefined>;
  taskAggregate?(
    threadId: string,
    turnId: string,
    signal: AbortSignal,
  ): TurnTaskMetricsSummary | undefined | Promise<TurnTaskMetricsSummary | undefined>;
  sessionAggregate?(
    threadId: string,
    signal: AbortSignal,
  ): TurnTaskMetricsSummary | undefined | Promise<TurnTaskMetricsSummary | undefined>;
}

/** 投递前的完成与子代理信息补全；队列、授权复核与投递失败处理由调用方负责。 */
export class CompletionOutputEnricher {
  private stopping = false;
  private readonly queriesAbort = new AbortController();

  constructor(
    private readonly logger: Logger,
    private readonly currentGitBranch: ((target: OutputEvent["target"], signal: AbortSignal, workspaceId?: string) => Promise<string | undefined>) | undefined,
    private readonly options: CompletionOutputEnricherOptions,
  ) {}

  /** 禁止新查询，保留已在途查询直到 stop。 */
  beginShutdown(): void {
    this.stopping = true;
  }

  stop(): void {
    this.beginShutdown();
    this.queriesAbort.abort();
  }

  /**
   * Turn 完成卡片需要指标写入落库后才读取聚合，整组读取共享一次总预算。
   *
   * 富化放在投递前而不是入队前：渠道不可用期间不读取指标库，被恢复缓冲裁掉的过程事件
   * 也不会触发读取，真正投递时再按当时已经落库的结果生成卡片。
   */
  async enrich(event: OutputEvent, callerSignal?: AbortSignal): Promise<OutputEvent> {
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.queriesAbort.signal]) : this.queriesAbort.signal;
    if (event.type === "subagent.spawned" || event.type === "subagent.contacted") {
      return this.readSubagentMetadata(event, signal);
    }
    if (event.type === "turn.started") {
      const gitBranch = await this.readGitBranch(event, Date.now() + completionEnrichmentTimeoutMs, signal);
      return { ...event, ...(gitBranch ? { gitBranch } : {}) };
    }
    if (event.type !== "turn.completed") {
      return event;
    }
    const accountStatusResult = this.readCompletionAccountStatus(event, signal);
    const enrichmentDeadline = Date.now() + completionEnrichmentTimeoutMs;
    const metricsSignal = AbortSignal.any([signal, AbortSignal.timeout(completionEnrichmentTimeoutMs)]);
    // 耗时先进入 Worker；其余独立读取各自保留入库屏障，共享同一次总预算。
    const executionResult = this.readExecutionTiming(event, enrichmentDeadline, metricsSignal);
    const gitBranchResult = this.readGitBranch(event, enrichmentDeadline, signal);
    const timingResult = this.resolveCompletionMetrics(
      event,
      "turn",
      () => this.options.completionTiming?.(
        event.threadId,
        event.turnId,
        event.timing,
        metricsSignal,
      ),
      enrichmentDeadline,
      event.timing,
    );
    const taskAggregateResult = this.resolveCompletionMetrics(
      event,
      "task",
      () => this.options.taskAggregate?.(event.threadId, event.turnId, metricsSignal),
      enrichmentDeadline,
    );
    const sessionAggregateResult = this.resolveCompletionMetrics(
      event,
      "session",
      () => this.options.sessionAggregate?.(event.threadId, metricsSignal),
      enrichmentDeadline,
    );
    const unknownReview = { approved: 0, denied: 0, timedOut: 0, aborted: 0, inProgress: 0, unknown: 0, total: 0, coverage: "unknown" as const };
    const autoApprovalReviewResult = this.resolveCompletionMetrics(event, "turn",
      () => this.options.autoApprovalReview?.(event.threadId, event.turnId, metricsSignal), enrichmentDeadline,
      this.options.autoApprovalReview ? unknownReview : undefined);
    const sessionAutoApprovalReviewResult = this.resolveCompletionMetrics(event, "session",
      () => this.options.sessionAutoApprovalReview?.(event.threadId, metricsSignal), enrichmentDeadline,
      this.options.sessionAutoApprovalReview ? unknownReview : undefined);
    const [executionRead, timing, taskAggregate, sessionAggregate, autoApprovalReview, sessionAutoApprovalReview, accountStatus, gitBranch] = await Promise.all([
      executionResult, timingResult, taskAggregateResult, sessionAggregateResult,
      autoApprovalReviewResult, sessionAutoApprovalReviewResult, accountStatusResult, gitBranchResult,
    ]);
    const execution = executionRead.value;
    return {
      ...event,
      ...(autoApprovalReview === undefined ? {} : { autoApprovalReview }),
      ...(sessionAutoApprovalReview === undefined ? {} : { sessionAutoApprovalReview }),
      ...(accountStatus === undefined ? {} : { accountStatus }),
      ...(gitBranch ? { gitBranch } : {}),
      ...(timing === undefined ? {} : { timing }),
      ...(taskAggregate === undefined ? {} : { taskAggregate }),
      ...(sessionAggregate === undefined ? {} : { sessionAggregate }),
      ...(event.durationMs !== undefined || execution?.durationMs == null ? {} : { durationMs: execution.durationMs }),
      sessionDurationMs: execution?.sessionDurationMs ?? undefined,
      sessionTiming: execution?.sessionTiming,
      executionTimingStatus: executionRead.status,
    };
  }

  private async readExecutionTiming(
    event: CompletedEvent,
    deadlineAtMs: number,
    signal: AbortSignal,
  ): Promise<ExecutionTimingResult> {
    if (!this.options.executionTiming) return {};
    if (this.stopping || signal.aborted) return { status: "notReady" };
    try {
      const query = this.options.executionTiming(event.threadId, event.turnId, signal).then(
        (value): ExecutionTimingResult => value === undefined ? { status: "notReady" } : { value },
        (): ExecutionTimingResult => {
          const timeout = Date.now() >= deadlineAtMs;
          this.logger.warn({ threadId: event.threadId, turnId: event.turnId },
            timeout ? "完成卡轮次耗时读取超时" : "完成卡轮次耗时读取失败");
          return { status: timeout ? "timeout" : signal.aborted ? "notReady" : "failed" };
        },
      );
      return await withDeadline(query, Math.max(0, deadlineAtMs - Date.now()), () => {
        this.logger.warn({ threadId: event.threadId, turnId: event.turnId }, "完成卡轮次耗时读取超时");
        return { status: "timeout" };
      });
    } catch {
      this.logger.warn({ threadId: event.threadId, turnId: event.turnId }, "完成卡轮次耗时读取失败");
      return { status: "failed" };
    }
  }

  private async readGitBranch(
    event: Extract<OutputEvent, { type: "turn.started" | "turn.completed" }>,
    deadlineAtMs: number,
    callerSignal: AbortSignal,
  ): Promise<string | undefined> {
    if (!this.currentGitBranch || this.stopping || callerSignal.aborted) return undefined;
    const deadline = new AbortController();
    const signal = AbortSignal.any([deadline.signal, callerSignal]);
    let cancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
      cancel = () => resolve(undefined);
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      const branch = await withDeadline(
        Promise.race([this.currentGitBranch(event.target, signal, event.workspaceId), cancelled]),
        Math.max(0, deadlineAtMs - Date.now()),
        () => { deadline.abort(); return undefined; },
      );
      return signal.aborted ? undefined : branch;
    } catch {
      this.logger.warn({ threadId: event.threadId, turnId: event.turnId, eventType: event.type }, "任务通知 Git 分支读取失败");
      return undefined;
    } finally {
      signal.removeEventListener("abort", cancel);
      deadline.abort();
    }
  }

  private async readSubagentMetadata(
    event: Extract<OutputEvent, { type: "subagent.spawned" | "subagent.contacted" }>,
    callerSignal: AbortSignal,
  ): Promise<OutputEvent> {
    const fallback = { ...event, modelProvider: null,
      model: event.type === "subagent.spawned" ? event.model ?? null : null,
      reasoningEffort: event.type === "subagent.spawned" ? event.reasoningEffort ?? null : null };
    if (!this.options.subagentMetadata || this.stopping || callerSignal.aborted) return fallback;
    const deadline = new AbortController();
    const signal = AbortSignal.any([deadline.signal, callerSignal]);
    let cancel: (() => void) | undefined;
    try {
      const read = this.options.subagentMetadata.bind(this.options);
      const query = (async () => {
        const result = await read(event.agentThreadId, signal);
        if (signal.aborted) return undefined;
        let matches = result.id === event.agentThreadId && Boolean(result.parentThreadId?.trim());
        if (matches && result.parentThreadId !== event.threadId) {
          matches = false;
          // interacted 可面向同一会话树的孙代理或同级代理；spawned 必须是直接子代理。
          if (event.type === "subagent.contacted" && result.sessionId?.trim()) {
            const sender = await read(event.threadId, signal);
            matches = sender.id === event.threadId
              && Boolean(sender.sessionId?.trim())
              && sender.sessionId === result.sessionId;
          }
        }
        return { result, matches };
      })();
      const cancelled = new Promise<undefined>((resolve) => {
        cancel = () => resolve(undefined);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
      const metadata = await withDeadline(Promise.race([query, cancelled]), 2_000, () => {
        deadline.abort();
        this.logger.warn({ agentThreadId: event.agentThreadId }, "子代理配置读取超时，省略未确认的当前配置");
        return undefined;
      });
      if (signal.aborted || !metadata) return fallback;
      if (!metadata.matches) {
        this.logger.warn({ agentThreadId: event.agentThreadId, threadId: event.threadId }, "子代理配置归属不匹配，省略未确认的当前配置");
        return fallback;
      }
      const { result } = metadata;
      return { ...event, modelProvider: result.modelProvider ?? null,
        model: event.type === "subagent.spawned" ? fallback.model : result.model ?? null,
        reasoningEffort: event.type === "subagent.spawned" ? fallback.reasoningEffort : result.reasoningEffort ?? null };
    } catch {
      if (!signal.aborted) this.logger.warn({ agentThreadId: event.agentThreadId }, "子代理配置读取失败，省略未确认的当前配置");
      return fallback;
    } finally {
      if (cancel) signal.removeEventListener("abort", cancel);
      deadline.abort();
    }
  }

  private async readCompletionAccountStatus(
    event: Extract<OutputEvent, { type: "turn.completed" }>,
    callerSignal: AbortSignal,
  ): Promise<CompletionAccountStatus | undefined> {
    const provider = event.modelProvider;
    if (!provider || provider === "openai" || !this.options.completionAccountStatus || this.stopping || callerSignal.aborted) return undefined;
    const deadline = new AbortController();
    const signal = AbortSignal.any([deadline.signal, callerSignal]);
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
