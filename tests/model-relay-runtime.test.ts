import { relayModelId } from "../runtime/model-relay-model-id.mjs";
import * as catalogUpdate from "../runtime/cline-relay-catalog-update.mjs";
import * as providerDefinitions from "../runtime/model-provider-definitions.mjs";
import { clineRelayCatalogPath, saveClineRelayCatalog } from "../scripts/cline-relay-catalog.mjs";
// @ts-expect-error JavaScript CLI menu intentionally has no declaration file.
import { runRelayListenMenu } from "../scripts/model-relay-listen-menu.mjs";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import { readRelayQueue, readRelayManagement, manageModelRelay as sharedManage } from "../scripts/model-relay-management.mjs";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer, globalAgent } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, it, vi } from "vitest";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { startModelRelayService } from "../runtime/model-relay-service.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";
import * as relayControl from "../runtime/model-relay-control.mjs";
import { ModelRelayControl, queryModelRelayControl } from "../runtime/model-relay-control.mjs";
import { manageModelRelay, parseModelRelayCommand, runModelRelayCommand } from "../scripts/model-relay-command.mjs";
import { applyClinePassConfiguration, clinePassSetupPaths } from "../scripts/cline-pass-account-management.mjs";
import * as gatewayConfig from "../runtime/gateway-config.mjs";
import { PrivateIpcServer, createPrivateIpcConnection } from "../runtime/private-ipc.mjs";
import { once } from "node:events";
import { RelayMetricsComposition, createRelayMetricAuthorization } from "../src/bootstrap/relay-metrics-composition.js";
import { BufferedModelRequestMetricsWriter, SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import type { RelayMetric } from "../src/provider-proxy/index.js";
import { loadConfiguredRelayProviderMaterial, writeCustomPrimaryProviderSwitchingProfile } from "../runtime/model-provider-runtime.mjs";
import { writeResponsesModelCatalog, finishResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";

vi.mock("../scripts/model-catalog-validation.mjs", () => ({ validateModelCatalogWithCodex: async () => undefined }));
// Replace only the TLS proxy transport. The selected proxy is an isolated HTTP fixture;
// configuration, private credentials, admission, request serialization and metrics IPC stay real.
vi.mock("https-proxy-agent", async () => {
  const { Agent } = await import("node:https"); const { connect } = await import("node:net");
  return { HttpsProxyAgent: class extends Agent {
    private readonly proxy: URL;
    constructor(proxy: string, options: import("node:https").AgentOptions) { super(options); this.proxy = new URL(proxy); }
    override createConnection() { return connect({ host: "127.0.0.1", port: Number(this.proxy.port) }); }
  } };
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "relay-runtime-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const environment = { CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect"),
    CODEX_CONNECT_CONFIG_FILE: join(root, "connect", "config.toml"), HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "*" };
  const configPath = environment.CODEX_CONNECT_CONFIG_FILE;
  writePrivateFileAtomicSync(configPath, stringify({ version: 1, default_workspace: "main", codex: {},
    telegram: { bot_token: "fixture", allowed_user_ids: [1] }, workspaces: [{ id: "main", name: "Main", cwd: root }] }));
  writePrivateFileAtomicSync(join(environment.CODEX_CONNECT_HOME, "providers", "deepseek", "models.json"), JSON.stringify({ models: [{
    slug: "deepseek-flash", display_name: "Fixture", visibility: "list", supported_in_api: true,
    context_window: 64000, max_context_window: 128000, input_modalities: ["text"],
    default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high", description: "High" }],
    model_messages: { instructions_template: "fixture" },
  }] }));
  writePrivateFileAtomicSync(join(environment.CODEX_HOME, "config.toml"), 'model_provider = "openai"\n');
  await applyClinePassConfiguration({ accountId: "test", apiKey: "sk_fixture-key" }, { environment });
  saveClineRelayCatalog({ version: 1, commit: "a".repeat(40), downloadedAt: 1,
    models: [{ id: "cline-pass/deepseek-v4.1-flash", reasoningOptions: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }] }] }, environment);
  return { configPath, environment };
}

it("uses the configured proxy concurrency and republishes only changed policy", async () => {
  const f = await fixture();
  const held: import("node:http").ServerResponse[] = [];
  const upstream = createHttpServer((request, response) => { request.resume(); request.on("end", () => held.push(response)); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const up = upstream.address(); if (!up || typeof up === "string") throw new Error("fixture");
  writePrivateFileAtomicSync(join(f.environment.CODEX_HOME, ".env"), `HTTPS_PROXY=http://127.0.0.1:${up.port}\nNO_PROXY=\n`);
  const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "batch", "--key", "batch", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("fixture");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const document = parse(readFileSync(f.configPath, "utf8")); Object.assign(document.model_relay!, { enabled: true, port: address.port, max_concurrency: 10 });
  writePrivateFileAtomicSync(f.configPath, stringify(document));
  const { RelayAdmission } = await import("../dist/model-relay/index.js");
  const apply = vi.spyOn(RelayAdmission.prototype, "apply");
  cleanups.push(() => apply.mockRestore());
  const service = await startModelRelayService(f.configPath, f.environment); cleanups.push(() => service.close());
  apply.mockClear();
  await service.refresh(); await service.refresh(); expect(apply).not.toHaveBeenCalled();
  for (const count of [10, 12, 3]) {
    Object.assign(document.model_relay!, { max_concurrency: count });
    writePrivateFileAtomicSync(f.configPath, stringify(document)); await service.refresh();
    held.length = 0;
    const pending = Array.from({ length: count }, () => fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${String(issued.key)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "clp-test/deepseek-v4.1-flash", messages: [{ role: "user", content: "fixture" }] }),
    }).then(async response => { expect(response.status).toBe(200); await response.text(); }));
    await vi.waitFor(() => expect(held).toHaveLength(count), { timeout: 5000 });
    for (const response of held) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    }));
    await Promise.all(pending);
  }
  expect(apply).toHaveBeenCalledTimes(2);
}, 20_000);

