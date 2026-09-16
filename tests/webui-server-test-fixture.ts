import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { createWebuiServer } from "../scripts/webui-server.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
import {
  requestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
  type ModelRequestMetricSample,
} from "../src/observability/index.js";

export interface WebuiTestServer {
  close: () => Promise<void>;
}

export interface WebuiTestServerOptions {
  host?: string
  token?: string
  managementOrigin?: string
  loadProviderState?: (options: { environment: NodeJS.ProcessEnv }) => Promise<unknown>
  loadCodexSettings?: (options: { environment: NodeJS.ProcessEnv }) => Promise<unknown>
  previewCodexSetting?: (input: unknown, options: { environment: NodeJS.ProcessEnv; expectedVersion: string }) => Promise<unknown>
  updateCodexSetting?: (input: unknown, options: { environment: NodeJS.ProcessEnv; expectedVersion: string }) => Promise<unknown>
  previewProviderSettings?: (input: unknown, environment: NodeJS.ProcessEnv) => Promise<unknown>
  applyProviderSettings?: (input: unknown, environment: NodeJS.ProcessEnv, preview: unknown) => Promise<unknown>
  loadAccountSettings?: (environment: NodeJS.ProcessEnv) => Promise<unknown>
  previewAccountSettings?: (input: unknown, environment: NodeJS.ProcessEnv) => Promise<unknown>
  applyAccountSettings?: (input: unknown, environment: NodeJS.ProcessEnv, preview: unknown) => Promise<unknown>
  refreshGatewayAccount?: (configPath: string, provider: string) => Promise<unknown>
}

export async function cleanupWebuiTestFixtures(
  servers: WebuiTestServer[],
  temporaryDirectories: string[],
) {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function createWebuiTestFixture(temporaryDirectories: string[]) {
  const home = mkdtempSync(join(tmpdir(), "codexc-webui-"));
  temporaryDirectories.push(home);
  const environment = {
    ...process.env,
    CODEX_HOME: home,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  initializeUserData({ environment, cwd: home });
  return {
    databasePath: requestMetricsDatabasePath(join(home, "data", "gateway.sqlite3")),
    environment,
    home,
  };
}

export function createWebuiStaticDir(temporaryDirectories: string[], content: string) {
  const directory = mkdtempSync(join(tmpdir(), "codexc-webui-static-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "index.html"), content);
  return directory;
}

export async function startWebuiTestServer(
  servers: WebuiTestServer[],
  environment: NodeJS.ProcessEnv,
  staticDir?: string,
  options: WebuiTestServerOptions = {},
) {
  const { server } = createWebuiServer({
    environment,
    ...(staticDir === undefined ? {} : { staticDir }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.managementOrigin === undefined ? {} : { managementOrigin: options.managementOrigin }),
    ...(options.loadProviderState === undefined ? {} : { loadProviderState: options.loadProviderState }),
    ...(options.loadCodexSettings === undefined ? {} : { loadCodexSettings: options.loadCodexSettings }),
    ...(options.previewCodexSetting === undefined ? {} : { previewCodexSetting: options.previewCodexSetting }),
    ...(options.updateCodexSetting === undefined ? {} : { updateCodexSetting: options.updateCodexSetting }),
    ...(options.previewProviderSettings === undefined ? {} : { previewProviderSettings: options.previewProviderSettings }),
    ...(options.applyProviderSettings === undefined ? {} : { applyProviderSettings: options.applyProviderSettings }),
    ...(options.loadAccountSettings === undefined ? {} : { loadAccountSettings: options.loadAccountSettings }),
    ...(options.previewAccountSettings === undefined ? {} : { previewAccountSettings: options.previewAccountSettings }),
    ...(options.applyAccountSettings === undefined ? {} : { applyAccountSettings: options.applyAccountSettings }),
    ...(options.refreshGatewayAccount === undefined ? {} : { refreshGatewayAccount: options.refreshGatewayAccount }),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, options.host ?? "127.0.0.1", resolve);
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
  };
}

export function recordSample(databasePath: string, sample: ModelRequestMetricSample) {
  const store = new SqliteModelRequestMetricsStore(databasePath);
  try {
    store.record(sample);
  } finally {
    store.close();
  }
}

export function metricSample(): ModelRequestMetricSample {
  return {
    provider: "deepseek",
    transport: "http",
    responseFormat: "sse",
    operation: "response",
    threadId: "thread-1",
    turnId: "turn-1",
    model: "deepseek-v4-flash",
    serviceTier: "default",
    reasoningEffort: "max",
    status: "completed",
    httpStatus: 200,
    errorType: null,
    errorCode: null,
    errorMessage: null,
    incompleteReason: null,
    inputTokens: 1_000,
    cachedInputTokens: 900,
    outputTokens: 100,
    reasoningOutputTokens: 40,
    totalTokens: 1_100,
    requestStartedAtMs: Date.now() - 60_000,
    responseCompletedAtMs: Date.now() - 55_000,
    weeklyQuota: null,
  };
}
