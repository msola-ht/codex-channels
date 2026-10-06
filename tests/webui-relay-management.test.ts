import * as clineCatalog from "../scripts/cline-relay-catalog.mjs";
import { saveClineRelayCatalog } from "../scripts/cline-relay-catalog.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";
import { manageModelRelay, parseModelRelayCommand } from "../scripts/model-relay-command.mjs";
import * as providerRuntime from "../runtime/model-provider-runtime.mjs";
import * as relayControl from "../runtime/model-relay-control.mjs";
import * as fileLock from "../runtime/private-file-lock.mjs";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupWebuiTestFixtures, createWebuiTestFixture, startWebuiTestServer, type WebuiTestServer } from "./webui-server-test-fixture.js";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { applyClinePassConfiguration } from "../scripts/cline-pass-account-management.mjs";
import type { RelayManagementSnapshot, RelayManagementResult, RelayManagementInput } from "../scripts/webui-api.js";

vi.mock("../scripts/model-catalog-validation.mjs", () => ({ validateModelCatalogWithCodex: async () => undefined }));
const directories: string[] = [], servers: WebuiTestServer[] = [];
afterEach(async () => cleanupWebuiTestFixtures(servers, directories));
async function fixture() {
  const f = createWebuiTestFixture(directories);
  writePrivateFileAtomicSync(join(f.home, "config.toml"), 'version = 1\ndefault_workspace = "main"\n[codex]\n[telegram]\nbot_token="fixture"\nallowed_user_ids=[1]\n[[workspaces]]\nid="main"\nname="Main"\ncwd="/tmp"\n');
  writePrivateFileAtomicSync(join(f.home, "providers/deepseek/models.json"), JSON.stringify({ models: [{
    slug: "deepseek-flash", display_name: "Fixture", visibility: "list", supported_in_api: true,
    context_window: 64000, max_context_window: 128000, input_modalities: ["text"], default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "high", description: "High" }], model_messages: { instructions_template: "fixture" },
  }] }));
  await applyClinePassConfiguration({ accountId: "test", apiKey: "UPSTREAM-SECRET" }, { environment: f.environment });
  saveClineRelayCatalog({ version: 1, commit: "a".repeat(40), downloadedAt: 1,
    models: [{ id: "cline-pass/deepseek-v4.1-flash", reasoningOptions: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }] }] }, f.environment);
  const managementOrigin = "http://127.0.0.1:0";
  const { origin } = await startWebuiTestServer(servers, f.environment, undefined, { managementOrigin, token: "admin-secret" });
  const headers = { origin: managementOrigin, authorization: "Bearer admin-secret", "content-type": "application/json" };
  const url = `${origin}/api/v1/management/relay`;
  const snapshot = async () => await (await fetch(url, { headers })).json() as RelayManagementSnapshot;
  const post = (path: string, value: unknown) => fetch(`${url}/${path}`, { method: "POST", headers, body: JSON.stringify(value) });
  return { ...f, url, headers, snapshot, post };
}
it("exposes bounded runtime status separately from configured concurrency", async () => {
  const f = await fixture();
  expect(await f.snapshot()).toMatchObject({ maxConcurrency: 10, runtime: { state: "stopped" } });
  const query = vi.spyOn(relayControl, "queryModelRelayControl");
  try {
    query.mockResolvedValueOnce({ result: "status", listening: true, configurationValid: true, active: 4, queue: { pending: 3, waiting: 2, bytes: 100, oldestWaitMs: 1200, timedOut: 3 }, capture: { enabled: true, state: "ready", active: 2, skippedCapacity: 1, secret: "DO-NOT-EXPOSE" }, metrics: { accepted: 10, unconfirmed: 2, rejected: 1, local_dropped: 3 }, secret: "DO-NOT-EXPOSE" });
    const running = await f.snapshot();
    expect(running.runtime).toEqual({ state: "running", listening: true, configurationValid: true, active: 4, waiting: 2, uploading: 1, oldestWaitMs: 1200, queueTimeouts: 3, capture: { enabled: true, state: "ready", active: 2, skippedCapacity: 1 }, metrics: { accepted: 10, unconfirmed: 2, rejected: 1, localDropped: 3 } });
    expect(JSON.stringify(running)).not.toContain("DO-NOT-EXPOSE");
    query.mockResolvedValueOnce({ result: "unconfirmed" });
    expect((await f.snapshot()).runtime).toEqual({ state: "unknown" });
  } finally { query.mockRestore(); }
});

