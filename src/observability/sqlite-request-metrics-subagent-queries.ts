import type {
  StoredSubagentThreadRecord,
  StoredThreadSubagentsPage,
  SubagentThreadsQuery,
} from "./request-metrics.js";
import {
  toStoredCacheUsage,
  toStoredRequestOutcomes,
  type CacheUsageRow,
  type RequestOutcomeRow,
} from "./sqlite-request-metrics-row-codec.js";
import {
  cacheUsageSql,
  metricsPageOffset,
  requestOutcomeSql,
  validateThreadId,
  type MetricsQueryReader,
} from "./sqlite-request-metrics-queries.js";

/** 子代理级只读查询：子代理关系分页、直接子级计数与同步游标读取。 */
export class SqliteRequestMetricsSubagentQueries {
  constructor(private readonly reader: MetricsQueryReader) {}

  threadSubagents(threadId: string, query: SubagentThreadsQuery): StoredThreadSubagentsPage {
    validateThreadId(threadId, "Thread ID");
    return this.subagentPage(query, threadId);
  }

  subagents(query: SubagentThreadsQuery): StoredThreadSubagentsPage {
    return this.subagentPage(query);
  }

  private subagentPage(query: SubagentThreadsQuery, parentThreadId?: string): StoredThreadSubagentsPage {
    this.reader.requireOpen();
    if (query.parentTurnId !== undefined) {
      if (parentThreadId === undefined) throw new Error("父 Turn ID 必须同时指定父 Thread ID");
      validateThreadId(query.parentTurnId, "父 Turn ID");
    }
    const offset = metricsPageOffset(query);
    if (query.limit > 100) throw new Error("子代理查询数量必须在 1 到 100 之间");
    const sortKey = query.sortKey ?? "last";
    const direction = query.sortDirection ?? "desc";
    if (!["time", "last"].includes(sortKey) || !["asc", "desc"].includes(direction)) {
      throw new Error("子代理排序无效");
    }
    const sortColumn = sortKey === "time" ? "first_request_started_at_ms" : "last_recorded_at_ms";
    const relationFilter = parentThreadId === undefined ? "" : `WHERE relation.parent_thread_id = ?${
      query.parentTurnId === undefined ? "" : ` AND relation.thread_id IN (
        SELECT child.thread_id FROM subagent_turns AS child
        WHERE child.parent_thread_id = ?
          AND child.parent_turn_id = ?
      )`
    }`;
    const parameters = parentThreadId === undefined ? [] : [parentThreadId];
    if (query.parentTurnId !== undefined) parameters.push(parentThreadId!, query.parentTurnId);
    const { total } = this.reader.prepare(`
      SELECT COUNT(*) AS total FROM subagent_threads AS relation ${relationFilter}
    `).get(...parameters) as { total: number };
    const summary = this.reader.prepare(`
      SELECT COUNT(*) AS request_count,
        ${requestOutcomeSql()},
        COUNT(DISTINCT json_array(thread_id, turn_id)) FILTER (WHERE turn_id IS NOT NULL) AS turn_count,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, ${cacheUsageSql}
      FROM model_request_metrics
      WHERE thread_id IN (SELECT relation.thread_id FROM subagent_threads AS relation ${relationFilter})
    `).get(...parameters) as unknown as CacheUsageRow & RequestOutcomeRow & {
      request_count: number;
      turn_count: number;
      input_tokens: number | null;
      output_tokens: number | null;
    };
    const modelUsageRows = this.reader.prepare(`
      SELECT model, COUNT(*) AS request_count,
        COUNT(DISTINCT json_array(thread_id, turn_id)) FILTER (WHERE turn_id IS NOT NULL) AS turn_count,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens, ${cacheUsageSql}
      FROM model_request_metrics
      WHERE thread_id IN (SELECT relation.thread_id FROM subagent_threads AS relation ${relationFilter})
      GROUP BY model
      ORDER BY model IS NULL ASC, model ASC
    `).all(...parameters) as unknown as Array<CacheUsageRow & {
      model: string | null;
      request_count: number;
      turn_count: number;
      input_tokens: number | null;
      output_tokens: number | null;
    }>;
    const rows = this.reader.prepare(`
      WITH grouped AS (
        SELECT thread_id, COUNT(DISTINCT turn_id) AS turn_count,
          ${requestOutcomeSql()},
          COUNT(*) AS request_count, SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens, ${cacheUsageSql}, MAX(id) AS latest_id,
          MIN(request_started_at_ms) AS first_request_started_at_ms,
          MAX(recorded_at_ms) AS last_recorded_at_ms
        FROM model_request_metrics
        WHERE thread_id IN (SELECT relation.thread_id FROM subagent_threads AS relation ${relationFilter})
        GROUP BY thread_id
      )
      SELECT relation.*, grouped.turn_count, grouped.request_count,
        grouped.completed_request_count, grouped.interrupted_request_count,
        grouped.failed_request_count, grouped.incomplete_request_count,
        grouped.input_tokens, grouped.output_tokens, grouped.known_cached_input_tokens,
        grouped.cache_observed_input_tokens, grouped.cache_missing_request_count,
        grouped.first_request_started_at_ms, grouped.last_recorded_at_ms,
        latest.provider, latest.model, latest.reasoning_effort
      FROM subagent_threads AS relation
      LEFT JOIN grouped ON grouped.thread_id = relation.thread_id
      LEFT JOIN model_request_metrics AS latest ON latest.id = grouped.latest_id
      ${relationFilter}
      ORDER BY grouped.${sortColumn} IS NULL ASC, grouped.${sortColumn} ${direction}, relation.thread_id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, ...parameters, query.limit, offset) as unknown as Array<CacheUsageRow & RequestOutcomeRow & {
      thread_id: string;
      parent_thread_id: string;
      parent_turn_id: string | null;
      agent_path: string;
      recorded_at_ms: number;
      provider: string | null;
      model: string | null;
      reasoning_effort: string | null;
      turn_count: number | null;
      request_count: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      first_request_started_at_ms: number | null;
      last_recorded_at_ms: number | null;
    }>;
    const counts = this.directSubagentCounts(rows.map((row) => row.thread_id));
    return {
      subagents: rows.map((row) => ({
          threadId: row.thread_id,
          parentThreadId: row.parent_thread_id,
          parentTurnId: row.parent_turn_id,
          agentPath: row.agent_path,
          recordedAtMs: row.recorded_at_ms,
          directSubagentCount: counts.get(row.thread_id) ?? 0,
          provider: row.provider,
          model: row.model,
          reasoningEffort: row.reasoning_effort,
          turnCount: row.turn_count ?? 0,
          requestCount: row.request_count ?? 0,
          requestOutcomes: toStoredRequestOutcomes(row),
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          firstRequestStartedAtMs: row.first_request_started_at_ms,
          lastRecordedAtMs: row.last_recorded_at_ms,
          cacheUsage: row.request_count === null
            ? { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 0 }
            : toStoredCacheUsage(row),
      })),
      summary: {
        requestCount: summary.request_count,
        requestOutcomes: toStoredRequestOutcomes(summary),
        turnCount: summary.turn_count,
        inputTokens: summary.input_tokens ?? 0,
        outputTokens: summary.output_tokens ?? 0,
        cacheUsage: summary.request_count === 0
          ? { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 0 }
          : toStoredCacheUsage(summary),
      },
      modelUsage: modelUsageRows.map((row) => ({
        model: row.model,
        requestCount: row.request_count,
        turnCount: row.turn_count,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        cacheUsage: toStoredCacheUsage(row),
      })),
      total,
      offset,
      limit: query.limit,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    };
  }

  directSubagentCounts(threadIds: string[]): Map<string, number> {
    if (threadIds.length === 0) return new Map();
    const rows = this.reader.prepare(`
      SELECT parent_thread_id, COUNT(*) AS total FROM subagent_threads
      WHERE parent_thread_id IN (${threadIds.map(() => "?").join(", ")})
      GROUP BY parent_thread_id
    `).all(...threadIds) as Array<{ parent_thread_id: string; total: number }>;
    return new Map(rows.map((row) => [row.parent_thread_id, row.total]));
  }

  turnDirectSubagentCounts(threadId: string, turnIds: string[]): Map<string, number> {
    if (turnIds.length === 0) return new Map();
    const rows = this.reader.prepare(`
      SELECT child.parent_turn_id, COUNT(DISTINCT child.thread_id) AS total
      FROM subagent_turns AS child
      JOIN subagent_threads AS relation
        ON relation.thread_id = child.thread_id AND relation.parent_thread_id = child.parent_thread_id
      WHERE child.parent_thread_id = ?
        AND child.parent_turn_id IN (${turnIds.map(() => "?").join(", ")})
      GROUP BY child.parent_turn_id
    `).all(threadId, ...turnIds) as Array<{ parent_turn_id: string; total: number }>;
    return new Map(rows.map((row) => [row.parent_turn_id, row.total]));
  }

  subagentThread(threadId: string): {
    agentPath: string | null;
    parentThreadId: string | null;
    parentTurnId: string | null;
  } {
    this.reader.requireOpen();
    if (!threadId.trim() || threadId.length > 128) {
      throw new Error("Thread ID 无效");
    }
    const row = this.reader.prepare(`
      SELECT agent_path, parent_thread_id, parent_turn_id
      FROM subagent_threads
      WHERE thread_id = ?
    `).get(threadId) as {
      agent_path: string;
      parent_thread_id: string;
      parent_turn_id: string | null;
    } | undefined;
    return {
      agentPath: row?.agent_path ?? null,
      parentThreadId: row?.parent_thread_id ?? null,
      parentTurnId: row?.parent_turn_id ?? null,
    };
  }

  subagentThreadsAfter(
    recordedAtMs: number,
    afterThreadId?: string,
  ): StoredSubagentThreadRecord[] {
    this.reader.requireOpen();
    if (!Number.isInteger(recordedAtMs) || recordedAtMs < 0) {
      throw new Error("子代理同步水位必须是大于等于 0 的整数");
    }
    if (afterThreadId !== undefined && afterThreadId.length === 0) {
      throw new Error("子代理同步游标 Thread ID 不能为空");
    }
    const rows = this.reader.prepare(`
      SELECT thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms
      FROM subagent_threads
      WHERE recorded_at_ms > ? OR (recorded_at_ms = ? AND thread_id > ?)
      ORDER BY recorded_at_ms ASC, thread_id ASC
      LIMIT 1000
    `).all(recordedAtMs, recordedAtMs, afterThreadId ?? "") as unknown as Array<{
      thread_id: string;
      parent_thread_id: string;
      parent_turn_id: string | null;
      agent_path: string;
      recorded_at_ms: number;
    }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      parentThreadId: row.parent_thread_id,
      parentTurnId: row.parent_turn_id,
      agentPath: row.agent_path,
      recordedAtMs: row.recorded_at_ms,
    }));
  }
}
