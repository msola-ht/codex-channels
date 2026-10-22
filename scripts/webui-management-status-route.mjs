import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { effectiveCodexBinary } from "../runtime/executable.mjs";
import { closePendingAppServerReads, readAppServerUserAgent } from "../runtime/app-server-read.mjs";
import { readGatewayConfig, validateCodexConfigDocument } from "../runtime/gateway-config.mjs";
import { resolveCodexRequestIdentity } from "../runtime/codex-request-identity.mjs";
import { invalidSetting } from "./config-management-error.mjs";
import { RequestMetricsQueryService } from "../dist/observability/index.js";
import { metricsRange } from "./metrics-database-access.mjs";
import { runtimeConfig } from "./runtime-config.mjs";
import { readManagedServiceErrorAsync } from "./service-status.mjs";
import { sendManagementJson } from "./webui-http.mjs";
import {
  loadServiceStatusSummary,
  serviceVersion,
  serviceSummaryHealthy,
} from "./webui-service-status.mjs";

const appServerUserAgentCacheTtlMs = 5_000;

export async function routeStatusManagement({
  codexCliVersion,
  environment,
  gatewayVersion,
  openMetricsStore,
  path,
  request,
  response,
  state,
}) {
  if (path === "/services" && request.method === "GET") {
    await handleServices(
      environment,
      response,
      state.serviceStatusCache,
      gatewayVersion,
      codexCliVersion,
    );
    return true;
  }
  if (path === "/upstream-user-agent" && request.method === "GET") {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    if (request.aborted || response.destroyed) abort();
    try {
      await handleUpstreamUserAgent(
        environment, response, state.appServerUserAgentCache,
        gatewayVersion, openMetricsStore, controller.signal,
      );
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
    return true;
  }
  return false;
}

async function handleServices(
  environment,
  response,
  serviceStatusCache,
  gatewayVersion,
  codexCliVersion,
) {
  const serviceResults = await loadServiceStatusSummary(environment, serviceStatusCache);
  const platform = serviceResults.find((result) => result.platform !== null)?.platform ?? null;
  const entries = await Promise.all(serviceResults.map(async (result) => ({
    ...result.entry,
    identifier: result.entry.identifier ?? null,
    version: serviceVersion(result.entry.target, { gatewayVersion, codexCliVersion }),
    recentError: await readManagedServiceErrorAsync({
      environment,
      target: result.entry.target,
    }),
  })));
  sendManagementJson(response, 200, {
    observedAt: new Date().toISOString(),
    available: platform !== null,
    platform,
    healthy: serviceSummaryHealthy(entries, platform, environment),
    entries,
  });
}

/**
 * 模型上游预期使用的 User-Agent：配置了 `[codex].upstream_user_agent` 时解析生效版本且不探测
 * App Server，否则以短缓存读取 App Server 生成的进程级 UA。应答同时携带最近一条指标记录实际
 * 发出的 UA，供界面判断配置是否已在运行中的服务里生效。App Server 未运行时不视为接口失败。
 */
async function handleUpstreamUserAgent(
  environment,
  response,
  cache,
  gatewayVersion,
  openMetricsStore,
  signal,
) {
  const paths = runtimeConfig(environment);
  const document = readGatewayConfig(paths.configPath);
  const codex = validateCodexConfigDocument(document.codex ?? {});
  const { upstreamUserAgent } = resolveCodexRequestIdentity(codex);
  if (upstreamUserAgent !== undefined && upstreamUserAgent.length > 512) {
    throw invalidSetting("value.upstreamUserAgent", "too-long", "上游 User-Agent 更新 Codex 版本后超过 512 个字符，请缩短系统或终端信息");
  }
  const configured = typeof codex.upstream_user_agent === "string"
    ? codex.upstream_user_agent
    : null;
  const appServerUserAgent = configured !== null
    ? null
    : await cachedAppServerUserAgent(document, paths.dataDir, cache, gatewayVersion, signal,
      effectiveCodexBinary(codex.binary, environment));
  signal.throwIfAborted();
  const effectiveUserAgent = upstreamUserAgent ?? appServerUserAgent;
  const recentRequest = latestRecordedUserAgent(environment, openMetricsStore);
  sendManagementJson(response, 200, {
    observedAt: new Date().toISOString(),
    configuredUserAgent: configured,
    appServerUserAgent,
    effectiveUserAgent,
    source: configured !== null ? "override" : (appServerUserAgent === null ? "unavailable" : "app-server"),
    recentRequestUserAgent: recentRequest?.userAgent ?? null,
    recentRequestAtMs: recentRequest?.recordedAtMs ?? null,
  });
}

async function cachedAppServerUserAgent(document, dataDir, cache, gatewayVersion, signal, codexBinary) {
  signal.throwIfAborted();
  if (cache.closed) throw new Error("WebUI 正在关闭");
  const socketPath = resolvePrimaryAppServerSocketPath(document, dataDir);
  const key = JSON.stringify([socketPath, codexBinary, gatewayVersion]);
  if (cache.key === key && cache.expiresAtMs > Date.now()) return cache.value;
  // Retire the previous target before allocating another owned transport.
  if (cache.pending && (cache.pending.key !== key || cache.pending.controller.signal.aborted)) {
    cache.pending.controller.abort();
    await cache.pending.promise;
    return cachedAppServerUserAgent(document, dataDir, cache, gatewayVersion, signal, codexBinary);
  }
  if (!cache.pending) {
    const entry = { key, controller: new AbortController(), subscribers: 0 };
    cache.pending = entry;
    entry.promise = readAppServerUserAgent({
      socketPath,
      codexBinary,
      clientInfo: { name: "codex_app_server_daemon", title: "Codex Connect WebUI", version: gatewayVersion },
      signal: entry.controller.signal,
    }).catch(() => null).then(value => {
      if (!entry.controller.signal.aborted && !cache.closed) {
        cache.key = key;
        cache.value = value;
        cache.expiresAtMs = Date.now() + appServerUserAgentCacheTtlMs;
      }
      return value;
    }).finally(() => {
      if (cache.pending === entry) cache.pending = undefined;
    });
  }
  const entry = cache.pending;
  entry.subscribers += 1;
  let abort;
  try {
    return await Promise.race([entry.promise, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally {
    signal.removeEventListener("abort", abort);
    entry.subscribers -= 1;
    if (entry.subscribers === 0 && cache.pending === entry) entry.controller.abort();
  }
}

export async function closeAppServerUserAgentReads(cache) {
  cache.closed = true;
  cache.pending?.controller.abort();
  await cache.pending?.promise;
  await closePendingAppServerReads();
}

/** 最近一条模型请求实际发往上游的 UA；指标库不可用或还没有请求时返回 null。 */
function latestRecordedUserAgent(environment, openMetricsStore) {
  let store;
  try {
    store = openMetricsStore(environment);
    const range = metricsRange("all", Date.now());
    const page = new RequestMetricsQueryService(store).page(range, {
      offset: 0,
      limit: 1,
      sortKey: "recordedAtMs",
      sortDirection: "desc",
    });
    const record = page.records[0];
    return record === undefined
      ? null
      : {
          userAgent: record.userAgent ?? null,
          recordedAtMs: record.recordedAtMs ?? null,
        };
  } catch {
    return null;
  } finally {
    store?.close();
  }
}