it.each(["127.0.0.1", "[::1]"])("uses registered custom Responses material at %s through runtime, captures, authorizes metrics and rolls back only selected references", async host => {
  const f = await fixture();
  const provider = "rs-LocalTest";
  const upstream = createHttpServer((request, response) => {
    expect(request.url).toBe("/v1/responses"); expect(request.headers.authorization).toBe("Bearer fixture-custom-secret");
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const forwarded = JSON.parse(Buffer.concat(chunks).toString());
      expect(forwarded).toMatchObject({ model: "fixture/model", stream: false, store: false, background: false });
      expect(forwarded.input).toHaveLength(300);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "resp_fixture", object: "response", status: "completed", model: "fixture/model", output: [], usage: { input_tokens: 1, output_tokens: 2 } }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const up = upstream.address(); if (!up || typeof up === "string") throw new Error("fixture");
  if (host === "[::1]") {
    // Verify the actual HTTP socket target, then use IPv4 for hosts without IPv6 loopback.
    const original = globalAgent.createConnection;
    const connection = vi.spyOn(globalAgent, "createConnection").mockImplementation((options, callback) => {
      expect(options.host).toBe("::1");
      return original.call(globalAgent, { ...options, host: "127.0.0.1" }, callback);
    });
    cleanups.push(() => connection.mockRestore());
  }
  const catalog = writeResponsesModelCatalog(f.environment, provider, [{ id: "fixture/model", name: "Fixture", contextWindow: 64000,
    reasoningEfforts: [], defaultReasoningEffort: null, supportsImages: true }], "fixture/model");
  finishResponsesModelCatalogWrite(catalog);
  writeCustomPrimaryProviderSwitchingProfile({ provider, model: "fixture/model", baseUrl: `http://${host}:${up.port}/v1`,
    apiKey: "fixture-custom-secret", catalogSource: { kind: "custom", reasoningEffort: null } }, f.environment);
  expect(loadConfiguredRelayProviderMaterial(provider, f.environment)).toMatchObject({ protocols: ["responses"], models: ["fixture/model"], modelInputs: { "fixture/model": ["text", "image"] } });
  expect(readRelayManagement(f.environment).providers).toEqual(expect.arrayContaining([expect.objectContaining({ id: provider, protocols: ["responses"], available: true })]));
  const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "custom", "--key", "custom", "--model", `${provider}/fixture/model`, "--reasoning", "off"]), f.environment);
  expect(readRelayManagement(f.environment).callers.find(caller => caller.caller_id === "custom")?.reasoning).toBe("off");
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("fixture");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const document = parse(readFileSync(f.configPath, "utf8")); Object.assign(document.model_relay!, { port: address.port, enabled: true });
  document.debug = { model_traffic_dump: true };
  writePrivateFileAtomicSync(f.configPath, stringify(document));
  const store = new SqliteModelRequestMetricsStore(join(f.environment.CODEX_CONNECT_HOME, "responses-fixture.sqlite3"));
  const writer = new BufferedModelRequestMetricsWriter(store); cleanups.push(() => writer.close());
  const receiver = new RelayMetricsComposition({ path: modelRelayPaths(f.configPath).metrics, writer,
    authorize: createRelayMetricAuthorization(f.configPath, f.environment) });
  await receiver.apply(true); cleanups.push(() => receiver.close());
  const service = await startModelRelayService(f.configPath, f.environment); cleanups.push(() => service.close());
  const request = () => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${String(issued.key)}`, "content-type": "application/json" }, body: JSON.stringify({ model: `${provider}/fixture/model`, store: true, background: true,
    input: Array.from({ length: 300 }, () => ({ role: "user", content: "fixture" })) }) });
  expect(await (await request()).json()).toMatchObject({ id: "resp_fixture", status: "completed" });
  await vi.waitFor(() => expect(store.count()).toBe(1));
  expect(store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, source: "relay", limit: 10 }).records[0]).toMatchObject({ provider,
    callerId: "custom", status: "completed", traffic: { label: "relay.responses" }, inputTokens: 1, outputTokens: 2 });
  const authorize = createRelayMetricAuthorization(f.configPath, f.environment);
  try { expect(await authorize({ provider, callerId: "custom", keyId: "custom", credentialGeneration: 1,
    source: "relay", threadId: null, turnId: null, relayRequestId: "7d40d091-8c74-4dcf-9e40-71531f3f1a98",
    requestModel: `${provider}/fixture/model`, responseFormat: "json", status: "completed", deliveryStatus: "finished",
    requestStartedAtMs: 1, responseCompletedAtMs: 2, totalDurationMs: 1 })).toBeUndefined(); }
  finally { await authorize.close(); }
  await service.close();

});

it("reads an independent custom primary API credential but never substitutes an OAuth login", async () => {
  const f = await fixture(); const provider = "rs-primary";
  const transaction = writeResponsesModelCatalog(f.environment, provider, [{ id: "fixture/model", name: "Fixture", contextWindow: 64000,
    reasoningEfforts: [], defaultReasoningEffort: null, supportsImages: false }], "fixture/model");
  finishResponsesModelCatalogWrite(transaction);
  const config = { model_provider: provider, model: "fixture/model", model_catalog_json: transaction.path,
    model_providers: { [provider]: { name: "Fixture", base_url: "https://example.test/v1", wire_api: "responses", experimental_bearer_token: "fixture-secret" } } };
  const path = join(f.environment.CODEX_HOME, "config.toml");
  writePrivateFileAtomicSync(path, stringify(config));
  expect(loadConfiguredRelayProviderMaterial(provider, f.environment)).toMatchObject({ apiKey: "fixture-secret", protocols: ["responses"] });
  writePrivateFileAtomicSync(path, stringify({ ...config, model_providers: { [provider]: { ...config.model_providers[provider], requires_openai_auth: true } } }));
  expect(() => loadConfiguredRelayProviderMaterial(provider, f.environment)).toThrow("independent API credentials");
});
it("issues and rotates secrets once, preserves tombstones and configuration backups", async () => {
  const f = await fixture();
  const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
  expect(issued.activation).toBe("saved_not_running");
  const token = String(issued.key);
  const content = readFileSync(f.configPath, "utf8");
  const saved = gatewayConfig.validateGatewayConfigDocument(gatewayConfig.parseGatewayConfig(content)).model_relay;
  const defaultLimits = { max_concurrency: 10, requests_per_minute: 0, burst: 10 };
  expect(saved).toMatchObject(defaultLimits);
  expect(saved).not.toHaveProperty("accounts");
  expect(saved?.callers[0]).not.toHaveProperty("max_concurrency");
  expect(content).not.toContain(token);
  expect(content).toContain(createHash("sha256").update(Buffer.from(token.split(".")[2]!, "base64url")).digest("hex"));
  expect(gatewayConfig.validateGatewayConfigDocument(parse(readFileSync(String(issued.backupPath), "utf8"))).model_relay?.callers ?? []).toEqual([]);
  const failedWrite = vi.spyOn(gatewayConfig, "writeGatewayConfig").mockImplementation(() => { throw new Error("fixture write failure"); });
  try {
    await expect(manageModelRelay(parseModelRelayCommand(["rotate", "--caller", "client"]), f.environment)).rejects.toThrow("fixture write failure");
    expect(readFileSync(f.configPath, "utf8")).toBe(content);
  } finally { failedWrite.mockRestore(); }
  const rotated = await manageModelRelay(parseModelRelayCommand(["rotate", "--caller", "client"]), f.environment);
  expect(rotated.key).not.toBe(token);
  await manageModelRelay(parseModelRelayCommand(["disable", "--caller", "client"]), f.environment);
  const callers = await manageModelRelay(parseModelRelayCommand(["callers"]), f.environment);
  expect(callers).toMatchObject({ callers: [{ caller_id: "client", key_id: "key", credential_generation: 2, enabled: false }] });
  expect(JSON.stringify(callers)).not.toContain("secret");
  await expect(manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "other", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment)).rejects.toThrow("身份已存在");
});
it("owns a private control endpoint; enables, disables, fails closed and recovers without an App Server", async () => {
  const f = await fixture();
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("fixture");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
  const document = parse(readFileSync(f.configPath, "utf8"));
  Object.assign(document.model_relay!, { port: address.port }); writePrivateFileAtomicSync(f.configPath, stringify(document));
  const service = await startModelRelayService(f.configPath, f.environment).catch((cause: unknown) => { throw new Error("initial service startup failed", { cause }); }); cleanups.push(() => service.close());
  expect(service.status()).toEqual({ enabled: false, listening: false });
  expect(await readRelayQueue(f.environment)).toEqual({ state: "running", configurationValid: true, enabled: false, listening: false, requests: [] });
  const malformed = createPrivateIpcConnection(modelRelayPaths(f.configPath).control);
  malformed.on("error", () => {}); await once(malformed, "connect");
  malformed.write('{"version":1,"operation":"status","requestId":{"toString":null}}\n');
  await once(malformed, "close");
  expect(await queryModelRelayControl(modelRelayPaths(f.configPath).control, "status")).toMatchObject({ version: 6, configurationValid: true, queue: { pending: 0, waiting: 0, bytes: 0 } });
  await expect(startModelRelayService(f.configPath, f.environment)).rejects.toThrow();
  expect(await manageModelRelay(parseModelRelayCommand(["enable"]), f.environment)).toMatchObject({ activation: "saved_and_applied" });
  expect(await readRelayQueue(f.environment)).toMatchObject({ configurationValid: true, enabled: true, listening: true });
  const models = await fetch(`http://127.0.0.1:${address.port}/v1/models`, { headers: { authorization: `Bearer ${String(issued.key)}` } });
  expect(models.status).toBe(200); expect(await models.json()).toMatchObject({ data: [{ id: "clp-test/deepseek-v4.1-flash" }] });
  const rebound = parse(readFileSync(f.configPath, "utf8"));
  expect(await manageModelRelay({ command: "listen", host: "0.0.0.0", enabled: true, models: [] }, f.environment)).toMatchObject({ activation: "saved_and_applied" });
  Object.assign(rebound.model_relay!, { host: "0.0.0.0" });
  expect(service.status().listening).toBe(true);
  expect((await fetch(`http://127.0.0.1:${address.port}/v1/models`)).status).toBe(401);
  // Occupy the same wildcard address: wildcard/loopback coexistence differs across OSes.
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, "0.0.0.0", resolve));
  cleanups.push(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const busy = occupied.address(); if (!busy || typeof busy === "string") throw new Error("fixture");
  Object.assign(rebound.model_relay!, { port: busy.port });
  writePrivateFileAtomicSync(f.configPath, stringify(rebound));
  await expect(service.refresh()).rejects.toThrow();
  expect(await readRelayQueue(f.environment)).toMatchObject({ configurationValid: false, listening: false });
  Object.assign(rebound.model_relay!, { host: "127.0.0.1", port: address.port });
  writePrivateFileAtomicSync(f.configPath, stringify(rebound)); await service.refresh();
  expect(service.status().listening).toBe(true);
  expect(await manageModelRelay(parseModelRelayCommand(["disable"]), f.environment)).toMatchObject({ activation: "saved_and_applied" });
  expect(service.status().listening).toBe(false);
  await expect(fetch(`http://127.0.0.1:${address.port}/v1/models`)).rejects.toThrow();
  const saved = readFileSync(f.configPath, "utf8"); writePrivateFileAtomicSync(f.configPath, "broken = [");
  await expect(service.refresh()).rejects.toThrow(); expect(service.status().listening).toBe(false);
  expect(await queryModelRelayControl(modelRelayPaths(f.configPath).control, "status")).toMatchObject({ configurationValid: false, listening: false });
  expect(await readRelayQueue(f.environment)).toMatchObject({ configurationValid: false, enabled: false, listening: false });
  writePrivateFileAtomicSync(f.configPath, saved); await expect(service.refresh()).resolves.toBeUndefined();
  expect(await queryModelRelayControl(modelRelayPaths(f.configPath).control, "status")).toMatchObject({ result: "status", listening: false });
  await service.close();
  expect(await queryModelRelayControl(modelRelayPaths(f.configPath).control, "status")).toEqual({ result: "not_running" });
  expect(await readRelayQueue(f.environment)).toEqual({ state: "stopped" });
  // The CLP profile remains untouched throughout independent process lifecycle.
  expect(readFileSync(clinePassSetupPaths(f.environment, "test").profile, "utf8")).toContain("sk_fixture-key");
});
it("accepts help only for exact public paths and rejects unknown options", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const command of ["listen", "status", "providers", "issue", "callers", "rotate", "delete", "disable", "enable", "edit"]) for (const flag of ["-h", "--help"]) await runModelRelayCommand([command, flag]);
    expect(log).toHaveBeenCalledTimes(20);
  } finally { log.mockRestore(); }
  expect(parseModelRelayCommand(["edit", "--caller", "a", "--model", "clp-other/deepseek-v4.1-flash"]).models).toEqual(["clp-other/deepseek-v4.1-flash"]);
  expect(parseModelRelayCommand(["delete", "--caller", "a"]).command).toBe("delete");
  expect(() => parseModelRelayCommand(["delete"])).toThrow("用法");
  expect(() => parseModelRelayCommand(["delete", "--caller", "a", "--model", "clp-other/deepseek-v4.1-flash"])).toThrow("用法");
  for (const command of ["models", "upgrade-limits", "upgrade-models", "rollback-providers", "rollback-retired", "rollback-reasoning", "rollback-names"]) {
    expect(() => parseModelRelayCommand([command])).toThrow("用法");
    await expect(runModelRelayCommand([command, "--help"])).rejects.toThrow("用法");
  }
  await expect(runModelRelayCommand(["unknown", "--help"])).rejects.toThrow("用法");
  await expect(runModelRelayCommand(["listen"])).rejects.toThrow("交互终端");
  expect(() => parseModelRelayCommand(["listen", "--host", "0.0.0.0"])).toThrow("用法");
  expect(() => parseModelRelayCommand(["rotate", "--caller", "a", "--caller", "b"])).toThrow("重复");
  expect(() => parseModelRelayCommand(["enable", "--host", "0.0.0.0"])).toThrow("用法");
});

