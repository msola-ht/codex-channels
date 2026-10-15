import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { ModelRequestMetricsScope } from "./request-metrics.js";

/** 查询组件共用的 Store 读取端口，不持有连接、事务或写入口。 */
export interface MetricsQueryReader {
  prepare: DatabaseSync["prepare"];
  iterateRows(sql: string, ...parameters: SQLInputValue[]): Iterable<Record<string, SQLOutputValue>>;
  requireOpen(): void;
}

export const observableCompletionSql = "status = 'completed'";
export const interruptedRequestSql = `NOT (${observableCompletionSql}) AND COALESCE(
  CASE WHEN source = 'relay' THEN error_code ELSE error_type END = 'client_disconnected', 0)`;
export const normalizedStatusSql = "status";
export const compactAggregateSql = `
  ${requestOutcomeSql("operation = 'compact'", "compact_")},
  COUNT(CASE WHEN operation = 'compact' THEN 1 END) AS compact_request_count,
  SUM(CASE WHEN operation = 'compact' AND NOT (${observableCompletionSql})
    THEN 1 ELSE 0 END) AS compact_unsuccessful_request_count,
  MIN(CASE WHEN operation = 'compact' THEN model END) AS compact_model,
  COUNT(DISTINCT CASE WHEN operation = 'compact' THEN model END)
    AS compact_model_count,
  SUM(CASE WHEN operation = 'compact' THEN input_tokens END)
    AS compact_input_tokens,
  SUM(CASE WHEN operation = 'compact' THEN cached_input_tokens END)
    AS compact_cached_input_tokens,
  COUNT(CASE WHEN operation = 'compact' THEN input_tokens END)
    AS compact_input_token_count,
  COUNT(CASE WHEN operation = 'compact' THEN cached_input_tokens END)
    AS compact_cached_input_token_count,
  SUM(CASE WHEN operation = 'compact' THEN output_tokens END)
    AS compact_output_tokens
`;
export const cacheUsageSql = `
  SUM(CASE WHEN input_tokens IS NOT NULL THEN cached_input_tokens END) AS known_cached_input_tokens,
  SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN input_tokens END) AS cache_observed_input_tokens,
  SUM(CASE WHEN input_tokens IS NULL OR cached_input_tokens IS NULL THEN 1 ELSE 0 END) AS cache_missing_request_count
`;
export const metricsAggregateSql = `
  ${requestOutcomeSql()},
  ${cacheUsageSql},
  COUNT(*) AS request_count,
  SUM(CASE WHEN ${observableCompletionSql} THEN 0 ELSE 1 END) AS unsuccessful_request_count,
  SUM(input_tokens) AS input_tokens,
  SUM(cached_input_tokens) AS cached_input_tokens,
  COUNT(input_tokens) AS input_token_count,
  COUNT(cached_input_tokens) AS cached_input_token_count,
  COUNT(CASE WHEN input_tokens IS NOT NULL THEN cached_input_tokens END) AS cache_observed_request_count,
  SUM(output_tokens) AS output_tokens,
  SUM(reasoning_output_tokens) AS reasoning_output_tokens,
  ${compactAggregateSql}
`;

export function requestOutcomeSql(condition = "1", prefix = ""): string {
  const interrupted = interruptedRequestSql;
  const failed = `NOT (${observableCompletionSql}) AND status = 'failed'
    AND NOT (${interruptedRequestSql})`;
  const incomplete = `NOT (${observableCompletionSql}) AND status <> 'failed'
    AND NOT (${interruptedRequestSql})`;
  return [
    ["completed", observableCompletionSql], ["interrupted", interrupted],
    ["failed", failed], ["incomplete", incomplete],
  ].map(([name, predicate]) => `COUNT(CASE WHEN (${condition}) AND (${predicate}) THEN 1 END)
    AS ${prefix}${name}_request_count`).join(", ");
}

export function metricsPageOffset(query: { offset?: number; limit: number }): number {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
    throw new Error("模型请求指标分页数量必须在 1 到 500 之间");
  }
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("模型请求指标分页偏移无效");
  return offset;
}

export function metricsScopeSql(query: ModelRequestMetricsScope, selectThreadRoot = false): { sql: string; params: Array<string | number> } {
  validateMetricsTimeRange(query);
  const conditions = ["recorded_at_ms >= ?", "recorded_at_ms < ?"];
  const params: Array<string | number> = [query.startAtMs, query.endAtMs];
  if (query.requestPurpose !== undefined) {
    if (query.requestPurpose !== "autoApprovalReview") throw new Error("requestPurpose 筛选值无效");
    conditions.push("request_purpose = ?");
    params.push(query.requestPurpose);
  }
  for (const [key, column] of [
    ["threadId", "thread_id"], ["turnId", "turn_id"],
    ["model", "model"], ["source", "source"], ["callerId", "caller_id"],
    ["operation", "operation"], ["status", `(${normalizedStatusSql})`],
  ] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (!value.trim() || value.length > 128) throw new Error(`${key} 筛选值无效`);
    if (selectThreadRoot && key === "threadId" && query.turnId === undefined) continue;
    conditions.push(`${column} = ?`);
    params.push(value);
  }
  if (query.provider !== undefined) {
    const providers = Array.isArray(query.provider) ? query.provider : [query.provider];
    if (providers.length === 0 || providers.some((value) => !value.trim() || value.length > 128)) throw new Error("provider 筛选值无效");
    conditions.push(`provider IN (${providers.map(() => "?").join(", ")})`);
    params.push(...providers);
  }
  if (query.turnId !== undefined && query.threadId === undefined) throw new Error("查询 Turn 必须同时指定 Thread ID");
  if (query.operation !== undefined && !["response", "compact"].includes(query.operation)) throw new Error("operation 筛选值无效");
  if (query.status !== undefined && !["completed", "failed", "incomplete", "unknown"].includes(query.status)) throw new Error("status 筛选值无效");
  if (query.source !== undefined && !["owned", "relay"].includes(query.source)) throw new Error("source 筛选值无效");
  if (query.onlyFailures) conditions.push(`NOT (${observableCompletionSql})`);
  const filter = query.filter?.trim() ?? "";
  if (filter.length > 128) throw new Error("模型请求指标筛选关键字最多 128 个字符");
  if (filter !== "") {
    const columns = ["thread_id", "turn_id", "provider", "model", "operation", "status", "error_type", "error_code", "error_message"];
    conditions.push(`(${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    const pattern = `%${filter.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
    params.push(...columns.map(() => pattern));
  }
  return { sql: conditions.join(" AND "), params };
}

export function validateThreadId(value: string, label: string): void {
  if (!value.trim() || value.length > 128) {
    throw new Error(`${label}无效`);
  }
}

export function validateMetricsTimeRange(
  query: { startAtMs: number; endAtMs: number },
): void {
  if (
    !Number.isSafeInteger(query.startAtMs)
    || !Number.isSafeInteger(query.endAtMs)
    || query.startAtMs < 0
    || query.endAtMs <= query.startAtMs
  ) {
    throw new Error("模型请求指标时间范围无效");
  }
}
