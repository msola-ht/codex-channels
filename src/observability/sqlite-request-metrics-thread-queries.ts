import type { SQLInputValue } from "node:sqlite";
import type { RequestTimingSummary } from "../../runtime/request-timing.mjs";
import { summarizeResponseUsage } from "./response-usage-summary.js";
import type {
  RequestInterruptionSummary,
  ResponseUsageSummary,
  SessionExecutionTiming,
  ModelRequestMetricsThreadQuery,
  ModelRequestMetricsScope,
  StoredThreadListPage,
  StoredThreadRequestMetricsSummary,
  StoredThreadTurnsPage,
  StoredTurnRequestMetricsSummary,
} from "./request-metrics.js";
import {
  toStoredCacheUsage,
  toStoredCompactSummary,
  toStoredMetricsAggregate,
  toStoredRequestOutcomes,
  toStoredThreadAggregate,
  toStoredTurnSummary,
  type AggregateRow,
  type CacheUsageRow,
  type TurnSummaryRow,
} from "./sqlite-request-metrics-row-codec.js";
import {
  compactAggregateSql,
  metricsAggregateSql,
  metricsPageOffset,
  metricsScopeSql,
  observableCompletionSql,
  requestOutcomeSql,
  validateThreadId,
  type MetricsQueryReader,
} from "./sqlite-request-metrics-queries.js";
import type { SqliteRequestMetricsSubagentQueries } from "./sqlite-request-metrics-subagent-queries.js";

/** 会话级只读查询：Thread/Turn 聚合、耗时、中断与分页列表。 */
export class SqliteRequestMetricsThreadQueries {
  constructor(
    private readonly reader: MetricsQueryReader,
    private readonly subagents: SqliteRequestMetricsSubagentQueries,
  ) {}

  threadSummary(threadId: string): StoredThreadRequestMetricsSummary {
    this.reader.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const latestTurn = this.reader.prepare(`
      SELECT turn_id
      FROM model_request_metrics
      WHERE thread_id = ? AND turn_id IS NOT NULL AND operation = 'response'
      ORDER BY id DESC
      LIMIT 1
    `).get(threadId) as { turn_id: string } | undefined;
    const turn = latestTurn === undefined
      ? undefined
      : this.queryThreadTurnSummary(threadId, latestTurn.turn_id);
    const scopeSql = `
      WITH RECURSIVE thread_tree(thread_id) AS (
        SELECT ?
        UNION
        SELECT child.thread_id
        FROM subagent_threads AS child
        JOIN thread_tree AS parent
          ON child.parent_thread_id = parent.thread_id
      ), scoped AS (
        SELECT metric.*
        FROM model_request_metrics AS metric
        WHERE metric.thread_id IN (SELECT thread_id FROM thread_tree)
          AND metric.turn_id IS NOT NULL
      )
    `;
    const threadAggregate = this.reader.prepare(`${scopeSql}
      SELECT
        ${requestOutcomeSql()},
        (SELECT provider FROM scoped ORDER BY id DESC LIMIT 1) AS provider,
        NULL AS turn_id,
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count,
        COUNT(*) AS request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
          AS unsuccessful_request_count,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        COUNT(input_tokens) AS input_token_count,
        COUNT(cached_input_tokens) AS cached_input_token_count,
        SUM(output_tokens) AS output_tokens,
        SUM(reasoning_output_tokens) AS reasoning_output_tokens,
        COUNT(CASE WHEN input_tokens IS NOT NULL THEN cached_input_tokens END) AS cache_observed_request_count,
        ${compactAggregateSql}
      FROM scoped
    `).get(threadId) as unknown as TurnSummaryRow;
    const sessionTiming = this.sessionExecutionTiming(threadId);
    return {
      threadId,
      sessionTiming,
      latestExecution: this.reader.prepare(`SELECT turn_id AS turnId, duration_ms AS durationMs
        FROM turn_execution_metrics WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1`).get(threadId) as
        { turnId: string; durationMs: number | null } | undefined ?? null,
      sessionDurationMs: sessionTiming.historyComplete && sessionTiming.missingTurnCount === 0 ? sessionTiming.knownDurationMs : null,
      latestTurn: turn === undefined ? null : {
        ...toStoredTurnSummary(turn),
        interruptionSummary: this.turnInterruptionSummary(threadId, latestTurn!.turn_id),
        durationMs: this.turnExecutionDuration(threadId, latestTurn!.turn_id),
        responseUsage: this.turnResponseUsage(threadId, latestTurn!.turn_id),
        performance: this.turnPerformance(threadId, latestTurn!.turn_id),
      },
      threadAggregate: threadAggregate.request_count === 0
        ? null
        : {
          ...toStoredThreadAggregate(threadAggregate),
          performance: this.scopedPerformance(scopeSql, [threadId]),
          interruptionSummary: this.queryInterruptionSummary(scopeSql, [threadId]),
          responseUsage: this.scopedResponseUsage(scopeSql, [threadId]),
        },
    };
  }

  threadTurnTaskSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    this.reader.requireOpen();
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    const child = this.reader.prepare(`
      SELECT 1
      FROM subagent_turns
      WHERE parent_thread_id = ?
        AND parent_turn_id = ?
      LIMIT 1
    `).get(threadId, turnId);
    if (child === undefined) return null;
    const scopeSql = `
      WITH RECURSIVE task_threads(thread_id, turn_id) AS (
        SELECT child.thread_id, child.turn_id
        FROM subagent_turns AS child
        WHERE child.parent_thread_id = ?
          AND child.parent_turn_id = ?
        UNION
        SELECT child.thread_id, child.turn_id
        FROM subagent_turns AS child
        JOIN task_threads AS parent
          ON child.parent_thread_id = parent.thread_id
          AND child.parent_turn_id = parent.turn_id
      ), scoped AS (
        SELECT metric.*
        FROM model_request_metrics AS metric
        WHERE (
          metric.thread_id = ? AND metric.turn_id = ?
        ) OR (
          EXISTS (
            SELECT 1
            FROM task_threads AS task
            WHERE task.thread_id = metric.thread_id
              AND task.turn_id = metric.turn_id
          )
        )
      )
    `;
    const row = this.reader.prepare(`${scopeSql}
      SELECT
        ${requestOutcomeSql()},
        (SELECT provider FROM scoped ORDER BY id DESC LIMIT 1) AS provider,
        (SELECT model FROM scoped ORDER BY id DESC LIMIT 1) AS model,
        (SELECT reasoning_effort FROM scoped ORDER BY id DESC LIMIT 1)
          AS reasoning_effort,
        ? AS turn_id,
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count,
        COUNT(*) AS request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
          AS unsuccessful_request_count,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        COUNT(input_tokens) AS input_token_count,
        COUNT(cached_input_tokens) AS cached_input_token_count,
        SUM(output_tokens) AS output_tokens,
        SUM(reasoning_output_tokens) AS reasoning_output_tokens,
        COUNT(CASE WHEN input_tokens IS NOT NULL THEN cached_input_tokens END) AS cache_observed_request_count,
        ${compactAggregateSql}
      FROM scoped
    `).get(threadId, turnId, threadId, turnId, turnId) as TurnSummaryRow | undefined;
    // The direct-child probe above is the display gate. Keep a zero summary
    // when a child has not produced any model rows yet so the parent card can
    // distinguish an observed child from an absent task aggregate.
    return row === undefined ? null : {
      ...toStoredTurnSummary(row),
      interruptionSummary: this.queryInterruptionSummary(scopeSql, [threadId, turnId, threadId, turnId]),
      responseUsage: this.scopedResponseUsage(scopeSql, [threadId, turnId, threadId, turnId]),
    };
  }

  threadTurnSummary(
    threadId: string,
    turnId: string,
  ): StoredTurnRequestMetricsSummary | null {
    this.reader.requireOpen();
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    const row = this.queryThreadTurnSummary(threadId, turnId);
    return row === undefined ? null : {
      ...toStoredTurnSummary(row),
      interruptionSummary: this.turnInterruptionSummary(threadId, turnId),
      durationMs: this.turnExecutionDuration(threadId, turnId),
      responseUsage: this.turnResponseUsage(threadId, turnId),
      performance: this.turnPerformance(threadId, turnId),
    };
  }

  private turnPerformance(threadId: string, turnId: string): RequestTimingSummary {
    return this.scopedPerformance(`WITH scoped AS (
      SELECT * FROM model_request_metrics WHERE thread_id = ? AND turn_id = ?
    )`, [threadId, turnId]);
  }

  private scopedPerformance(scopeSql: string, parameters: SQLInputValue[]): RequestTimingSummary {
    return this.reader.prepare(`${scopeSql}, performance_samples AS (
      SELECT first_token_ms, output_tokens,
        total_duration_ms AS request_duration_ms,
        status = 'completed' AND output_tokens > 0
          AND total_duration_ms > 0 AS valid_speed
      FROM scoped WHERE source = 'owned' AND operation = 'response'
    )
      SELECT COUNT(*) AS requestCount, COUNT(first_token_ms) AS firstTokenSampleCount,
        AVG(first_token_ms) AS averageFirstTokenMs,
        1000.0 * SUM(output_tokens) FILTER (WHERE valid_speed)
          / SUM(request_duration_ms) FILTER (WHERE valid_speed) AS generationTokensPerSecond
      FROM performance_samples
    `).get(...parameters) as unknown as RequestTimingSummary;
  }

  private scopedResponseUsage(scopeSql: string, parameters: SQLInputValue[]): ResponseUsageSummary | null {
    return summarizeResponseUsage(this.reader.iterateRows(`${scopeSql}
      SELECT response_usage_amount FROM scoped WHERE provider = 'openai'
    `, ...parameters) as Iterable<{ response_usage_amount: string | null }>);
  }

  turnExecutionDuration(threadId: string, turnId: string): number | null {
    this.reader.requireOpen();
    validateThreadId(threadId, "Thread ID");
    validateThreadId(turnId, "Turn ID");
    const row = this.reader.prepare("SELECT duration_ms FROM turn_execution_metrics WHERE thread_id = ? AND turn_id = ?")
      .get(threadId, turnId) as { duration_ms: number | null } | undefined;
    return row?.duration_ms ?? null;
  }

  sessionExecutionDuration(threadId: string, throughTurnId?: string): number | null {
    const timing = this.sessionExecutionTiming(threadId, throughTurnId);
    return timing.historyComplete && timing.missingTurnCount === 0 ? timing.knownDurationMs : null;
  }

  sessionExecutionTiming(threadId: string, throughTurnId?: string): SessionExecutionTiming {
    this.reader.requireOpen();
    validateThreadId(threadId, "Thread ID");
    if (throughTurnId !== undefined) validateThreadId(throughTurnId, "Turn ID");
    const row = this.reader.prepare(`SELECT TOTAL(duration_ms) AS duration_ms,
      (SELECT history_complete FROM thread_execution_state WHERE thread_id = ?) AS history_complete,
      COUNT(*) AS total, COUNT(duration_ms) AS known FROM turn_execution_metrics
      WHERE thread_id = ?
      ${throughTurnId === undefined ? "" : "AND ordinal <= (SELECT ordinal FROM turn_execution_metrics WHERE thread_id = ? AND turn_id = ?)"}`)
      .get(threadId, threadId, ...(throughTurnId === undefined ? [] : [threadId, throughTurnId])) as {
        duration_ms: number | null; total: number; known: number; history_complete: number | null;
      };
    return {
      knownDurationMs: row.known > 0 && Number.isSafeInteger(row.duration_ms) ? row.duration_ms : null,
      missingTurnCount: row.total - row.known,
      historyComplete: row.history_complete === 1 && row.total > 0,
    };
  }

  private turnResponseUsage(threadId: string, turnId: string): ResponseUsageSummary | null {
    return this.scopedResponseUsage(`WITH scoped AS (
      SELECT provider, response_usage_amount FROM model_request_metrics WHERE thread_id = ? AND turn_id = ?
    )`, [threadId, turnId]);
  }

  private turnInterruptionSummary(threadId: string, turnId: string): RequestInterruptionSummary {
    return this.queryInterruptionSummary(`WITH scoped AS (
      SELECT * FROM model_request_metrics WHERE thread_id = ? AND turn_id = ?
    )`, [threadId, turnId]);
  }

  private queryInterruptionSummary(scopeSql: string, parameters: SQLInputValue[]): RequestInterruptionSummary {
    return interruptionFromRow(this.queryInterruptionRows(scopeSql, parameters)[0]!);
  }

  private queryInterruptionRows(scopeSql: string, parameters: SQLInputValue[], byTurn = false): InterruptionRow[] {
    // Rows may be persisted out of completion order. The window observes only
    // the selected scope and compares real response completion times.
    return this.reader.prepare(`${scopeSql}, observed AS (
      SELECT *, MAX(CASE WHEN ${observableCompletionSql} THEN response_completed_at_ms END)
        OVER (PARTITION BY thread_id, turn_id) AS latest_completion_at_ms
      FROM scoped
    )
    SELECT ${byTurn ? "turn_id," : ""}
      COUNT(CASE WHEN thread_id IS NOT NULL AND turn_id IS NOT NULL AND TRIM(turn_id) <> ''
        AND latest_completion_at_ms > response_completed_at_ms THEN 1 END) AS followed_by_completion,
      COUNT(*) - COUNT(CASE WHEN thread_id IS NOT NULL AND turn_id IS NOT NULL AND TRIM(turn_id) <> ''
        AND latest_completion_at_ms > response_completed_at_ms THEN 1 END) AS no_observed_completion,
      COUNT(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 END) AS usage_unobserved
    FROM observed
    WHERE NOT (${observableCompletionSql}) AND error_type = 'client_disconnected'
    ${byTurn ? "GROUP BY turn_id" : ""}
    `).all(...parameters) as unknown as InterruptionRow[];
  }

  private queryThreadTurnSummary(
    threadId: string,
    turnId: string,
  ): TurnSummaryRow | undefined {
    return this.reader.prepare(`
      SELECT
        ${requestOutcomeSql()},
        (
          SELECT upstream_ttft_ms FROM model_request_metrics AS first_timing
          WHERE first_timing.thread_id = model_request_metrics.thread_id
            AND first_timing.turn_id = model_request_metrics.turn_id
            AND first_timing.provider = 'openai'
            AND first_timing.operation = 'response'
            AND first_timing.upstream_ttft_ms IS NOT NULL
          ORDER BY first_timing.id LIMIT 1
        ) AS upstream_ttft_ms,
        (
          SELECT provider
          FROM model_request_metrics AS latest_provider
          WHERE latest_provider.thread_id
              = model_request_metrics.thread_id
            AND latest_provider.turn_id
              = model_request_metrics.turn_id
            AND latest_provider.operation = 'response'
          ORDER BY latest_provider.id DESC
          LIMIT 1
        ) AS provider,
        (
          SELECT model
          FROM model_request_metrics AS latest_model
          WHERE latest_model.thread_id
              = model_request_metrics.thread_id
            AND latest_model.turn_id
              = model_request_metrics.turn_id
            AND latest_model.operation = 'response'
          ORDER BY latest_model.id DESC
          LIMIT 1
        ) AS model,
        (
          SELECT reasoning_effort
          FROM model_request_metrics AS latest_effort
          WHERE latest_effort.thread_id
              = model_request_metrics.thread_id
            AND latest_effort.turn_id
              = model_request_metrics.turn_id
            AND latest_effort.operation = 'response'
          ORDER BY latest_effort.id DESC
          LIMIT 1
        ) AS reasoning_effort,
        turn_id,
        COUNT(DISTINCT turn_id) AS turn_count,
        COUNT(*) AS request_count,
        SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END)
          AS unsuccessful_request_count,
        SUM(input_tokens) AS input_tokens,
        SUM(cached_input_tokens) AS cached_input_tokens,
        COUNT(input_tokens) AS input_token_count,
        COUNT(cached_input_tokens) AS cached_input_token_count,
        SUM(output_tokens) AS output_tokens,
        SUM(reasoning_output_tokens) AS reasoning_output_tokens,
        COUNT(CASE WHEN input_tokens IS NOT NULL THEN cached_input_tokens END) AS cache_observed_request_count,
        ${compactAggregateSql}
      FROM model_request_metrics
      WHERE thread_id = ? AND turn_id = ?
      GROUP BY turn_id
    `).get(threadId, turnId) as TurnSummaryRow | undefined;
  }

  threadTurnSummaries(threadId: string, query: ModelRequestMetricsThreadQuery): StoredThreadTurnsPage {
    validateThreadId(threadId, "Thread ID");
    if (query.threadId !== undefined && query.threadId !== threadId) {
      throw new Error("Thread ID 与查询范围不一致");
    }
    const { rows, ...page } = this.queryThreadTurnPage({ ...query, threadId });
    const subagentCounts = this.subagents.turnDirectSubagentCounts(threadId, rows.map((row) => row.turn_id!));
    const scope = metricsScopeSql({ ...query, threadId });
    const interruptions = rows.length === 0 ? [] : this.queryInterruptionRows(`WITH scoped AS (
      SELECT * FROM model_request_metrics WHERE ${scope.sql}
        AND turn_id IN (${rows.map(() => "?").join(", ")})
    )`, [...scope.params, ...rows.map((row) => row.turn_id!)], true);
    const interruptionByTurn = new Map(interruptions.map((row) => [row.turn_id, interruptionFromRow(row)]));
    return {
      ...page,
      ...this.threadTreeAggregates(threadId, query),
      turns: rows.map((row) => ({
        ...toStoredTurnSummary(row),
        interruptionSummary: interruptionByTurn.get(row.turn_id!) ?? emptyInterruptionSummary(),
        durationMs: row.duration_ms,
        recordedAtMs: row.recorded_at_ms,
        directSubagentCount: subagentCounts.get(row.turn_id!) ?? 0,
      })),
    };
  }

  private threadTreeAggregates(
    threadId: string,
    query: ModelRequestMetricsThreadQuery,
  ): Pick<StoredThreadTurnsPage, "subagentTurnCount" | "subagentAggregate" | "treeAggregate"> {
    // An own Turn filter does not establish which descendant Turns belong to it.
    if (query.turnId !== undefined) return { subagentTurnCount: null, subagentAggregate: null, treeAggregate: null };
    const scope = metricsScopeSql({ ...query, threadId }, true);
    const cte = `WITH RECURSIVE tree(thread_id) AS (
      SELECT ?
      UNION
      SELECT child.thread_id FROM tree
      JOIN subagent_threads AS child ON child.parent_thread_id = tree.thread_id
    ), scoped AS (
      SELECT * FROM model_request_metrics
      WHERE ${scope.sql} AND turn_id IS NOT NULL
        AND thread_id IN (SELECT thread_id FROM tree)
    )`;
    const parameters = [threadId, ...scope.params];
    const treeSummary = this.reader.prepare(`
      ${cte} SELECT ${metricsAggregateSql} FROM scoped
    `).get(...parameters) as unknown as AggregateRow;
    const subagentSummary = this.reader.prepare(`
      ${cte}, descendants AS (SELECT * FROM scoped WHERE thread_id != ?)
      SELECT ${metricsAggregateSql},
        (SELECT COUNT(*) FROM (SELECT DISTINCT thread_id, turn_id FROM descendants)) AS turn_count
      FROM descendants
    `).get(...parameters, threadId) as unknown as AggregateRow & { turn_count: number };
    return {
      subagentTurnCount: subagentSummary.turn_count,
      subagentAggregate: subagentSummary.request_count === 0 ? null : toStoredMetricsAggregate(subagentSummary),
      treeAggregate: treeSummary.request_count === 0 ? null : toStoredMetricsAggregate(treeSummary),
    };
  }

  threadTurnCount(threadId: string): number | null {
    this.reader.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const row = this.reader.prepare(`
      SELECT COUNT(DISTINCT turn_id) AS turn_count, COUNT(*) AS request_count
      FROM model_request_metrics
      WHERE thread_id = ? AND turn_id IS NOT NULL
    `).get(threadId) as { turn_count: number; request_count: number };
    return row.request_count === 0 ? null : row.turn_count;
  }

  threadCounts(query: ModelRequestMetricsScope): { threadCount: number; turnCount: number } {
    this.reader.requireOpen();
    const scope = metricsScopeSql(query);
    return this.reader.prepare(`
      SELECT COUNT(DISTINCT thread_id) AS threadCount, COUNT(*) AS turnCount
      FROM (
        SELECT DISTINCT thread_id, turn_id FROM model_request_metrics
        WHERE ${scope.sql} AND thread_id IS NOT NULL AND turn_id IS NOT NULL
      )
    `).get(...scope.params) as { threadCount: number; turnCount: number };
  }

  threadList(query: ModelRequestMetricsThreadQuery): StoredThreadListPage {
    const { rows, ...page } = this.queryThreadListPage(query);
    const threadIds = rows.map((row) => row.root_thread_id);
    const subagentCounts = this.subagents.directSubagentCounts(threadIds);
    const timings = this.threadSessionTimings(threadIds);
    return {
      ...page,
      threads: rows.map((row) => ({
        cacheUsage: row.request_count === null
          ? { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 0 }
          : toStoredCacheUsage(row),
        sessionTiming: timings.get(row.root_thread_id) ?? { knownDurationMs: null, missingTurnCount: 0, historyComplete: false },
        threadId: row.root_thread_id,
        provider: row.provider ?? null,
        model: row.model ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        agentPath: row.agent_path,
        parentThreadId: row.parent_thread_id,
        parentTurnId: row.parent_turn_id,
        directSubagentCount: subagentCounts.get(row.root_thread_id) ?? 0,
        turnCount: row.turn_count ?? 0,
        requestCount: row.request_count ?? 0,
        requestOutcomes: toStoredRequestOutcomes(row),
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        cachedInputTokens: row.request_count === null ? 0
          : row.cache_missing_request_count === 0 ? row.cached_input_tokens ?? 0 : null,
        subagentUsage: {
          inputTokens: row.subagent_input_tokens ?? 0,
          cachedInputTokens: row.subagent_cache_missing_request_count === 0
            ? row.subagent_cached_input_tokens ?? 0 : null,
          outputTokens: row.subagent_output_tokens ?? 0,
          cacheUsage: toStoredCacheUsage({
            known_cached_input_tokens: row.subagent_known_cached_input_tokens,
            cache_observed_input_tokens: row.subagent_cache_observed_input_tokens,
            cache_missing_request_count: row.subagent_cache_missing_request_count,
          }),
        },
        totalTokens: row.total_tokens,
        compact: row.request_count === null ? null : toStoredCompactSummary(row),
        firstRequestStartedAtMs: row.first_request_started_at_ms ?? row.tree_first_request_started_at_ms,
        lastRecordedAtMs: row.recorded_at_ms ?? row.tree_recorded_at_ms,
      })),
    };
  }

  private queryThreadListPage(query: ModelRequestMetricsThreadQuery) {
    this.reader.requireOpen();
    // Thread ID selects the root unless an exact own Turn is requested. Other
    // filters (including keyword searches) apply to descendant requests as well.
    const scope = metricsScopeSql(query, true);
    const offset = metricsPageOffset(query);
    const sortColumns = {
      time: "COALESCE(grouped.first_request_started_at_ms, tree_grouped.tree_first_request_started_at_ms)",
      last: "COALESCE(grouped.recorded_at_ms, tree_grouped.tree_recorded_at_ms)",
      thread: "tree_grouped.root_thread_id", turn: "grouped.turn_id",
      provider: "latest.provider", model: "latest.model", turns: "COALESCE(grouped.turn_count, 0)",
      requests: "COALESCE(grouped.request_count, 0)", failures: "COALESCE(grouped.failed_request_count, 0)",
      input: "COALESCE(grouped.input_tokens, 0)", output: "COALESCE(grouped.output_tokens, 0)",
      compact: "COALESCE(grouped.compact_request_count, 0)",
      totalTokens: "tree_grouped.total_tokens",
    };
    const sortColumn = sortColumns[query.sortKey ?? "last"];
    const direction = query.sortDirection ?? "desc";
    if (sortColumn === undefined || !["asc", "desc"].includes(direction)) {
      throw new Error("会话指标排序无效");
    }
    const parameters = [...scope.params, ...(query.threadId === undefined ? [] : [query.threadId])];
    // Unfiltered Thread lists retain their own-request membership. Main lists also
    // include registered parents whose only matching activity belongs to children.
    const cte = `WITH RECURSIVE scoped AS (
        SELECT * FROM model_request_metrics
        WHERE ${scope.sql} AND thread_id IS NOT NULL AND turn_id IS NOT NULL
      ), ancestors(thread_id) AS (
        SELECT DISTINCT thread_id FROM scoped
        UNION
        SELECT relation.parent_thread_id
        FROM ancestors JOIN subagent_threads AS relation ON relation.thread_id = ancestors.thread_id
      ), candidates AS (
        SELECT DISTINCT candidate.thread_id FROM ${query.mainThreadsOnly ? "ancestors" : "scoped"} AS candidate
        WHERE ${query.threadId === undefined ? "1 = 1" : "thread_id = ?"}
          ${query.mainThreadsOnly ? "AND NOT EXISTS (SELECT 1 FROM subagent_threads WHERE subagent_threads.thread_id = candidate.thread_id)" : ""}
      ), tree(root_thread_id, thread_id) AS (
        SELECT thread_id, thread_id FROM candidates
        UNION
        SELECT tree.root_thread_id, child.thread_id
        FROM tree JOIN subagent_threads AS child ON child.parent_thread_id = tree.thread_id
      ), tree_scoped AS (
        SELECT tree.root_thread_id, scoped.*
        FROM tree JOIN scoped ON scoped.thread_id = tree.thread_id
      ), tree_grouped AS (
        SELECT root_thread_id,
          SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS total_tokens,
          SUM(CASE WHEN thread_id != root_thread_id THEN input_tokens END) AS subagent_input_tokens,
          SUM(CASE WHEN thread_id != root_thread_id THEN cached_input_tokens END) AS subagent_cached_input_tokens,
          SUM(CASE WHEN thread_id != root_thread_id THEN output_tokens END) AS subagent_output_tokens,
          SUM(CASE WHEN thread_id != root_thread_id AND input_tokens IS NOT NULL
            THEN cached_input_tokens END) AS subagent_known_cached_input_tokens,
          SUM(CASE WHEN thread_id != root_thread_id AND cached_input_tokens IS NOT NULL
            THEN input_tokens END) AS subagent_cache_observed_input_tokens,
          SUM(CASE WHEN thread_id != root_thread_id AND (input_tokens IS NULL OR cached_input_tokens IS NULL)
            THEN 1 ELSE 0 END) AS subagent_cache_missing_request_count,
          MIN(request_started_at_ms) AS tree_first_request_started_at_ms,
          MAX(recorded_at_ms) AS tree_recorded_at_ms
        FROM tree_scoped GROUP BY root_thread_id
      )`;
    const summary = this.reader.prepare(`
      ${cte}
      SELECT ${metricsAggregateSql},
        (SELECT COUNT(*) FROM tree_grouped) AS thread_count,
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count
      FROM scoped WHERE thread_id IN (SELECT root_thread_id FROM tree_grouped)
    `).get(...parameters) as unknown as AggregateRow & { thread_count: number; turn_count: number };
    const treeSummary = this.reader.prepare(`
      ${cte}
      SELECT ${metricsAggregateSql}
      FROM scoped WHERE id IN (SELECT id FROM tree_scoped)
    `).get(...parameters) as unknown as AggregateRow;
    const rows = this.reader.prepare(`
      ${cte}, grouped AS (
        SELECT thread_id, turn_id, COUNT(DISTINCT turn_id) AS turn_count,
          ${metricsAggregateSql},
          MIN(request_started_at_ms) AS first_request_started_at_ms,
          MAX(recorded_at_ms) AS recorded_at_ms, MAX(id) AS latest_id
        FROM scoped WHERE thread_id IN (SELECT root_thread_id FROM tree_grouped)
        GROUP BY thread_id
      )
      SELECT grouped.*, tree_grouped.*, latest.provider, latest.model, latest.reasoning_effort,
        subagent.agent_path, subagent.parent_thread_id, subagent.parent_turn_id
      FROM tree_grouped
      LEFT JOIN grouped ON grouped.thread_id = tree_grouped.root_thread_id
      LEFT JOIN model_request_metrics AS latest ON latest.id = grouped.latest_id
      LEFT JOIN subagent_threads AS subagent ON subagent.thread_id = tree_grouped.root_thread_id
      ORDER BY ${sortColumn} ${direction}, tree_grouped.root_thread_id ${direction}
      LIMIT ? OFFSET ?
    `).all(...parameters, query.limit, offset) as unknown as Array<TurnSummaryRow & CacheUsageRow & {
      root_thread_id: string;
      first_request_started_at_ms: number | null;
      recorded_at_ms: number | null;
      total_tokens: number;
      subagent_input_tokens: number | null;
      subagent_cached_input_tokens: number | null;
      subagent_output_tokens: number | null;
      subagent_known_cached_input_tokens: number | null;
      subagent_cache_observed_input_tokens: number | null;
      subagent_cache_missing_request_count: number;
      tree_first_request_started_at_ms: number;
      tree_recorded_at_ms: number;
      agent_path: string | null;
      parent_thread_id: string | null;
      parent_turn_id: string | null;
    }>;
    return {
      rows,
      matchedTotal: summary.thread_count,
      nextOffset: offset + rows.length < summary.thread_count ? offset + rows.length : null,
      aggregate: summary.request_count === 0 ? null : toStoredMetricsAggregate(summary),
      treeAggregate: treeSummary.request_count === 0 ? null : toStoredMetricsAggregate(treeSummary),
      turnCount: summary.turn_count,
    };
  }

  private threadSessionTimings(threadIds: string[]): Map<string, SessionExecutionTiming> {
    if (threadIds.length === 0) return new Map();
    const rows = this.reader.prepare(`
      SELECT timing.thread_id, TOTAL(timing.duration_ms) AS duration_ms,
        COUNT(*) AS total, COUNT(timing.duration_ms) AS known, state.history_complete
      FROM turn_execution_metrics AS timing
      LEFT JOIN thread_execution_state AS state ON state.thread_id = timing.thread_id
      WHERE timing.thread_id IN (${threadIds.map(() => "?").join(", ")})
      GROUP BY timing.thread_id
    `).all(...threadIds) as unknown as Array<{
      thread_id: string; duration_ms: number; total: number; known: number; history_complete: number | null;
    }>;
    return new Map(rows.map((row) => [row.thread_id, {
      knownDurationMs: row.known > 0 && Number.isSafeInteger(row.duration_ms) ? row.duration_ms : null,
      missingTurnCount: row.total - row.known,
      historyComplete: row.history_complete === 1 && row.total > 0,
    }]));
  }

  private queryThreadTurnPage(query: ModelRequestMetricsThreadQuery) {
    this.reader.requireOpen();
    const scope = metricsScopeSql(query);
    const offset = metricsPageOffset(query);
    const sortKey = query.sortKey ?? "last";
    const sortColumns = {
      time: "recorded_at_ms",
      last: "recorded_at_ms", thread: "grouped.thread_id", turn: "grouped.turn_id",
      provider: "latest.provider", model: "latest.model", turns: "turn_count",
      requests: "request_count", failures: "failed_request_count",
      input: "input_tokens", output: "output_tokens", compact: "compact_request_count",
      totalTokens: undefined,
    };
    const sortColumn = sortColumns[sortKey];
    const direction = query.sortDirection ?? "desc";
    if (sortColumn === undefined || !["asc", "desc"].includes(direction)) {
      throw new Error("会话指标排序无效");
    }
    const scoped = `SELECT * FROM model_request_metrics
      WHERE ${scope.sql} AND thread_id IS NOT NULL AND turn_id IS NOT NULL`;
    const summary = this.reader.prepare(`
      SELECT ${metricsAggregateSql},
        COUNT(DISTINCT thread_id || char(0) || turn_id) AS turn_count
      FROM (${scoped})
    `).get(...scope.params) as unknown as AggregateRow & { turn_count: number };
    const matchedTotal = summary.turn_count;
    const rows = this.reader.prepare(`
      WITH scoped AS (${scoped}), grouped AS (
        SELECT thread_id, turn_id, COUNT(DISTINCT turn_id) AS turn_count,
          ${metricsAggregateSql},
          MIN(request_started_at_ms) AS first_request_started_at_ms,
          MAX(recorded_at_ms) AS recorded_at_ms,
          MAX(id) AS latest_id
        FROM scoped
        GROUP BY turn_id
      )
      SELECT grouped.*, latest.provider, latest.model, latest.reasoning_effort,
        timing.duration_ms,
        subagent.agent_path, subagent.parent_thread_id, subagent.parent_turn_id
      FROM grouped
      JOIN model_request_metrics AS latest ON latest.id = grouped.latest_id
      LEFT JOIN turn_execution_metrics AS timing ON timing.thread_id = grouped.thread_id AND timing.turn_id = grouped.turn_id
      LEFT JOIN subagent_threads AS subagent ON subagent.thread_id = grouped.thread_id
      ORDER BY ${sortColumn} ${direction}, grouped.turn_id ${direction}
      LIMIT ? OFFSET ?
    `).all(...scope.params, query.limit, offset) as unknown as Array<TurnSummaryRow & CacheUsageRow & {
      thread_id: string;
      duration_ms: number | null;
      first_request_started_at_ms: number;
      recorded_at_ms: number;
      agent_path: string | null;
      parent_thread_id: string | null;
      parent_turn_id: string | null;
    }>;
    return {
      rows,
      matchedTotal,
      nextOffset: offset + rows.length < matchedTotal ? offset + rows.length : null,
      aggregate: summary.request_count === 0 ? null : toStoredMetricsAggregate(summary),
      turnCount: summary.turn_count,
    };
  }
}

interface InterruptionRow {
  turn_id?: string;
  followed_by_completion: number;
  no_observed_completion: number;
  usage_unobserved: number;
}

function emptyInterruptionSummary(): RequestInterruptionSummary {
  return { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 };
}

function interruptionFromRow(row: InterruptionRow): RequestInterruptionSummary {
  return {
    followedByCompletion: row.followed_by_completion,
    noObservedCompletion: row.no_observed_completion,
    usageUnobserved: row.usage_unobserved,
  };
}