it("authorizes fresh settlement identities without allowing unknown identities or future generations", async () => {
  const f = await fixture();
  const authorize = createRelayMetricAuthorization(f.configPath, f.environment);
  cleanups.push(() => authorize.close());
  const sample: RelayMetric = { source: "relay", threadId: null, turnId: null,
    relayRequestId: "7d40d091-8c74-4dcf-9e40-71531f3f1a98", callerId: "client", keyId: "key", credentialGeneration: 1,
    provider: "clp-test", requestModel: "cline-pass/deepseek-v4.1-flash", responseFormat: "json", status: "completed",
    deliveryStatus: "finished", requestStartedAtMs: 1, responseCompletedAtMs: 2, totalDurationMs: 1 };
  expect(await authorize(sample)).toBe("invalid_sample");
  await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
  expect(await authorize(sample)).toBeUndefined();
  expect(await authorize({ ...sample, credentialGeneration: 2 })).toBe("invalid_sample");
  for (const mismatch of [{ callerId: "other" }, { keyId: "other" }, { provider: "clp-other" }]) {
    expect(await authorize({ ...sample, ...mismatch })).toBe("invalid_sample");
  }
  await manageModelRelay(parseModelRelayCommand(["disable", "--caller", "client"]), f.environment);
  expect(await authorize(sample)).toBeUndefined();
  await manageModelRelay(parseModelRelayCommand(["rotate", "--caller", "client"]), f.environment);
  expect(await authorize({ ...sample, credentialGeneration: 2 })).toBeUndefined();
  expect(await authorize(sample)).toBeUndefined();
  writePrivateFileAtomicSync(f.configPath, "broken = [");
  expect(await authorize(sample)).toBe("invalid_sample");
});

