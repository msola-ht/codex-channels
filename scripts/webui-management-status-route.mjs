import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { readAppServerUserAgent } from "../runtime/app-server-read.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { RequestMetricsQueryService } from "../dist/observability/index.js";
import { metricsRange } from "./metrics-database-access.mjs";
import { runtimeConfig } from "./runtime-config.mjs";
import { readManagedServiceErrorAsync } from "./service-status.mjs";
import { sendManagementJson } from "./webui-http.mjs";
import {
  loadServiceStatusSummary,
  serviceVersion,
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
    await handleUpstreamUserAgent(
      environment,
      response,
      state.appServerUserAgentCache,
      gatewayVersion,
      openMetricsStore,
    );
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
    healthy: platform === null ? null : entries.every((service) => service.running),
    entries,
  });
}

/**
 * 模型上游实际收到的 User-Agent：配置了 `[codex].upstream_user_agent` 时以配置为准且不探测
 * App Server，否则以短缓存读取 App Server 生成的进程级 UA。应答同时携带最近一条指标记录实际
 * 发出的 UA，供界面判断配置是否已在运行中的服务里生效。App Server 未运行时不视为接口失败。
 */
async function handleUpstreamUserAgent(
  environment,
  response,
  cache,
  gatewayVersion,
  openMetricsStore,
) {
  const paths = runtimeConfig(environment);
  const document = readGatewayConfig(paths.configPath);
  const codex = document.codex;
  const configured = typeof codex.upstream_user_agent === "string"
    ? codex.upstream_user_agent
    : null;
  const appServerUserAgent = configured !== null
    ? null
    : await cachedAppServerUserAgent(document, paths.dataDir, cache, gatewayVersion);
  const effectiveUserAgent = configured ?? appServerUserAgent;
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

async function cachedAppServerUserAgent(document, dataDir, cache, gatewayVersion) {
  if (cache.expiresAtMs > Date.now()) return cache.value;
  const value = await readAppServerUserAgent({
    socketPath: resolvePrimaryAppServerSocketPath(document, dataDir),
    codexBinary: document.codex.binary,
    clientInfo: {
      name: "codex_app_server_daemon",
      title: "Codex Connect WebUI",
      version: gatewayVersion,
    },
  }).catch(() => null);
  cache.value = value;
  cache.expiresAtMs = Date.now() + appServerUserAgentCacheTtlMs;
  return value;
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
