import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, it, vi } from "vitest";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { startModelRelayService } from "../runtime/model-relay-service.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";
import { queryModelRelayControl } from "../runtime/model-relay-control.mjs";
import { manageModelRelay, parseModelRelayCommand, runModelRelayCommand } from "../scripts/model-relay-command.mjs";
import { applyClinePassConfiguration, clinePassSetupPaths } from "../scripts/cline-pass-setup.mjs";
import * as privateFile from "../runtime/private-file.mjs";
import * as gatewayConfig from "../runtime/gateway-config.mjs";
import { createPrivateIpcConnection } from "../runtime/private-ipc.mjs";
import { once } from "node:events";
import { RelayMetricsComposition, createRelayMetricAuthorization } from "../src/bootstrap/relay-metrics-composition.js";
import { BufferedModelRequestMetricsWriter, SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import type { RelayMetric } from "../src/provider-proxy/index.js";

vi.mock("../scripts/model-catalog-validation.mjs", () => ({ validateModelCatalogWithCodex: async () => undefined }));
// Replace only the TLS proxy transport. The selected proxy is an isolated HTTP fixture;
// configuration, private credentials, admission, request serialization and metrics IPC stay real.
vi.mock("https-proxy-agent", async () => {
  const { Agent } = await import("node:https"); const { connect } = await import("node:net");
  return { HttpsProxyAgent: class extends Agent {
    private readonly proxy: URL;
    constructor(proxy: string) { super(); this.proxy = new URL(proxy); }
    override createConnection() { return connect({ host: "127.0.0.1", port: Number(this.proxy.port) }); }
  } };
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-runtime-"));
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
  return { configPath, environment };
}
it("issues and rotates secrets once, preserves tombstones and configuration backups", async () => {
  const f = await fixture();
  const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--provider", "clp-test", "--model", "cline-pass/deepseek-v4.1-flash"]), f.environment);
  expect(issued.activation).toBe("saved_not_running");
  const token = String(issued.key);
  const content = readFileSync(f.configPath, "utf8");
  const saved = gatewayConfig.validateGatewayConfigDocument(gatewayConfig.parseGatewayConfig(content)).model_relay;
  const defaultLimits = { max_concurrency: 10, requests_per_minute: 0, burst: 10 };
  expect(saved).toMatchObject(defaultLimits);
  expect(saved?.accounts[0]).toEqual({ provider: "clp-test" });
  expect(saved?.callers[0]).not.toHaveProperty("max_concurrency");
  expect(content).not.toContain(token);
  expect(content).toContain(createHash("sha256").update(Buffer.from(token.split(".")[2]!, "base64url")).digest("hex"));
  expect(readFileSync(String(issued.backupPath), "utf8")).not.toContain("model_relay");
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
  await expect(manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "other", "--provider", "clp-test", "--model", "cline-pass/deepseek-v4.1-flash"]), f.environment)).rejects.toThrow("身份已存在");
});
it("owns a private control endpoint; enables, disables, fails closed and recovers without an App Server", async () => {
  const f = await fixture();
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address(); if (!address || typeof address === "string") throw new Error("fixture");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--provider", "clp-test", "--model", "cline-pass/deepseek-v4.1-flash"]), f.environment);
  const document = parse(readFileSync(f.configPath, "utf8"));
  Object.assign(document.model_relay!, { port: address.port }); writePrivateFileAtomicSync(f.configPath, stringify(document));
  const service = await startModelRelayService(f.configPath, f.environment).catch((cause: unknown) => { throw new Error("initial service startup failed", { cause }); }); cleanups.push(() => service.close());
  expect(service.status()).toEqual({ enabled: false, listening: false });
  const malformed = createPrivateIpcConnection(modelRelayPaths(f.configPath).control);
  malformed.on("error", () => {}); await once(malformed, "connect");
  malformed.write('{"version":1,"operation":"status","requestId":{"toString":null}}\n');
  await once(malformed, "close");
  expect(await queryModelRelayControl(modelRelayPaths(f.configPath).control, "status")).toMatchObject({ version: 2, configurationValid: true, queue: { pending: 0, waiting: 0, bytes: 0 } });
  await expect(startModelRelayService(f.configPath, f.environment)).rejects.toThrow();
  expect(await manageModelRelay(parseModelRelayCommand(["enable"]), f.environment)).toMatchObject({ activation: "saved_and_applied" });
  const models = await fetch(`http://127.0.0.1:${address.port}/v1/models`, { headers: { authorization: `Bearer ${String(issued.key)}` } });
  expect(models.status).toBe(200); expect(await models.json()).toMatchObject({ data: [{ id: "cline-pass/deepseek-v4.1-flash" }] });
  expect(await manageModelRelay(parseModelRelayCommand(["disable"]), f.environment)).toMatchObject({ activation: "saved_and_applied" });
  expect(service.status().listening).toBe(false);
  await expect(fetch(`http://127.0.0.1:${address.port}/v1/models`)).rejects.toThrow();
  const saved = readFileSync(f.configPath, "utf8"); writePrivateFileAtomicSync(f.configPath, "broken = [");
  await expect(service.refresh()).rejects.toThrow(); expect(service.status().listening).toBe(false);
  expect(await queryModelRelayControl(modelRelayPaths(f.configPath).control, "status")).toMatchObject({ configurationValid: false, listening: false });
  writePrivateFileAtomicSync(f.configPath, saved); await expect(service.refresh()).resolves.toBeUndefined();
  expect(await queryModelRelayControl(modelRelayPaths(f.configPath).control, "status")).toMatchObject({ result: "status", listening: false });
  await service.close();
  expect(await queryModelRelayControl(modelRelayPaths(f.configPath).control, "status")).toEqual({ result: "not_running" });
  // The CLP profile remains untouched throughout independent process lifecycle.
  expect(readFileSync(clinePassSetupPaths(f.environment, "test").profile, "utf8")).toContain("sk_fixture-key");
});
it("accepts help only for exact public paths and rejects unknown options", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runModelRelayCommand(["upgrade-limits", "-h"]);
    await runModelRelayCommand(["upgrade-limits", "--help"]);
    expect(log).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); }
  expect(() => parseModelRelayCommand(["upgrade-limits", "--force"])).toThrow("用法");
  await expect(runModelRelayCommand(["unknown", "--help"])).rejects.toThrow("用法");
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
  await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--provider", "clp-test", "--model", sample.requestModel]), f.environment);
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
      if (received.length === 3) { pendingStarted(); return; }
      if (input.stream) response.writeHead(200, { "content-type": "text/event-stream" }).end(
        'data: {"model":"vendor/model@2026","choices":[{"delta":{"content":"fixture"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "vendor/model@2026", choices: [{ message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const upstreamAddress = upstream.address(); if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("fixture");
  writePrivateFileAtomicSync(join(f.environment.CODEX_HOME, ".env"), `HTTPS_PROXY=http://127.0.0.1:${upstreamAddress.port}\nNO_PROXY=\n`);
  const issued = await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--provider", "clp-test", "--model", "cline-pass/deepseek-v4.1-flash"]), f.environment);
  const portProbe = createServer(); await new Promise<void>(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const address = portProbe.address(); if (!address || typeof address === "string") throw new Error("fixture");
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const document = parse(readFileSync(f.configPath, "utf8")); Object.assign(document.model_relay!, { enabled: false, port: address.port });
  writePrivateFileAtomicSync(f.configPath, stringify(document));
  const service = await startModelRelayService(f.configPath, f.environment); cleanups.push(() => service.close());
  await manageModelRelay(parseModelRelayCommand(["enable"]), f.environment);
  let key = issued.key;
  for (const stream of [false, true]) {
    if (stream) key = (await manageModelRelay(parseModelRelayCommand(["rotate", "--caller", "client"]), f.environment)).key;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST",
      headers: { authorization: `Bearer ${String(key)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "cline-pass/deepseek-v4.1-flash", messages: [{ role: "user", content: "fixture" }], stream }) });
    expect(response.status).toBe(200); expect(await response.text()).toContain("fixture");
  }
  // Default rate limits are disabled: further requests need no refill wait.
  const pending = fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: "POST",
    headers: { authorization: `Bearer ${String(key)}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "cline-pass/deepseek-v4.1-flash", messages: [{ role: "user", content: "pending" }] }) })
    .then(async response => { await response.text(); }, () => undefined);
  await pendingUpstream;
  await manageModelRelay(parseModelRelayCommand(["disable"]), f.environment);
  await pending;
  await service.close(); await writer.waitForCurrentWrites();
  const rows = store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, source: "relay", callerId: "client", limit: 10 });
  expect(rows.records).toHaveLength(3); expect(received).toHaveLength(3);
  for (const row of rows.records) expect(row).toMatchObject({ callerId: "client", keyId: "key", threadId: null, turnId: null });
  const completed = rows.records.filter(row => row.status === "completed");
  expect(completed).toHaveLength(2);
  for (const row of completed) expect(row).toMatchObject({ deliveryStatus: "finished", responseModel: "vendor/model@2026" });
  expect(completed.map(row => row.credentialGeneration).sort()).toEqual([1, 2]);
  expect(completed.map(row => row.inputTokens).sort()).toEqual([2, 3]);
  expect(rows.records.find(row => row.status === "failed")).toMatchObject({ credentialGeneration: 2 });
}, 15_000);