it("runs private CLP credentials through direct Chat JSON/SSE and Gateway IPC into SQLite without an App Server", async () => {
  const f = await fixture(); const received: unknown[] = [];
  const store = new SqliteModelRequestMetricsStore(join(f.environment.CODEX_CONNECT_HOME, "fixture.sqlite3"));
  const writer = new BufferedModelRequestMetricsWriter(store); cleanups.push(() => writer.close());
  const receiver = new RelayMetricsComposition({ path: modelRelayPaths(f.configPath).metrics, writer,
    authorize: createRelayMetricAuthorization(f.configPath, f.environment) });
  await receiver.apply(true); cleanups.push(() => receiver.close());
  let pendingStarted!: () => void;
  const pendingUpstream = new Promise<void>(resolve => { pendingStarted = resolve; });
  const upstream = createHttpServer((request, response) => {
    expect(request.url).toBe("/api/v1/chat/completions"); expect(request.headers.authorization).toBe("Bearer sk_fixture-key");
    const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { stream: boolean }; received.push(input);
      if (received.length === 5) { pendingStarted(); return; }
      if (input.stream) response.writeHead(200, { "content-type": "text/event-stream" }).end(
        'data: {"model":"vendor/model@2026","choices":[{"delta":{"content":"fixture"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "vendor/model@2026", choices: [{ message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const upstreamAddress = upstream.address(); if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("fixture");
  writePrivateFileAtomicSync(join(f.environment.CODEX_HOME, ".env"), `HTTPS_PROXY=http://127.0.0.1:${upstreamAddress.port}\nNO_PROXY=\n`);
  const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
  const portProbe = createServer(); await new Promise<void>(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address(); if (!address || typeof address === "string") throw new Error("fixture");
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const document = parse(readFileSync(f.configPath, "utf8")); Object.assign(document.model_relay!, { enabled: false, port: address.port });
  writePrivateFileAtomicSync(f.configPath, stringify(document));
  const service = await startModelRelayService(f.configPath, f.environment); cleanups.push(() => service.close());
  await manageModelRelay(parseModelRelayCommand(["enable"]), f.environment);
  expect(gatewayConfig.validateDebugConfigDocument(parse(readFileSync(f.configPath, "utf8")).debug ?? {}).model_traffic_dump).toBe(false);
  const setCapture = (enabled: boolean) => {
    const current = parse(readFileSync(f.configPath, "utf8"));
    current.debug = { ...gatewayConfig.validateDebugConfigDocument(current.debug ?? {}), model_traffic_dump: enabled, model_traffic_input_items: enabled ? 0 : 3, model_traffic_item_max_bytes: enabled ? 0 : 65_536 };
    writePrivateFileAtomicSync(f.configPath, stringify(current));
  };
  setCapture(true);
  await service.refresh();
  // Force capture preparation to overlap a global disable, after authentication/material preparation.
  const { RelayTrafficDump } = await import("../dist/provider-proxy/index.js");
  let releasePreparation!: () => void; let preparationStarted!: () => void;
  const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
  const preparationEntered = new Promise<void>(resolve => { preparationStarted = resolve; });
  const originalPrepare = RelayTrafficDump.prototype.prepare;
  const preparation = vi.spyOn(RelayTrafficDump.prototype, "prepare").mockImplementation(async function (this: InstanceType<typeof RelayTrafficDump>, signal?: AbortSignal) {
    await originalPrepare.call(this, signal);
    if (signal) { preparationStarted(); await preparationGate; }
  });
  try {
    const waiting = fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST",
      headers: { authorization: `Bearer ${String(issued.key)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "clp-test/deepseek-v4.1-flash", messages: [{ role: "user", content: "waiting" }] }) });
    await preparationEntered;
    setCapture(false);
    await service.refresh(); releasePreparation();
    const response = await waiting; expect(response.status).toBe(200); await response.text();
  } finally { releasePreparation(); preparation.mockRestore(); }
  setCapture(true);
  await service.refresh();
  await manageModelRelay(parseModelRelayCommand(["edit", "--caller", "client", "--reasoning", "off"]), f.environment);
  let key = issued.key;
  for (const stream of [false, true]) {
    if (stream) key = (await manageModelRelay(parseModelRelayCommand(["rotate", "--caller", "client"]), f.environment)).key;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST",
      headers: { authorization: `Bearer ${String(key)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "clp-test/deepseek-v4.1-flash", messages: [{ role: "user", content: "fixture" }], stream }) });
    expect(response.status).toBe(200); expect(await response.text()).toContain("fixture");
  }
  const other = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "other", "--key", "other", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
  const otherResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST",
    headers: { authorization: `Bearer ${String(other.key)}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "clp-test/deepseek-v4.1-flash", messages: [{ role: "user", content: "fixture" }] }) });
  expect(otherResponse.status).toBe(200); await otherResponse.text();
  expect(received[1]).toMatchObject({ reasoning: { effort: "none" } });
  expect(received[2]).toMatchObject({ reasoning: { effort: "none" } });
  expect(received[3]).not.toHaveProperty("reasoning");
  // Default rate limits are disabled: further requests need no refill wait.
  const pending = fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST",
    headers: { authorization: `Bearer ${String(key)}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "clp-test/deepseek-v4.1-flash", messages: [{ role: "user", content: "pending" }] }) })
    .then(async response => { await response.text(); }, () => undefined);
  await pendingUpstream;
  await manageModelRelay(parseModelRelayCommand(["disable"]), f.environment);
  await pending;
  await service.close(); await writer.waitForCurrentWrites();
  const rows = store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, source: "relay", callerId: "client", limit: 10 });
  expect(rows.records).toHaveLength(4); expect(received).toHaveLength(5);
  expect(rows.records.filter(row => !row.traffic)).toHaveLength(1);
  for (const row of store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, source: "relay", limit: 10 }).records) {
    if (!row.traffic) continue;
    const ref = row.traffic;
    const records = readFileSync(join(dirname(f.configPath), "traffic", `relay.chat-${ref.session}`, "interactions.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line) as { id: number; kind: string; debug?: { version: number } });
    const request = records.find(record => record.id === ref.interaction && record.kind === "request")!;
    expect(request.debug?.version).toBe(1);
  }
  for (const row of rows.records.filter(row => row.traffic)) expect(row).toMatchObject({ traffic: { label: "relay.chat" }, callerId: "client", keyId: "key", threadId: null, turnId: null });
  const completed = rows.records.filter(row => row.status === "completed" && row.traffic);
  expect(completed).toHaveLength(2);
  for (const row of completed) expect(row).toMatchObject({ deliveryStatus: "finished", responseModel: "vendor/model@2026" });
  expect(completed.map(row => row.credentialGeneration).sort()).toEqual([1, 2]);
  expect(completed.map(row => row.inputTokens).sort()).toEqual([2, 3]);
  expect(rows.records.find(row => row.status === "failed")).toMatchObject({ credentialGeneration: 2 });
}, 15_000);

it("shares read-only previews and revision-checked policy edits, preserving credentials on policy changes", async () => {
  const f = await fixture();
  const snapshot = readRelayManagement(f.environment);
  expect(snapshot.providers).toContainEqual(expect.objectContaining({ id: "clp-test", available: true }));
  const input = parseModelRelayCommand(["issue", "--caller", "translation", "--key", "translation", "--model", "clp-test/deepseek-v4.1-flash", "--reasoning", "off"]);
  const before = readFileSync(f.configPath, "utf8");
  const preview = await sharedManage(input, f.environment, { preview: true, expectedRevision: snapshot.revision });
  expect(JSON.stringify(preview)).not.toContain("secret_sha256");
  expect(preview).not.toHaveProperty("key");
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
  const saved = await sharedManage(input, f.environment, { expectedRevision: snapshot.revision });
  expect(saved.key).toMatch(/^cr1.translation\./u);
  await expect(sharedManage(input, f.environment, { expectedRevision: snapshot.revision })).rejects.toThrow("已变化");
  const off = gatewayConfig.validateGatewayConfigDocument(gatewayConfig.readGatewayConfig(f.configPath)).model_relay!.callers[0]!;
  expect(off.reasoning).toBe("off");
  await manageModelRelay(parseModelRelayCommand(["disable", "--caller", "translation"]), f.environment);
  const disabledContent = readFileSync(f.configPath, "utf8");
  const reset = parseModelRelayCommand(["edit", "--caller", "translation", "--reasoning", "passthrough"]);
  const failedSave = vi.spyOn(gatewayConfig, "writeGatewayConfig").mockImplementationOnce(() => { throw new Error("policy save failure"); });
  try { await expect(manageModelRelay(reset, f.environment)).rejects.toThrow("policy save failure"); }
  finally { failedSave.mockRestore(); }
  expect(readFileSync(f.configPath, "utf8")).toBe(disabledContent);
  const changed = await manageModelRelay(reset, f.environment);
  expect(readFileSync(String(changed.backupPath), "utf8")).toBe(disabledContent);
  const updated = gatewayConfig.validateGatewayConfigDocument(gatewayConfig.readGatewayConfig(f.configPath)).model_relay!.callers[0]!;
  expect(updated.reasoning).toBeUndefined(); expect(updated.enabled).toBe(false);
  expect(updated.secret_sha256).toBe(off.secret_sha256);
  await manageModelRelay(parseModelRelayCommand(["edit", "--caller", "translation", "--reasoning", "off"]), f.environment);
  expect(gatewayConfig.validateGatewayConfigDocument(gatewayConfig.readGatewayConfig(f.configPath)).model_relay!.callers[0]!.enabled).toBe(false);
});

it.each([
  { extra: ["--name", " 名称"], message: "用途名称须为 1–64 个字符" },
])("reports controlled management validation errors without changing configuration: $message", async ({ extra, message }) => {
  const f = await fixture();
  const before = readFileSync(f.configPath, "utf8");
  const input = parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash", ...extra]);
  await expect(sharedManage(input, f.environment, { preview: true })).rejects.toThrow(message);
  await expect(manageModelRelay(input, f.environment)).rejects.toThrow(message);
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
});

it("returns the saved one-time key even if activation probing throws", async () => {
  const f = await fixture();
  const failedProbe = vi.spyOn(relayControl, "queryModelRelayControl").mockRejectedValueOnce(new Error("private endpoint unavailable"));
  try {
    const result = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
    expect(result.activation).toBe("saved_unconfirmed"); expect(result.key).toMatch(/^cr1.key\./u);
    expect(gatewayConfig.validateGatewayConfigDocument(gatewayConfig.readGatewayConfig(f.configPath)).model_relay!.callers).toHaveLength(1);
  } finally { failedProbe.mockRestore(); }
});