it("exposes Cline catalog modalities through the Relay management API", async () => {
  const f = await fixture();
  saveClineRelayCatalog({ version: 1, commit: "a".repeat(40), downloadedAt: 1, models: [
    { id: "cline-pass/mimo", modalities: { input: ["text", "image", "audio", "video"], output: ["text"] } },
    { id: "cline-pass/muse", capabilities: ["images", "video", "files", "tools", "reasoning"] },
    { id: "cline-pass/unknown" },
    { id: "cline-pass/toggle", reasoningOptions: [{ type: "toggle" }] },
  ] }, f.environment);
  expect((await f.snapshot()).providers[0]?.models).toEqual([
    { id: "cline-pass/mimo", relayId: "clp-test/mimo", reasoningOff: false, inputModalities: ["text", "image", "audio", "video"] },
    { id: "cline-pass/muse", relayId: "clp-test/muse", reasoningOff: false, inputModalities: ["text", "image", "video", "pdf"] },
    { id: "cline-pass/unknown", relayId: "clp-test/unknown", reasoningOff: false, inputModalities: [] },
    { id: "cline-pass/toggle", relayId: "clp-test/toggle", reasoningOff: true, inputModalities: [] },
  ]);
  expect((await f.snapshot()).providers[0]).not.toHaveProperty("extraModels");
});

it("shows only declared input formats and keeps unknown capabilities explicit", async () => {
  const f = await fixture();
  const original = providerRuntime.loadConfiguredRelayProviderMaterial;
  const read = vi.spyOn(providerRuntime, "loadConfiguredRelayProviderMaterial");
  try {
    for (const [inputs, expected] of [
      [["text", "image", "audio", "text"], ["text", "image", "audio"]],
      [[], []], [["text", "unrecognized"], []], [[{ secret: "DO-NOT-EXPOSE" }], []],
    ]) {
      read.mockImplementation((...args) => {
        const material = original(...args);
        return { ...material, modelInputs: Object.fromEntries(material.models.map(model => [model, inputs!])) };
      });
      const snapshot = await f.snapshot();
      expect(snapshot.providers[0]?.available).toBe(true);
      expect(snapshot.providers[0]?.models[0]?.inputModalities).toEqual(expected);
      expect(JSON.stringify(snapshot)).not.toContain("DO-NOT-EXPOSE");
    }
  } finally { read.mockRestore(); }
});

const input: Extract<RelayManagementInput, { command: "issue" }> = { command: "issue", name: "沉浸式翻译", caller: "translation", key: "translation-key", models: ["clp-test/deepseek-v4.1-flash"],
  reasoning: "off" };

it("saves a revision-bound rename without downloading a missing catalog", async () => {
  const f = await fixture();
  await manageModelRelay({ ...input, reasoning: "passthrough" }, f.environment);
  const catalogPath = clineCatalog.clineRelayCatalogPath(f.environment);
  unlinkSync(catalogPath);
  const download = vi.spyOn(clineCatalog, "downloadClineRelayCatalog").mockRejectedValue(new Error("must not download"));
  try {
    const body = { input: { command: "edit", caller: input.caller, models: input.models, name: "改名", reasoning: "passthrough" }, revision: (await f.snapshot()).revision };
    const previewResponse = await f.post("preview", body);
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { confirmationToken: string };
    expect((await f.post("apply", { ...body, confirmationToken: preview.confirmationToken })).status).toBe(200);
    expect(download).not.toHaveBeenCalled();
    expect(existsSync(catalogPath)).toBe(false);
    expect((await f.snapshot()).callers[0]).toMatchObject({ display_name: "改名", models: input.models });
  } finally { download.mockRestore(); }
});

