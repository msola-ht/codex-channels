import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { clineRelayCatalogPath, clineRelayReasoningEfforts, parseClineRelayCatalog, readClineRelayCatalog, saveClineRelayCatalog } from "../scripts/cline-relay-catalog.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { clineRelayInputModalities, type ClineRelayModel } from "../runtime/cline-relay-catalog.mjs";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const commit = "a".repeat(40);
const model: ClineRelayModel = { id: "cline-pass/muse", name: "Muse", capabilities: ["tools", "reasoning"], reasoningOptions: [{ type: "effort", values: ["minimal", "low", "high"] }] };
const source = (entry: unknown = model) => `export const GENERATED_PROVIDER_MODELS = {\n  version: 1,\n  providers: ${JSON.stringify({ "cline-pass": { [model.id]: entry, "cline-free/other": { id: "cline-free/other" } } })}\n}\n`;
it("retains explicit modalities and maps compact Cline capability declarations", () => {
  const modalities = { input: ["text", "image", "audio", "video"], output: ["text"] };
  const catalog = parseClineRelayCatalog(source({ ...model, modalities }), commit, 100);
  expect(catalog.models[0]?.modalities).toEqual(modalities);
  expect(clineRelayInputModalities(catalog.models[0]!)).toEqual(modalities.input);
  expect(clineRelayInputModalities({ ...model, capabilities: ["images", "video", "files"] })).toEqual(["text", "image", "video", "pdf"]);
  expect(clineRelayInputModalities({ id: "unknown" })).toEqual([]);
  expect(clineRelayInputModalities({ ...model, capabilities: [] })).toEqual([]);
  expect(clineRelayInputModalities({ ...model, capabilities: ["images"], modalities: { input: ["audio"], output: ["text"] } })).toEqual(["audio"]);
});
it("extracts only Cline Pass data without executing generated source and preserves explicit controls", () => {
  const catalog = parseClineRelayCatalog(source(), commit, 100);
  expect(catalog.models).toHaveLength(1);
  expect(clineRelayReasoningEfforts(catalog.models[0]!)).toEqual(["minimal", "low", "high"]);
  expect(clineRelayReasoningEfforts({ id: "unknown" })).toEqual([]);
  expect(clineRelayReasoningEfforts({ id: "budget", reasoningOptions: [{ type: "budget_tokens", min: 1, max: 100 }] })).toEqual([]);
  expect(clineRelayReasoningEfforts({ id: "toggle", reasoningOptions: [{ type: "toggle" }, { type: "effort", values: [null, "default", "high"] }] })).toEqual(["none", "high"]);
  expect(() => parseClineRelayCatalog(source() + 'process.exit(1)', commit)).toThrow();
  expect(() => parseClineRelayCatalog(source({ ...model, id: "different" }), commit)).toThrow();
  expect(() => parseClineRelayCatalog(source({ ...model, reasoningOptions: [{ type: "effort", values: ["unknown"] }] }), commit)).toThrow();
  expect(() => parseClineRelayCatalog(source(), "main")).toThrow();
});
it("atomically saves a separate catalog with a recoverable backup and leaves configuration untouched", () => {
  const directory = mkdtempSync("/tmp/clcat-"); directories.push(directory);
  const configPath = join(directory, "config.toml");
  const environment = { CODEX_CONNECT_CONFIG_FILE: configPath };
  writePrivateFileAtomicSync(configPath, "version = 1\n");
  expect(readClineRelayCatalog(environment)).toEqual({ status: "missing" });
  const first = parseClineRelayCatalog(source(), commit, 100);
  expect(saveClineRelayCatalog(first, environment)).toMatchObject({ status: "ready", efforts: { [model.id]: ["minimal", "low", "high"] } });
  const path = clineRelayCatalogPath(environment);
  const before = readFileSync(path, "utf8");
  saveClineRelayCatalog({ ...first, commit: "b".repeat(40), downloadedAt: 200 }, environment);
  expect(readFileSync(`${path}.backup`, "utf8")).toBe(before);
  const updated = readFileSync(path, "utf8");
  expect(() => saveClineRelayCatalog({ ...first, models: [] }, environment)).toThrow();
  expect(readFileSync(path, "utf8")).toBe(updated);
  expect(readFileSync(configPath, "utf8")).toBe("version = 1\n");
  writePrivateFileAtomicSync(path, before);
  expect(readClineRelayCatalog(environment)).toMatchObject({ status: "ready", catalog: { commit } });
});

it("rejects invalid catalog versions instead of falling back to Codex files", () => {
  const directory = mkdtempSync("/tmp/clcat-"); directories.push(directory);
  const environment = { CODEX_CONNECT_CONFIG_FILE: join(directory, "config.toml") };
  writePrivateFileAtomicSync(environment.CODEX_CONNECT_CONFIG_FILE, "version = 1\n");
  writePrivateFileAtomicSync(clineRelayCatalogPath(environment), JSON.stringify({ version: 2, models: [] }));
  expect(readClineRelayCatalog(environment)).toEqual({ status: "invalid" });
});