it.each([".management-transaction.lock", "config.toml.lock"])("preserves the committed key when releasing %s fails", async suffix => {
  const f = await fixture();
  const original = fs.unlinkSync;
  const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(path => {
    if (String(path).endsWith(suffix)) throw new Error("fixture release failure");
    return original(path);
  });
  syncBuiltinESMExports();
  try {
    const saved = await sharedManage(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
    expect(saved.cleanupStatus).toBe("failed");
    expect(saved.key).toMatch(/^cr1.key\./u);
    const bytes = Buffer.from(String(saved.key).split(".")[2]!, "base64url");
    const callers = gatewayConfig.validateGatewayConfigDocument(gatewayConfig.readGatewayConfig(f.configPath)).model_relay!.callers;
    expect(callers).toHaveLength(1);
    expect(callers[0]!.secret_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  } finally { unlink.mockRestore(); syncBuiltinESMExports(); }
});

it("renames display names without restoring old credentials", async () => {
  const f = await fixture();
  await sharedManage(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash", "--name", "沉浸式翻译"]), f.environment);
  const read = () => gatewayConfig.validateGatewayConfigDocument(gatewayConfig.readGatewayConfig(f.configPath)).model_relay!.callers[0]!;
  const initial = read();
  const revision = readRelayManagement(f.environment).revision;
  const edit = parseModelRelayCommand(["edit", "--caller", "client", "--name", "网页翻译"]);
  await sharedManage(edit, f.environment, { preview: true, expectedRevision: revision });
  expect(read()).toEqual(initial);
  await sharedManage(edit, f.environment, { expectedRevision: revision });
  expect(read()).toEqual({ ...initial, display_name: "网页翻译" });
  await expect(sharedManage(edit, f.environment, { expectedRevision: revision })).rejects.toThrow("已变化");
  await sharedManage(parseModelRelayCommand(["rotate", "--caller", "client"]), f.environment);
  await sharedManage(parseModelRelayCommand(["disable", "--caller", "client"]), f.environment);
  const current = read();
  expect(current.secret_sha256).not.toBe(initial.secret_sha256);
  expect(current.enabled).toBe(false); expect(current.display_name).toBe("网页翻译");

});


it("rejects incompatible or malformed runtime diagnostics instead of inventing zero counts", async () => {
  const f = await fixture();
  const valid = { result: "status", configurationValid: true, enabled: false, listening: false, active: 0,
    queue: { pending: 0, waiting: 0, bytes: 0, oldestWaitMs: 0, timedOut: 0 }, unavailableAccounts: 0,
    capture: { enabled: false, state: "initializing", active: 0, skippedCapacity: 0 },
    metrics: { local_dropped: 0, accepted: 0, rejected: 0, unconfirmed: 0, pending: 0, active: 0, bytes: 0 } };
  let response: Record<string, unknown> = valid;
  const endpoint = modelRelayPaths(f.configPath).control;
  const control = new ModelRelayControl(endpoint, async () => response);
  await control.start(); cleanups.push(() => control.close());
  expect(await queryModelRelayControl(endpoint, "status")).toMatchObject(valid);
  for (const patch of [{ version: 2 }, { capture: undefined }, { capture: { ...valid.capture, state: "invalid" } },
    { capture: { ...valid.capture, secret: "hidden" } }, { queue: { ...valid.queue, oldestWaitMs: -1 } },
    { queue: { ...valid.queue, timedOut: 0.5 } }]) {
    response = { ...valid, ...patch };
    expect(await queryModelRelayControl(endpoint, "status")).toEqual({ result: "unconfirmed" });
  }
});

it("rebinds and deletes keys with durable settlement authority and revocation", async () => {
  const f = await fixture();
  await applyClinePassConfiguration({ accountId: "other", apiKey: "fixture-other" }, { environment: f.environment });
  const run = (args: string[]) => manageModelRelay(parseModelRelayCommand(args), f.environment);
  const model = "cline-pass/deepseek-v4.1-flash";
  await run(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]);
  const before = readFileSync(f.configPath, "utf8");
  const prior = gatewayConfig.validateGatewayConfigDocument(parse(before)).model_relay!.callers[0]!;
  await expect(run(["edit", "--caller", "client", "--model", "clp-other/unknown"])).rejects.toThrow("目录");
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
  const edit = ["edit", "--caller", "client", "--model", "clp-other/deepseek-v4.1-flash"];
  const preview = await sharedManage(parseModelRelayCommand(edit), f.environment, { preview: true });
  expect(preview).toMatchObject({ preview: { callers: [{ models: ["clp-other/deepseek-v4.1-flash"] }] } });
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
  const saved = await run(edit);
  expect(readFileSync(String(saved.backupPath), "utf8")).toBe(before);
  let config = gatewayConfig.validateGatewayConfigDocument(parse(readFileSync(f.configPath, "utf8"))).model_relay!;
  expect(config.callers[0]).toEqual({ ...prior, models: ["clp-other/deepseek-v4.1-flash"] });
  expect(config.retired_callers).toEqual([{ caller_id: "client", key_id: "key", provider: "clp-test", credential_generation: 1 }]);
  await run(["edit", "--caller", "client", "--model", "clp-test/deepseek-v4.1-flash"]);
  await run(edit);
  config = gatewayConfig.validateGatewayConfigDocument(parse(readFileSync(f.configPath, "utf8"))).model_relay!;
  expect(config.retired_callers).toHaveLength(2);
  const snapshot = readFileSync(f.configPath, "utf8");
  const failure = vi.spyOn(gatewayConfig, "writeGatewayConfig").mockImplementation(() => { throw new Error("fixture deletion failure"); });
  try { await expect(run(["delete", "--caller", "client"])).rejects.toThrow("fixture deletion failure"); }
  finally { failure.mockRestore(); }
  expect(readFileSync(f.configPath, "utf8")).toBe(snapshot);
  await run(["delete", "--caller", "client"]);
  expect((await run(["callers"])).callers).toEqual([]);
  expect(readFileSync(f.configPath, "utf8")).not.toContain(prior.secret_sha256);
  const authorize = createRelayMetricAuthorization(f.configPath, f.environment); cleanups.push(() => authorize.close());
  const sample: RelayMetric = { source: "relay", threadId: null, turnId: null,
    relayRequestId: "7d40d091-8c74-4dcf-9e40-71531f3f1a98", callerId: "client", keyId: "key", credentialGeneration: 1,
    provider: "clp-test", requestModel: model, responseFormat: "json", status: "completed",
    deliveryStatus: "finished", requestStartedAtMs: 1, responseCompletedAtMs: 2, totalDurationMs: 1 };
  for (const provider of ["clp-test", "clp-other"]) expect(await authorize({ ...sample, provider })).toBeUndefined();
  expect(await authorize({ ...sample, credentialGeneration: 2 })).toBe("invalid_sample");
  expect(await authorize({ ...sample, keyId: "other" })).toBe("invalid_sample");
  for (const [caller, key] of [["client", "new"], ["new", "key"]]) {
    await expect(run(["issue", "--caller", caller!, "--key", key!, "--model", "clp-test/deepseek-v4.1-flash"])).rejects.toThrow("身份已存在");
  }
  await run(["issue", "--caller", "retained", "--key", "retained", "--model", "clp-test/deepseek-v4.1-flash"]);
  await run(["rotate", "--caller", "retained"]);
  expect((await run(["callers"])).callers).toHaveLength(1);

});

it("settles cancelled calls under their original provider across rebind, deletion and restart", async () => {
  const f = await fixture();
  await applyClinePassConfiguration({ accountId: "other", apiKey: "fixture-other" }, { environment: f.environment });
  const run = (args: string[]) => manageModelRelay(parseModelRelayCommand(args), f.environment);
  const model = "cline-pass/deepseek-v4.1-flash";
  const held: import("node:http").ServerResponse[] = [];
  const upstream = createHttpServer((request, response) => { request.resume(); request.on("end", () => held.push(response)); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const up = upstream.address(); if (!up || typeof up === "string") throw new Error("fixture");
  writePrivateFileAtomicSync(join(f.environment.CODEX_HOME, ".env"), `HTTPS_PROXY=http://127.0.0.1:${up.port}\nNO_PROXY=\n`);
  const issued = await run(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]);
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("fixture");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const document = parse(readFileSync(f.configPath, "utf8")); Object.assign(document.model_relay!, { enabled: true, port: address.port });
  writePrivateFileAtomicSync(f.configPath, stringify(document));
  const store = new SqliteModelRequestMetricsStore(join(f.environment.CODEX_CONNECT_HOME, "rebind.sqlite3"));
  const writer = new BufferedModelRequestMetricsWriter(store); cleanups.push(() => writer.close());
  const receiver = new RelayMetricsComposition({ path: modelRelayPaths(f.configPath).metrics, writer,
    authorize: createRelayMetricAuthorization(f.configPath, f.environment) });
  await receiver.apply(true); cleanups.push(() => receiver.close());
  const service = await startModelRelayService(f.configPath, f.environment); cleanups.push(() => service.close());
  const request = (provider = "clp-test") => fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST",
    headers: { authorization: `Bearer ${String(issued.key)}`, "content-type": "application/json" },
    body: JSON.stringify({ model: relayModelId(provider, model), messages: [{ role: "user", content: "fixture" }] }) }).then(async response => { await response.text(); return response.status; }).catch(() => "disconnected" as const);
  const old = request(); await vi.waitFor(() => expect(held).toHaveLength(1));
  expect(await readRelayQueue(f.environment)).toMatchObject({ state: "running", listening: true, requests: [{ callerId: "client", displayName: null, provider: "clp-test" }] });
  await run(["edit", "--caller", "client", "--name", "新用途"]);
  expect(await readRelayQueue(f.environment)).toMatchObject({ requests: [{ callerId: "client", displayName: "新用途", phase: "upstream", provider: "clp-test" }] });
  expect(held).toHaveLength(1);

  expect(await run(["edit", "--caller", "client", "--model", "clp-other/deepseek-v4.1-flash"])).toMatchObject({ activation: "saved_and_applied" });
  expect([503, "disconnected"]).toContain(await old);
  await vi.waitFor(() => expect(store.count()).toBe(1));
  const current = request("clp-other"); await vi.waitFor(() => expect(held).toHaveLength(2));
  expect(await run(["delete", "--caller", "client"])).toMatchObject({ activation: "saved_and_applied" });
  expect([503, "disconnected"]).toContain(await current);
  await vi.waitFor(() => expect(store.count()).toBe(2));
  const records = store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, source: "relay", limit: 10 }).records;
  expect(records.map(record => record.provider).sort()).toEqual(["clp-other", "clp-test"]);
  expect(records.every(record => record.callerId === "client")).toBe(true);
  expect(await request()).toBe(401);
  await service.close();
  const restarted = await startModelRelayService(f.configPath, f.environment); cleanups.push(() => restarted.close());
  expect(await request()).toBe(401);
  expect(store.count()).toBe(2);
  expect(await readRelayQueue(f.environment)).toMatchObject({ requests: [] });
}, 15_000);