it("does not auto-download a missing catalog while previewing model changes", async () => {
  const f = await fixture();
  const catalogPath = clineCatalog.clineRelayCatalogPath(f.environment);
  unlinkSync(catalogPath);
  const download = vi.spyOn(clineCatalog, "downloadClineRelayCatalog").mockRejectedValue(new Error("must not download"));
  try {
    const before = readFileSync(join(f.home, "config.toml"), "utf8");
    const response = await f.post("preview", { input: { command: "models", provider: "clp-test", extraModels: [{ id: "cline-pass/deepseek-v4.1-flash", reasoning_efforts: [], reasoning: "passthrough" }] },
      revision: (await f.snapshot()).revision });
    expect(response.status).toBe(400);
    expect(download).not.toHaveBeenCalled();
    expect(existsSync(catalogPath)).toBe(false);
    expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe(before);
  } finally { download.mockRestore(); }
});
it("reads per-key usage across rotations without blocking management when metrics are absent", async () => {
  const f = await fixture();
  await manageModelRelay(input, f.environment);
  const before = await f.snapshot();
  expect(before.usage).toBeNull();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const store = new SqliteModelRequestMetricsStore(f.databasePath);
  try {
    const record = (time: number, status: "completed" | "failed" | "incomplete" | "unknown", keyId = "translation-key", generation = 1, callerId = "translation") => store.record({
      ...sample(), source: "relay", provider: "clp-test", threadId: null, turnId: null,
      callerId, keyId, credentialGeneration: generation, relayRequestId: randomUUID(), deliveryStatus: "finished",
      requestStartedAtMs: time, responseCompletedAtMs: time + 1, status,
    });
    record(now - 2 * day, "failed");
    record(now - 3000, "completed");
    record(now - 2000, "failed", "translation-key", 2);
    record(now - 1500, "incomplete");
    record(now - 1000, "unknown");
    record(now - 500, "failed", "another-key");
    record(now + day, "failed");
    store.record(sample());
    record(now - 2 * day, "completed", "old-key", 1, "old-caller");
    record(now - day, "completed", "boundary-key", 1, "boundary");
    record(now, "failed", "boundary-key", 1, "boundary");
    record(now - 500, "failed", "translation-key", 1, "other-caller");
    store.record({ ...sample(), source: "relay", threadId: null, turnId: null, deliveryStatus: "finished",
      callerId: "usage-missing", keyId: "usage-missing-key",
      credentialGeneration: 1, relayRequestId: randomUUID(), requestStartedAtMs: now,
      status: "completed", responseFormat: "unknown", model: null,
      inputTokens: null, outputTokens: null, totalTokens: null });
    expect(store.relayCallerUsage([], now - day, now)).toEqual([]);
    expect(store.relayCallerUsage([
      { callerId: "old-caller", keyId: "old-key" }, { callerId: "boundary", keyId: "boundary-key" },
      { callerId: "usage-missing", keyId: "usage-missing-key" },
    ], now - day, now)).toEqual(expect.arrayContaining([
      { callerId: "old-caller", keyId: "old-key", lastRequestAtMs: now - 2 * day, requestCount: 0, unsuccessfulRequestCount: 0 },
      { callerId: "boundary", keyId: "boundary-key", lastRequestAtMs: now, requestCount: 2, unsuccessfulRequestCount: 1 },
      { callerId: "usage-missing", keyId: "usage-missing-key", lastRequestAtMs: now, requestCount: 1, unsuccessfulRequestCount: 0 },
    ]));
    expect(store.relayCallerUsage([{ callerId: "translation", keyId: "translation-key" }], now - day, now)).toEqual([
      { callerId: "translation", keyId: "translation-key", lastRequestAtMs: now - 1000, requestCount: 4, unsuccessfulRequestCount: 3 },
    ]);
    expect(store.relayCallerUsage([{ callerId: "unused", keyId: "unused-key" }], now - day, now)).toEqual([
      { callerId: "unused", keyId: "unused-key", lastRequestAtMs: null, requestCount: 0, unsuccessfulRequestCount: 0 },
    ]);
  } finally { store.close(); }
  const after = await f.snapshot();
  expect(after.revision).toBe(before.revision);
  expect(after.usage?.callers).toEqual([
    { callerId: "translation", keyId: "translation-key", lastRequestAtMs: now - 1000, requestCount: 4, unsuccessfulRequestCount: 3 },
  ]);
  expect(after.usage!.observedAtMs - after.usage!.startAtMs).toBe(day);
});
it("requires auth/origin and confirmation; previews do not sign keys, and writes return a secret only once", async () => {
  const f = await fixture();
  expect((await fetch(f.url)).status).toBe(401);
  const badOrigin = await fetch(`${f.url}/preview`, { method: "POST", headers: { ...f.headers, origin: "https://evil.invalid" }, body: "{}" });
  expect(badOrigin.status).toBe(403);
  const snapshot = await f.snapshot();
  expect(snapshot.providers[0]?.models).toContainEqual({ id: "cline-pass/deepseek-v4.1-flash", relayId: "clp-test/deepseek-v4.1-flash", reasoningOff: true, inputModalities: [] });
  expect(JSON.stringify(snapshot)).not.toContain("UPSTREAM-SECRET");
  const body = { input, revision: snapshot.revision };
  const before = readFileSync(join(f.home, "config.toml"), "utf8");
  const previewResponse = await f.post("preview", body);
  expect(previewResponse.status).toBe(200);
  expect(previewResponse.headers.get("cache-control")).toBe("no-store");
  const preview = await previewResponse.json() as { confirmationToken: string };
  expect(JSON.stringify(preview)).not.toContain("cr1.");
  expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe(before);
  expect((await f.post("apply", body)).status).toBe(409);
  const applied = await f.post("apply", { ...body, confirmationToken: preview.confirmationToken });
  expect(applied.status).toBe(200);
  const saved = await applied.json() as RelayManagementResult;
  expect(saved).toMatchObject({ activation: "saved_not_running", auditStatus: "recorded" });
  expect(saved.key).toMatch(/^cr1.translation-key\./u);
  const after = await f.snapshot();
  expect(after.callers[0]?.reasoning).toBe("off");
  expect(after.callers[0]?.display_name).toBe("沉浸式翻译");
  expect(JSON.stringify(after)).not.toContain(saved.key!);
  expect(JSON.stringify(after)).not.toContain("secret_sha256");
  expect((await f.post("apply", { ...body, confirmationToken: preview.confirmationToken })).status).toBe(409);
});
it("rejects unknown operations and stale configuration before mutation", async () => {
  const f = await fixture();
  const before = readFileSync(join(f.home, "config.toml"), "utf8");
  expect((await f.post("preview", { revision: "0".repeat(64), input })).status).toBe(409);
  const current = await f.snapshot();
  expect((await f.post("preview", { revision: current.revision, input: { command: "enable" } })).status).toBe(400);
  expect((await f.post("preview", { revision: current.revision, input: { ...input, secret_sha256: "unsafe" } })).status).toBe(400);
  expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe(before);
});

