import { parseIngestPayload } from "./payload.js";

const maximumStatementsPerBatch = 50;
const maximumListLimit = 200;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders({
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
        }),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/ingest") {
      return handleIngest(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/overview") {
      return handleOverview(env);
    }
    if (request.method === "GET" && url.pathname === "/api/requests") {
      return handleRequests(url, env);
    }
    if (request.method === "GET" && url.pathname === "/api/subagents") {
      return handleSubagents(url, env);
    }
    if (request.method === "GET" && url.pathname === "/api/devices") {
      return handleDevices(env);
    }
    return jsonResponse({ error: "not found" }, 404);
  },
};

async function handleIngest(request, env) {
  const expected = `Bearer ${env.INGEST_TOKEN ?? ""}`;
  const actual = request.headers.get("authorization") ?? "";
  if (!constantTimeEqual(actual, expected)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "请求体不是有效 JSON" }, 400);
  }
  const parsed = parseIngestPayload(body);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400);
  }

  const nowMs = Date.now();
  const statements = [];
  for (const row of parsed.requestMetrics) {
    statements.push(env.DB.prepare(insertRequestMetricSql).bind(
      parsed.deviceId,
      row.localId,
      row.recordedAtMs,
      row.provider ?? null,
      row.model ?? null,
      row.status ?? null,
      row.operation ?? null,
      row.threadId ?? null,
      row.turnId ?? null,
      row.inputTokens ?? null,
      row.cachedInputTokens ?? null,
      row.outputTokens ?? null,
      row.reasoningOutputTokens ?? null,
      row.totalTokens ?? null,
      row.cacheHitRate ?? null,
      row.pricing?.currency ?? null,
      row.totalCostNanos ?? null,
      JSON.stringify(row),
      nowMs,
    ));
  }
  for (const row of parsed.subagentThreads) {
    statements.push(env.DB.prepare(insertSubagentThreadSql).bind(
      parsed.deviceId,
      row.threadId,
      row.parentThreadId ?? null,
      row.parentTurnId ?? null,
      row.agentPath ?? null,
      row.recordedAtMs,
      nowMs,
    ));
  }
  statements.push(env.DB.prepare(upsertDeviceSql).bind(
    parsed.deviceId,
    nowMs,
    nowMs,
    nowMs,
  ));

  const results = [];
  for (let start = 0; start < statements.length; start += maximumStatementsPerBatch) {
    const batch = statements.slice(start, start + maximumStatementsPerBatch);
    const chunk = await env.DB.batch(batch);
    results.push(...chunk);
  }
  const insertedRequests = results
    .slice(0, parsed.requestMetrics.length)
    .reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  const insertedSubagents = results
    .slice(parsed.requestMetrics.length, parsed.requestMetrics.length + parsed.subagentThreads.length)
    .reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  return jsonResponse({
    ok: true,
    deviceId: parsed.deviceId,
    insertedRequests,
    insertedSubagents,
  });
}

async function handleOverview(env) {
  const [totals, costs, providers] = await Promise.all([
    env.DB.prepare(overviewSql).all(),
    env.DB.prepare(costsByCurrencySql).all(),
    env.DB.prepare(providerTotalsSql).all(),
  ]);
  return jsonResponse({
    totals: totals.results[0] ?? null,
    costsByCurrency: costs.results,
    providers: providers.results,
  });
}

async function handleRequests(url, env) {
  const limit = clampLimit(url.searchParams.get("limit"), 50);
  const offset = clampOffset(url.searchParams.get("offset"));
  const deviceId = url.searchParams.get("device") ?? "";
  const provider = url.searchParams.get("provider") ?? "";
  const status = url.searchParams.get("status") ?? "";
  const clauses = [];
  const params = [];
  if (deviceId) {
    clauses.push("device_id = ?");
    params.push(deviceId);
  }
  if (provider) {
    clauses.push("provider = ?");
    params.push(provider);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT device_id, local_id, recorded_at_ms, provider, model, status, operation,
            input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
            total_tokens, cache_hit_rate, pricing_currency, total_cost_nanos
     FROM request_metrics
     ${where}
     ORDER BY recorded_at_ms DESC, device_id ASC, local_id DESC
     LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset).all();
  return jsonResponse({ requests: rows.results });
}

