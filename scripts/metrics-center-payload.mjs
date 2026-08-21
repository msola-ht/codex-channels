const deviceIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const maximumRequestMetrics = 500;
const maximumSubagentThreads = 1_000;

export function parseIngestPayload(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "请求体必须是 JSON 对象" };
  }
  const { deviceId, deviceName, requestMetrics, subagentThreads } = body;
  if (typeof deviceId !== "string" || !deviceIdPattern.test(deviceId)) {
    return { ok: false, error: "deviceId 无效" };
  }
  if (
    deviceName !== undefined
    && (typeof deviceName !== "string" || deviceName.length > 128)
  ) {
    return { ok: false, error: "deviceName 必须是 128 字符以内的字符串" };
  }
  if (!Array.isArray(requestMetrics) || !Array.isArray(subagentThreads)) {
    return { ok: false, error: "requestMetrics 与 subagentThreads 必须是数组" };
  }
  if (requestMetrics.length > maximumRequestMetrics) {
    return { ok: false, error: `requestMetrics 最多 ${maximumRequestMetrics} 条` };
  }
  if (subagentThreads.length > maximumSubagentThreads) {
    return { ok: false, error: `subagentThreads 最多 ${maximumSubagentThreads} 条` };
  }
  for (const row of requestMetrics) {
    if (!isRequestMetric(row)) {
      return { ok: false, error: "requestMetrics 包含无效记录" };
    }
  }
  for (const row of subagentThreads) {
    if (!isSubagentThread(row)) {
      return { ok: false, error: "subagentThreads 包含无效记录" };
    }
  }
  return {
    ok: true,
    deviceId,
    deviceName: typeof deviceName === "string" && deviceName.trim()
      ? deviceName.trim()
      : undefined,
    requestMetrics,
    subagentThreads,
  };
}

function isRequestMetric(row) {
  return row !== null
    && typeof row === "object"
    && !Array.isArray(row)
    && Number.isInteger(row.localId)
    && row.localId > 0
    && typeof row.provider === "string"
    && row.provider.length > 0
    && Number.isInteger(row.recordedAtMs)
    && row.recordedAtMs > 0;
}

function isSubagentThread(row) {
  return row !== null
    && typeof row === "object"
    && !Array.isArray(row)
    && typeof row.threadId === "string"
    && row.threadId.length > 0
    && row.threadId.length <= 128
    && (row.parentThreadId === null || typeof row.parentThreadId === "string")
    && (row.parentTurnId === undefined
      || row.parentTurnId === null
      || (typeof row.parentTurnId === "string"
        && row.parentTurnId.length > 0
        && row.parentTurnId.length <= 128))
    && (row.agentPath === null || typeof row.agentPath === "string")
    && Number.isInteger(row.recordedAtMs)
    && row.recordedAtMs > 0;
}