it("returns the saved key after transaction cleanup fails and does not send twice", async () => {
  const f = await fixture();
  const body = { input, revision: (await f.snapshot()).revision };
  const preview = await (await f.post("preview", body)).json() as { confirmationToken: string };
  const original = fileLock.withPrivateFileLock;
  const lock = vi.spyOn(fileLock, "withPrivateFileLock").mockImplementation(async (...args) => {
    await original(...args);
    throw new Error("fixture lock cleanup failure");
  });
  try {
    const response = await f.post("apply", { ...body, confirmationToken: preview.confirmationToken });
    expect(response.status).toBe(200);
    const saved = await response.json() as RelayManagementResult;
    expect(saved.cleanupStatus).toBe("failed");
    expect(saved.key).toMatch(/^cr1.translation-key\./u);
    expect((await f.snapshot()).callers).toHaveLength(1);
  } finally { lock.mockRestore(); }
});
it("does not return confirmation or write config when preview cleanup fails", async () => {
  const f = await fixture();
  const body = { input, revision: (await f.snapshot()).revision };
  const before = readFileSync(join(f.home, "config.toml"), "utf8");
  const original = fileLock.withPrivateFileLock;
  const lock = vi.spyOn(fileLock, "withPrivateFileLock").mockImplementation(async (...args) => {
    await original(...args);
    throw new Error("fixture private cleanup failure");
  });
  try {
    const response = await f.post("preview", body);
    expect(response.status).toBe(500);
    const error = await response.text();
    expect(error).not.toContain("confirmationToken");
    expect(error).not.toContain("fixture private cleanup failure");
    expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe(before);
  } finally { lock.mockRestore(); }
});