it("rejects exhausted history and serialized file size before replacing configuration", async () => {
  const f = await fixture();
  const run = (args: string[]) => manageModelRelay(parseModelRelayCommand(args), f.environment);
  await run(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]);
  const original = readFileSync(f.configPath, "utf8");
  const document = parse(original);
  Object.assign(document.model_relay!, { retired_callers: Array.from({ length: 4096 }, (_, i) => ({
    caller_id: `c${i}`, key_id: `k${i}`, provider: "clp-test", credential_generation: 1 })) });
  const full = stringify(document); expect(Buffer.byteLength(full)).toBeLessThan(1024 * 1024);
  writePrivateFileAtomicSync(f.configPath, full);
  await expect(run(["delete", "--caller", "client"])).rejects.toThrow("容量上限");
  expect(readFileSync(f.configPath, "utf8")).toBe(full);
  const padded = original + "\n#" + "x".repeat(1024 * 1024 - Buffer.byteLength(original) - 12) + "\n";
  writePrivateFileAtomicSync(f.configPath, padded);
  await expect(run(["edit", "--caller", "client", "--name", "n".repeat(64)])).rejects.toThrow("容量上限");
  expect(readFileSync(f.configPath, "utf8")).toBe(padded);
});

it("validates bounded private queue snapshots and refuses incompatible peers", async () => {
  const f = await fixture();
  const row = { requestId: "7d40d091-8c74-4dcf-9e40-71531f3f1a98", callerId: "client", displayName: "中文用途", provider: "clp-test",
    model: "x".repeat(200), reasoningEffort: "high", protocol: "chat", phase: "queue", elapsedMs: 123 };
  let response: Record<string, unknown> = { result: "queue", configurationValid: true, enabled: true, listening: true, requests: Array.from({ length: 64 }, () => row) };
  const endpoint = modelRelayPaths(f.configPath).control;
  const control = new ModelRelayControl(endpoint, async () => response);
  await control.start(); cleanups.push(() => control.close());
  expect(await queryModelRelayControl(endpoint, "queue")).toMatchObject(response);
  for (const requests of [[{ ...row, secret: "hidden" }], [{ ...row, phase: "unknown" }], [{ ...row, elapsedMs: -1 }],
    [{ ...row, displayName: "bad\nname" }], [{ ...row, displayName: undefined }], [{ ...row, model: "x".repeat(266) }],
    [{ ...row, reasoningEffort: undefined }], [{ ...row, reasoningEffort: 0 }], [{ ...row, reasoningEffort: "" }],
    [{ ...row, reasoningEffort: "x".repeat(65) }], [{ ...row, reasoningEffort: "bad\neffort" }], Array.from({ length: 65 }, () => row)]) {
    response = { result: "queue", configurationValid: true, enabled: true, listening: true, requests };
    expect(await queryModelRelayControl(endpoint, "queue")).toEqual({ result: "unconfirmed" });
  }
  for (const patch of [{ version: 3 }, { version: 5 }, { configurationValid: undefined }, { enabled: "yes" }, { listening: undefined }]) {
    response = { result: "queue", configurationValid: true, enabled: true, listening: true, requests: [], ...patch };
    expect(await queryModelRelayControl(endpoint, "queue")).toEqual({ result: "unconfirmed" });
  }
  response = { result: "status" };
  expect(await queryModelRelayControl(endpoint, "queue")).toEqual({ result: "unconfirmed" });
});

it("preserves Unicode model names across fragmented queue IPC responses", async () => {
  const f = await fixture();
  const endpoint = modelRelayPaths(f.configPath).control;
  const server = new PrivateIpcServer(endpoint, socket => {
    socket.once("data", data => {
      const request = JSON.parse(data.toString()) as { requestId: string };
      const payload = Buffer.from(JSON.stringify({ version: 6, requestId: request.requestId, result: "queue", configurationValid: true, enabled: true, listening: true, requests: [{
        requestId: "7d40d091-8c74-4dcf-9e40-71531f3f1a98", callerId: "client", displayName: "中文用途", provider: "clp-test",
        model: "中文模型", reasoningEffort: null, protocol: "responses", phase: "upstream", elapsedMs: 1,
      }] }) + "\n");
      const boundary = payload.indexOf(Buffer.from("中")) + 1;
      socket.write(payload.subarray(0, boundary));
      setTimeout(() => socket.end(payload.subarray(boundary)), 10);
    });
  });
  await server.start("occupied"); cleanups.push(() => server.close());
  expect(await queryModelRelayControl(endpoint, "queue")).toMatchObject({ result: "queue", configurationValid: true, enabled: true, listening: true, requests: [{ model: "中文模型" }] });
});