it("explicitly backs up and upgrades only legacy limits, preserving credentials and refusing malformed input", async () => {
  const f = await fixture();
  await manageModelRelay(parseModelRelayCommand(["issue", "--caller", "client", "--key", "key", "--provider", "clp-test", "--model", "cline-pass/deepseek-v4.1-flash"]), f.environment);
  const document = parse(readFileSync(f.configPath, "utf8"));
  const current = gatewayConfig.validateGatewayConfigDocument(document).model_relay!;
  const legacy = { ...current, max_concurrency: 7, requests_per_minute: 40, burst: 3,
    accounts: current.accounts.map(value => ({ ...value, max_concurrency: 4, requests_per_minute: 20, burst: 2 })),
    callers: current.callers.map(value => ({ ...value, credential_generation: 9, enabled: false, max_concurrency: 2, requests_per_minute: 10, burst: 1 })) };
  const original = stringify({ ...document, model_relay: legacy });
  writePrivateFileAtomicSync(f.configPath, original);
  const command = parseModelRelayCommand(["upgrade-limits"]);
  const readPrivate = privateFile.readPrivateFileSync;
  const failedBackup = vi.spyOn(privateFile, "readPrivateFileSync").mockImplementation((path, maxBytes) =>
    String(path).endsWith(".bak") ? "fixture mismatched backup" : readPrivate(path, maxBytes));
  try {
    await expect(manageModelRelay(command, f.environment)).rejects.toThrow("备份校验失败");
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
  } finally { failedBackup.mockRestore(); }
  const failedWrite = vi.spyOn(gatewayConfig, "writeGatewayConfig").mockImplementation(() => { throw new Error("fixture write failure"); });
  try {
    await expect(manageModelRelay(command, f.environment)).rejects.toThrow("fixture write failure");
    expect(readFileSync(f.configPath, "utf8")).toBe(original);
    const backups = readdirSync(dirname(f.configPath)).filter(name => name.includes(".relay-") && name.endsWith(".bak"));
    expect(backups.some(name => readFileSync(join(dirname(f.configPath), name), "utf8") === original)).toBe(true);
  } finally { failedWrite.mockRestore(); }
  const upgraded = await manageModelRelay(command, f.environment);
  expect(upgraded.result).toBe("upgraded"); expect(readFileSync(String(upgraded.backupPath), "utf8")).toBe(original);
  if (process.platform !== "win32") expect(statSync(String(upgraded.backupPath)).mode & 0o777).toBe(0o600);
  const saved = gatewayConfig.validateGatewayConfigDocument(parse(readFileSync(f.configPath, "utf8"))).model_relay!;
  expect(saved).toEqual({ ...current, max_concurrency: 7, requests_per_minute: 40, burst: 3,
    callers: current.callers.map(value => ({ ...value, credential_generation: 9, enabled: false })) });
  const after = readFileSync(f.configPath, "utf8");
  expect(await manageModelRelay(command, f.environment)).toEqual({ result: "unchanged", backupPath: null });
  expect(readFileSync(f.configPath, "utf8")).toBe(after);
  const malformed = stringify({ ...document, model_relay: { ...legacy, accounts: [{ provider: "clp-test", max_concurrency: 0 }] } });
  writePrivateFileAtomicSync(f.configPath, malformed);
  await expect(manageModelRelay(command, f.environment)).rejects.toThrow();
  expect(readFileSync(f.configPath, "utf8")).toBe(malformed);
});