it.each(["edit", "delete"] as const)("previews and confirms %s with revision and replay protection", async command => {
  const f = await fixture();
  await applyClinePassConfiguration({ accountId: "other", apiKey: "fixture-other" }, { environment: f.environment });
  async function apply(input: RelayManagementInput) {
    const body = { input, revision: (await f.snapshot()).revision };
    const response = await f.post("preview", body); expect(response.status).toBe(200);
    const preview = await response.json() as { confirmationToken: string; preview: { callers: Array<{ models: string[]; display_name?: string }> } };
    const saved = await f.post("apply", { ...body, confirmationToken: preview.confirmationToken });
    expect(saved.status).toBe(200);
    expect((await f.post("apply", { ...body, confirmationToken: preview.confirmationToken })).status).toBe(409);
    return preview.preview;
  }
  await manageModelRelay(parseModelRelayCommand(["issue", "--caller", input.caller, "--key", input.key, "--model", input.models[0]!, "--name", "沉浸式翻译", "--reasoning", "off"]), f.environment);
  const before = (await f.snapshot()).callers[0]!;
  if (command === "edit") {
    const edited = await apply({ command, caller: input.caller, models: ["clp-other/deepseek-v4.1-flash"], reasoning: "off" });
    expect(edited.callers[0]?.models).toEqual(["clp-other/deepseek-v4.1-flash"]);
    expect((await f.snapshot()).callers[0]).toEqual({ ...before, models: ["clp-other/deepseek-v4.1-flash"] });
  } else {
    const deleted = await apply({ command, caller: input.caller });
    expect(deleted.callers[0]).toMatchObject({ display_name: "沉浸式翻译", models: ["clp-test/deepseek-v4.1-flash"] });
    expect((await f.snapshot()).callers).toEqual([]);
  }
});

it("authenticates the live queue endpoint and distinguishes unavailable from empty", async () => {
  const f = await fixture();
  const url = `${f.url}/queue`;
  expect((await fetch(url)).status).toBe(401);
  expect(await (await fetch(url, { headers: f.headers })).json()).toEqual({ state: "stopped" });
  const query = vi.spyOn(relayControl, "queryModelRelayControl");
  try {
    query.mockResolvedValueOnce({ result: "queue", configurationValid: true, enabled: true, listening: true, requests: [] });
    expect(await (await fetch(url, { headers: f.headers })).json()).toEqual({ state: "running", configurationValid: true, enabled: true, listening: true, requests: [] });
    expect(query).toHaveBeenLastCalledWith(expect.any(String), "queue");
    for (const health of [{ configurationValid: true, enabled: false, listening: false }, { configurationValid: false, enabled: false, listening: false }]) {
      query.mockResolvedValueOnce({ result: "queue", ...health, requests: [] });
      expect(await (await fetch(url, { headers: f.headers })).json()).toEqual({ state: "running", ...health, requests: [] });
    }

    query.mockResolvedValueOnce({ result: "unconfirmed" });
    expect(await (await fetch(url, { headers: f.headers })).json()).toEqual({ state: "unknown" });
  } finally { query.mockRestore(); }
});

it("streams authenticated Relay invalidations, preserves control capacity and closes when Relay stops", async () => {
  const f = await fixture();
  const control = new relayControl.ModelRelayControl(modelRelayPaths(join(f.home, "config.toml")).control,
    async () => ({ result: "queue", configurationValid: true, enabled: true, listening: true, requests: [] }));
  await control.start();
  const abort = new AbortController();
  try {
    const url = `${f.url}/queue/events`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { ...f.headers, origin: "https://evil.invalid" } })).status).toBe(403);
    expect((await fetch(`${url}?extra=1`, { headers: f.headers })).status).toBe(400);
    const response = await fetch(url, { headers: f.headers, signal: abort.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const reader = response.body!.getReader();
    const next = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await next()).toBe('data: {"type":"changed"}\n\n');
    for (let i = 0; i < 100; i++) control.changed();
    expect(await next()).toBe('data: {"type":"changed"}\n\n');
    expect(await (await fetch(`${f.url}/queue`, { headers: f.headers })).json()).toMatchObject({ state: "running", requests: [] });
    await control.close();
    expect(await next()).toBe('data: {"type":"unavailable"}\n\n');
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  } finally { abort.abort(); await control.close(); }
});