it.each(["provider", "metrics"])("rereads only a changing config once for %s snapshots", async purpose => {
  const f = await fixture();
  for (const mode of ["once", "continuous", "invalid"]) {
    // Inject a save between the two reads inside the real worker, without changing user files.
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      const open = fs.openSync, read = fs.readFileSync, close = fs.closeSync;
      const descriptors = new Set(); let reads = 0;
      fs.openSync = (...args) => { const fd = open(...args); if (args[0] === workerData.configPath) descriptors.add(fd); return fd; };
      fs.closeSync = fd => { descriptors.delete(fd); return close(fd); };
      fs.readFileSync = (...args) => {
        const content = read(...args);
        if (!descriptors.has(args[0])) return content;
        reads += 1;
        if (workerData.mode === "invalid") return "[broken";
        return content + "\\n# revision " + (workerData.mode === "continuous" ? reads : Math.min(reads, 2));
      };
      require("node:module").syncBuiltinESMExports();
      const send = parentPort.postMessage.bind(parentPort);
      parentPort.postMessage = result => send({ ...result, reads });
      import(workerData.module).then(() => send("ready"));
    `, { eval: true, workerData: { configPath: f.configPath, environment: f.environment, purpose, mode,
      module: new URL("../runtime/model-relay-material-worker.mjs", import.meta.url).href } });
    try {
      expect((await once(worker, "message"))[0]).toBe("ready");
      const received = once(worker, "message"); worker.postMessage({ operation: "read" });
      expect((await received)[0]).toMatchObject({ ok: mode === "once", reads: mode === "invalid" ? 1 : 4 });
    } finally { await worker.terminate(); }
  }
});


it("updates listener interactively with backup, cancellation and stale-config protection", async () => {
  const f = await fixture();
  await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
  const before = readFileSync(f.configPath, "utf8");
  const credentials = gatewayConfig.validateGatewayConfigDocument(parse(before)).model_relay!.callers;
  let mode = "lan", confirm = false, address = "192.168.1.10", concurrent = false;
  let text = "";
  const options = { environment: f.environment, output: { write: (value: string) => { text += value; } }, prompts: {
    select: async () => mode, text: async () => address, isCancel: (value: unknown) => value === null,
    confirm: async () => { if (concurrent) writePrivateFileAtomicSync(f.configPath, readFileSync(f.configPath, "utf8") + "\n# external edit\n"); return confirm; },
  } };
  expect(await runRelayListenMenu(options)).toEqual({ action: "back" });
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
  confirm = true;
  const enabled = await runRelayListenMenu(options);
  expect(enabled.activation).toBe("saved_not_running");
  expect(readFileSync(enabled.backupPath as string, "utf8")).toBe(before);
  expect(gatewayConfig.validateGatewayConfigDocument(parse(readFileSync(f.configPath, "utf8"))).model_relay).toMatchObject({ host: "0.0.0.0", enabled: true, callers: credentials });
  expect(text).toContain("服务器内网IP:4119/v1"); expect(text).not.toContain("http://0.0.0.0");
  mode = "custom"; concurrent = true;
  await expect(runRelayListenMenu(options)).rejects.toThrow("已变化");
  expect(readFileSync(f.configPath, "utf8")).toContain("# external edit");
  concurrent = false; address = "8.8.8.8";
  await expect(runRelayListenMenu(options)).rejects.toThrow("无效");
  address = "192.168.1.10"; await runRelayListenMenu(options);
  mode = "disabled"; await runRelayListenMenu(options);
  expect(gatewayConfig.validateGatewayConfigDocument(parse(readFileSync(f.configPath, "utf8"))).model_relay).toMatchObject({ host: address, enabled: false, callers: credentials });
  mode = "local"; await runRelayListenMenu(options);
  expect(gatewayConfig.validateGatewayConfigDocument(parse(readFileSync(f.configPath, "utf8"))).model_relay).toMatchObject({ host: "127.0.0.1", enabled: true, callers: credentials });
  text = ""; expect(await runRelayListenMenu(options)).toEqual({ action: "unchanged" });
  expect(text).toContain("未变化");
});

it("isolates Relay queue subscribers from command capacity and cancels watchers", async () => {
  const f = await fixture();
  const path = modelRelayPaths(f.configPath).control;
  const control = new ModelRelayControl(path, async () => ({ result: "queue", configurationValid: true, enabled: true, listening: true, requests: [] }));
  await control.start();
  const abort = new AbortController();
  const receive = Array.from({ length: 8 }, () => vi.fn());
  const watchers = receive.map(callback => relayControl.watchRelayChanges(path, abort.signal, callback));
  try {
    await vi.waitFor(() => expect(receive.every(callback => callback.mock.calls.length === 1)).toBe(true));
    await expect(relayControl.watchRelayChanges(path, abort.signal, () => {})).rejects.toThrow();
    expect(await queryModelRelayControl(path, "queue")).toMatchObject({ result: "queue", requests: [] });
    for (let i = 0; i < 50; i++) control.changed();
    await vi.waitFor(() => expect(receive.every(callback => callback.mock.calls.length === 2)).toBe(true));
  } finally { abort.abort(); await Promise.all(watchers); await control.close(); }
});

it("automatically initializes the catalog for CLI key creation before the relay is running", async () => {
  const f = await fixture();
  const catalog = JSON.parse(readFileSync(clineRelayCatalogPath(f.environment), "utf8"));
  rmSync(clineRelayCatalogPath(f.environment));
  const download = vi.spyOn(catalogUpdate, "downloadClineRelayCatalog").mockResolvedValue(catalog);
  try {
    const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "auto-cli", "--key", "auto-cli", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
    expect(issued.activation).toBe("saved_not_running");
    expect(download).toHaveBeenCalledOnce();
    expect(loadConfiguredRelayProviderMaterial("clp-test", f.environment).models).toContain("cline-pass/deepseek-v4.1-flash");
  } finally { download.mockRestore(); }
});

it.each(["providers", "issue"] as const)("keeps revocation available during CLI %s catalog download and preserves a concurrent update", async command => {
  const f = await fixture();
  await sharedManage({ command: "issue", caller: "existing", key: "existing", models: ["clp-test/deepseek-v4.1-flash"] }, f.environment);
  const snapshot = catalogUpdate.readClineRelayCatalog(f.environment);
  if (snapshot.status !== "ready") throw new Error("fixture catalog missing");
  const catalog = snapshot.catalog;
  rmSync(clineRelayCatalogPath(f.environment));
  let complete!: (value: typeof catalog) => void;
  const download = vi.spyOn(catalogUpdate, "downloadClineRelayCatalog").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = sharedManage(command === "providers" ? { command } : {
    command, caller: "new", key: "new", models: ["clp-test/deepseek-v4.1-flash"],
  }, f.environment).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
  try {
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect((await sharedManage({ command: "disable", caller: "existing" }, f.environment)).activation).toBe("saved_not_running");
    const newer = { ...snapshot.catalog, commit: "b".repeat(40), models: [{ id: "cline-pass/new-model" }] };
    saveClineRelayCatalog(newer, f.environment);
    complete(snapshot.catalog);
    const result = await pending;
    if (command === "issue") expect(result.error).toMatchObject({ message: "Key 模型在当前提供商目录中不可用" });
    else expect(result.error).toBeUndefined();
    expect(catalogUpdate.readClineRelayCatalog(f.environment)).toMatchObject({ status: "ready", catalog: newer });
    expect(readRelayManagement(f.environment).callers).toEqual([expect.objectContaining({ caller_id: "existing", enabled: false })]);
  } finally { complete?.(snapshot.catalog); await pending; download.mockRestore(); }
});

it("isolates the CLP relay catalog from Codex model settings while retaining shared credential revocation", async () => {
  const f = await fixture();
  const paths = clinePassSetupPaths(f.environment, "test");
  const before = loadConfiguredRelayProviderMaterial("clp-test", f.environment);
  expect(before.paths).not.toContain(paths.catalog); expect(before.paths).not.toContain(paths.manifest);
  const catalog = JSON.parse(readFileSync(clineRelayCatalogPath(f.environment), "utf8"));
  saveClineRelayCatalog({ ...catalog, downloadedAt: 200 }, f.environment);
  expect(loadConfiguredRelayProviderMaterial("clp-test", f.environment).revision).toBe(before.revision);
  const profile = parse(readFileSync(paths.profile, "utf8"));
  profile.model = "codex-only-model"; profile.model_catalog_json = "/not/a/relay/catalog.json"; profile.model_reasoning_effort = "irrelevant-to-relay";
  writePrivateFileAtomicSync(paths.profile, stringify(profile));
  writePrivateFileAtomicSync(paths.catalog, "not valid JSON"); writePrivateFileAtomicSync(paths.manifest, "not valid JSON");
  expect(loadConfiguredRelayProviderMaterial("clp-test", f.environment).revision).toBe(before.revision);
  expect(loadConfiguredRelayProviderMaterial("clp-test", f.environment).models).toEqual(before.models);
  const providers = profile.model_providers as Record<string, Record<string, unknown>>;
  providers["clp-test"]!.experimental_bearer_token = "rotated-upstream-key";
  writePrivateFileAtomicSync(paths.profile, stringify(profile));
  const changed = loadConfiguredRelayProviderMaterial("clp-test", f.environment);
  expect(changed.apiKey).toBe("rotated-upstream-key"); expect(changed.revision).not.toBe(before.revision);
  rmSync(paths.marker);
  expect(() => loadConfiguredRelayProviderMaterial("clp-test", f.environment)).toThrow("marker");
});

it("rejects account revocation between registry lookup and the credential fingerprint", async () => {
  const f = await fixture(); const paths = clinePassSetupPaths(f.environment, "test");
  const original = providerDefinitions.loadManagedModelProviderDefinitions;
  const lookup = vi.spyOn(providerDefinitions, "loadManagedModelProviderDefinitions");
  let revoked = false;
  lookup.mockImplementation(environment => {
    const definitions = original(environment);
    if (!revoked) { revoked = true; writePrivateFileAtomicSync(paths.registry, "[]"); }
    return definitions;
  });
  try { expect(() => loadConfiguredRelayProviderMaterial("clp-test", f.environment)).toThrow("changed during read"); }
  finally { lookup.mockRestore(); }
});

it("automatically restores a missing Cline catalog after relay startup without an App Server", async () => {
  const f = await fixture(); const model = "cline-pass/deepseek-v4.1-flash";
  const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "auto", "--key", "auto", "--model", "clp-test/deepseek-v4.1-flash"]), f.environment);
  const portProbe = createServer(); await new Promise<void>(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address(); if (!address || typeof address === "string") throw new Error("fixture");
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const document = gatewayConfig.parseGatewayConfig(readFileSync(f.configPath, "utf8"));
  const relayConfig = document.model_relay as Record<string, unknown>;
  relayConfig.enabled = true; relayConfig.port = address.port;
  writePrivateFileAtomicSync(f.configPath, stringify(document));
  const catalog = JSON.parse(readFileSync(clineRelayCatalogPath(f.environment), "utf8")); rmSync(clineRelayCatalogPath(f.environment));
  const download = vi.spyOn(catalogUpdate, "downloadClineRelayCatalog").mockResolvedValue(catalog);
  const service = await startModelRelayService(f.configPath, f.environment);
  try {
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`, { headers: { authorization: `Bearer ${issued.key}` } });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ data: [{ id: relayModelId("clp-test", model) }] });
    });
    await service.refresh(); expect(download).toHaveBeenCalledOnce();
  } finally { await service.close(); download.mockRestore(); }
});