async function handleSubagents(url, env) {
  const limit = clampLimit(url.searchParams.get("limit"), 50);
  const offset = clampOffset(url.searchParams.get("offset"));
  const deviceId = url.searchParams.get("device") ?? "";
  const params = deviceId ? [deviceId] : [];
  const where = deviceId ? "WHERE device_id = ?" : "";
  const rows = await env.DB.prepare(
    `SELECT device_id, thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms
     FROM subagent_threads
     ${where}
     ORDER BY recorded_at_ms DESC, thread_id DESC
     LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset).all();
  return jsonResponse({ subagents: rows.results });
}

async function handleDevices(env) {
  const rows = await env.DB.prepare(
    `SELECT d.device_id, d.first_seen_at_ms, d.last_seen_at_ms, d.last_ingested_at_ms,
            (SELECT COUNT(*) FROM request_metrics r WHERE r.device_id = d.device_id)
              AS request_count,
            (SELECT COUNT(*) FROM subagent_threads s WHERE s.device_id = d.device_id)
              AS subagent_count
     FROM devices d
     ORDER BY d.last_seen_at_ms DESC`,
  ).all();
  return jsonResponse({ devices: rows.results });
}

const insertRequestMetricSql = `
  INSERT OR IGNORE INTO request_metrics
    (device_id, local_id, recorded_at_ms, provider, model, status, operation,
     thread_id, turn_id, input_tokens, cached_input_tokens, output_tokens,
     reasoning_output_tokens, total_tokens, cache_hit_rate, pricing_currency,
     total_cost_nanos, payload, ingested_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const insertSubagentThreadSql = `
  INSERT INTO subagent_threads
    (device_id, thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms, ingested_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, thread_id) DO UPDATE SET
    parent_thread_id = excluded.parent_thread_id,
    parent_turn_id = COALESCE(
      excluded.parent_turn_id,
      subagent_threads.parent_turn_id
    ),
    agent_path = excluded.agent_path,
    recorded_at_ms = excluded.recorded_at_ms,
    ingested_at_ms = excluded.ingested_at_ms
`;

const upsertDeviceSql = `
  INSERT INTO devices (device_id, first_seen_at_ms, last_seen_at_ms, last_ingested_at_ms)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(device_id) DO UPDATE SET
    last_seen_at_ms = excluded.last_seen_at_ms,
    last_ingested_at_ms = excluded.last_ingested_at_ms
`;

const overviewSql = `
  SELECT
    (SELECT COUNT(*) FROM devices) AS device_count,
    (SELECT COUNT(*) FROM request_metrics) AS request_count,
    (SELECT COUNT(*) FROM subagent_threads) AS subagent_count,
    COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
    COALESCE(SUM(total_tokens), 0) AS total_tokens,
    MAX(recorded_at_ms) AS last_recorded_at_ms
  FROM request_metrics
`;

const costsByCurrencySql = `
  SELECT COALESCE(pricing_currency, 'unknown') AS currency,
         COUNT(*) AS request_count,
         COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
  FROM request_metrics
  GROUP BY pricing_currency
  ORDER BY request_count DESC
`;

const providerTotalsSql = `
  SELECT provider,
         COUNT(*) AS request_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens
  FROM request_metrics
  GROUP BY provider
  ORDER BY request_count DESC
  LIMIT 50
`;

function clampLimit(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, maximumListLimit);
}

function clampOffset(raw) {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }),
  });
}

function corsHeaders(headers) {
  return {
    ...headers,
    "access-control-allow-origin": "*",
    "access-control-max-age": "86400",
  };
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