it("downloads Cline metadata without changing keys or policies and retains the old file on failure", async () => {
  const f = await fixture();
  const before = readFileSync(join(f.home, "config.toml"), "utf8");
  const revision = (await f.snapshot()).revision;
  const download = vi.spyOn(clineCatalog, "downloadClineRelayCatalog");
  try {
    const catalog = { version: 1 as const, commit: "a".repeat(40), downloadedAt: 100,
      models: [{ id: "cline-pass/muse", reasoningOptions: [{ type: "effort" as const, values: ["high" as const] }] }] };
    download.mockResolvedValue(catalog);
    expect((await f.post("catalog/update", { url: "https://untrusted.invalid" })).status).toBe(400);
    expect(download).not.toHaveBeenCalled();
    expect((await fetch(`${f.url}/catalog/update`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).not.toBe(200);
    expect(download).not.toHaveBeenCalled();
    const result = await f.post("catalog/update", {}); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ catalog: { status: "ready", efforts: { "cline-pass/muse": ["high"] } } });
    const updated = await f.snapshot();
    expect(updated.revision).not.toBe(revision);
    expect(updated.callers).toEqual([]);
    expect(updated.providers[0]).not.toHaveProperty("extraModels");
    expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe(before);
    const path = clineCatalog.clineRelayCatalogPath(f.environment);
    const saved = readFileSync(path, "utf8");
    download.mockRejectedValue(new Error("PRIVATE-UPSTREAM-ERROR"));
    const failure = await f.post("catalog/update", {}); expect(failure.status).toBe(502);
    expect(await failure.text()).not.toContain("PRIVATE-UPSTREAM-ERROR");
    expect(readFileSync(path, "utf8")).toBe(saved);
    const mutation = { command: "models" as const, provider: "clp-test", extraModels: [{ id: "cline-pass/muse", reasoning_efforts: ["none" as const], reasoning: "none" as const }] };
    expect((await f.post("preview", { revision: updated.revision, input: mutation })).status).toBe(400);
  } finally { download.mockRestore(); }
});

it("authorizes selected models across providers without granting later catalog entries", async () => {
  const f = await fixture();
  await applyClinePassConfiguration({ accountId: "other", apiKey: "fixture-other" }, { environment: f.environment });
  const models = ["clp-test/deepseek-v4.1-flash", "clp-other/deepseek-v4.1-flash"];
  const before = readFileSync(join(f.home, "config.toml"), "utf8");
  for (const invalidModels of [[], [models[0], models[0]], ["deepseek-v4.1-flash"], ["clp-test/cline-pass/deepseek-v4.1-flash"], ["clp-test/unknown"], ["unknown/deepseek-v4.1-flash"]]) {
    expect((await f.post("preview", { input: { ...input, models: invalidModels }, revision: (await f.snapshot()).revision })).status).toBe(400);
    expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe(before);
  }
  const body = { input: { ...input, models }, revision: (await f.snapshot()).revision };
  const previewResponse = await f.post("preview", body);
  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json() as { confirmationToken: string };
  expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe(before);
  expect((await f.post("apply", { ...body, confirmationToken: preview.confirmationToken })).status).toBe(200);
  const saved = (await f.snapshot()).callers[0]!;
  expect(saved.models).toEqual(models);
  expect(saved).not.toHaveProperty("provider");
  expect(saved).not.toHaveProperty("secret_sha256");
  saveClineRelayCatalog({ version: 1, commit: "b".repeat(40), downloadedAt: 2, models: [
    { id: "cline-pass/deepseek-v4.1-flash" }, { id: "cline-pass/new-model" },
  ] }, f.environment);
  expect((await f.snapshot()).callers[0]?.models).toEqual(models);
  const editBody = { input: { command: "edit", caller: input.caller, models: [models[1]], reasoning: "off" }, revision: (await f.snapshot()).revision };
  const editResponse = await f.post("preview", editBody);
  expect(editResponse.status).toBe(200);
  const editPreview = await editResponse.json() as { confirmationToken: string };
  saveClineRelayCatalog({ version: 1, commit: "c".repeat(40), downloadedAt: 3, models: [{ id: "cline-pass/new-model" }] }, f.environment);
  expect((await f.post("apply", { ...editBody, confirmationToken: editPreview.confirmationToken })).status).toBe(409);
  expect((await f.snapshot()).callers[0]?.models).toEqual(models);
});