it("loads model capabilities through the worker, scopes Key grants and revokes requests on policy changes", async () => {
  const f = await fixture();
  const extra = { id: "fixture/relay-only", reasoning_efforts: ["none", "high"] as Array<"none" | "high">, reasoning: "high" as const };
  const toggleModel = "fixture/toggle-only", effortModel = "fixture/effort-none", museModel = "cline-pass/muse-spark-1.3-contributor";
  saveClineRelayCatalog({ version: 1, commit: "a".repeat(40), downloadedAt: 1, models: [
    { id: extra.id, reasoningOptions: [{ type: "toggle" }, { type: "effort", values: ["high"] }] }, { id: "constructor", reasoningOptions: [] },
    { id: toggleModel, reasoningOptions: [{ type: "toggle" }] }, { id: museModel },
    { id: effortModel, reasoningOptions: [{ type: "effort", values: ["none", "high"] }] },
  ] }, f.environment);
  const codexPaths = clinePassSetupPaths(f.environment, "test");
  writePrivateFileAtomicSync(codexPaths.catalog, "invalid Codex catalog"); writePrivateFileAtomicSync(codexPaths.manifest, "invalid Codex manifest");
  const baseline = loadConfiguredRelayProviderMaterial("clp-test", f.environment);
  const issued = await sharedManage({ command: "issue", caller: "extra", key: "extra", models: [extra.id, toggleModel, effortModel, museModel].map(id => relayModelId("clp-test", id)) }, f.environment);
  expect(issued.backupPath).toEqual(expect.any(String)); expect(loadConfiguredRelayProviderMaterial("clp-test", f.environment)).toEqual(baseline);
  const held: import("node:http").ServerResponse[] = [], forwarded: Array<Record<string, unknown>> = []; let hold = false;
  const upstream = createHttpServer((request, response) => {
    let text = ""; request.setEncoding("utf8"); request.on("data", chunk => { text += chunk; });
    request.on("end", () => { forwarded.push(JSON.parse(text)); if (hold) held.push(response);
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] })); });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("fixture");
  f.environment.HTTPS_PROXY = `http://127.0.0.1:${address.port}`; f.environment.NO_PROXY = "";
  const portProbe = createServer(); await new Promise<void>(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address(); if (!port || typeof port === "string") throw new Error("fixture");
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const document = gatewayConfig.parseGatewayConfig(readFileSync(f.configPath, "utf8"));
  Object.assign(document.model_relay as object, { enabled: true, port: port.port }); writePrivateFileAtomicSync(f.configPath, stringify(document));
  const service = await startModelRelayService(f.configPath, f.environment); cleanups.push(() => service.close());
  const headers = { authorization: `Bearer ${issued.key}`, "content-type": "application/json" };
  const origin = `http://127.0.0.1:${port.port}`;
  expect(await (await fetch(`${origin}/v1/models`, { headers })).json()).toMatchObject({ data: [{ id: relayModelId("clp-test", extra.id) }, { id: relayModelId("clp-test", toggleModel) }, { id: relayModelId("clp-test", museModel) }, { id: relayModelId("clp-test", effortModel) }] });
  const call = () => fetch(`${origin}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: relayModelId("clp-test", extra.id), messages: [{ role: "user", content: "fixture" }] }) }).then(async response => { await response.text(); return response.status; }).catch(() => "disconnected");
  expect(await call()).toBe(200); expect(forwarded[0]).not.toHaveProperty("reasoning_effort"); expect(forwarded[0]).not.toHaveProperty("reasoning"); expect(forwarded[0]).not.toHaveProperty("provider");
  hold = true; const pending = call(); await vi.waitFor(() => expect(held).toHaveLength(1));
  await sharedManage({ command: "edit", caller: "extra", reasoning: "off" }, f.environment);
  expect(await pending).not.toBe(200);
  hold = false; expect(await call()).toBe(200); expect(forwarded.at(-1)?.reasoning).toEqual({ enabled: false });
  await manageModelRelay(parseModelRelayCommand(["edit", "--caller", "extra", "--reasoning", "off"]), f.environment);
  const callModel = (model: string) => fetch(`${origin}/v1/chat/completions`, { method: "POST", headers,
    body: JSON.stringify({ model: relayModelId("clp-test", model), messages: [{ role: "user", content: "fixture" }] }),
  }).then(async response => { await response.text(); return response.status; }).catch(() => "disconnected");
  expect(await callModel(toggleModel)).toBe(200); expect(forwarded.at(-1)?.reasoning).toEqual({ enabled: false });
  expect(await callModel(effortModel)).toBe(200); expect(forwarded.at(-1)?.reasoning).toEqual({ enabled: false });
  expect(await callModel(museModel)).toBe(200); expect(forwarded.at(-1)).not.toHaveProperty("reasoning");
  expect(readRelayManagement(f.environment).providers.find(provider => provider.id === "clp-test")).not.toHaveProperty("extraModels");
  const beforeUpdate = loadConfiguredRelayProviderMaterial("clp-test", f.environment);
  hold = true; const pendingDefault = callModel(toggleModel); await vi.waitFor(() => expect(held).toHaveLength(2));
  saveClineRelayCatalog({ version: 1, commit: "b".repeat(40), downloadedAt: 2,
    models: [{ id: extra.id }, { id: toggleModel }, { id: museModel }] }, f.environment);
  await service.refresh(); expect(await pendingDefault).not.toBe(200);
  expect(loadConfiguredRelayProviderMaterial("clp-test", f.environment).revision).not.toBe(beforeUpdate.revision);
  hold = false; expect(await callModel(toggleModel)).toBe(200); expect(forwarded.at(-1)).not.toHaveProperty("reasoning");
  // Capability removal prevents Key off from inventing an upstream control.
  expect(await call()).toBe(200); expect(forwarded.at(-1)).not.toHaveProperty("reasoning");
});
