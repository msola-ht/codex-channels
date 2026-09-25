import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "smol-toml";
import { applyClinePassConfiguration, clinePassSetupPaths, removeClinePassConfiguration } from "../scripts/cline-pass-setup.mjs";
import { loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
vi.mock("../scripts/model-catalog-validation.mjs", () => ({ validateModelCatalogWithCodex: async () => undefined }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cline-setup-")); roots.push(root);
  const environment = { CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
  const paths = clinePassSetupPaths(environment);
  writePrivateFileAtomicSync(paths.config, 'model_provider = "openai"\nmodel = "fixture-original"\n');
  return { environment, paths };
}
it("isolates switching credentials and restores exclusive configuration on removal", async () => {
  const { environment, paths } = fixture();
  const input = { apiKey: "sk_fixture-key", contextWindow: 64000 };
  const original = readFileSync(paths.config, "utf8");
  await applyClinePassConfiguration(input, { environment });
  expect(readFileSync(paths.config, "utf8")).toBe(original);
  expect(readFileSync(paths.profile, "utf8")).toContain('wire_api = "responses"');
  expect(JSON.parse(readFileSync(paths.catalog, "utf8"))).toMatchObject({ models: [{ input_modalities: ["text", "image"] }] });
  expect(loadManagedModelProviderSettings(environment)).toContainEqual(expect.objectContaining({ provider: "cline-pass", mode: "switching" }));
  if (process.platform !== "win32") expect(statSync(paths.profile).mode & 0o777).toBe(0o600);
  await expect(applyClinePassConfiguration({ ...input, mode: "exclusive" }, { environment })).rejects.toThrow("必须确认");
  await applyClinePassConfiguration({ ...input, mode: "exclusive", confirmExclusiveConfigChange: true }, { environment });
  expect(parse(readFileSync(paths.config, "utf8")).model_provider).toBe("cline-pass");
  expect(existsSync(paths.profile)).toBe(false);
  await removeClinePassConfiguration({ confirmRemove: true }, { environment, resolvePrimarySocket: () => join(roots[0]!, "unused.sock"), inspectSupervisor: async () => ({ status: "missing" }) });
  expect(parse(readFileSync(paths.config, "utf8"))).toEqual(parse(original));
  expect(existsSync(paths.marker)).toBe(false);
  expect(existsSync(paths.backup)).toBe(true);
});
it("rejects invalid keys and preserves existing configuration", async () => {
  const { environment, paths } = fixture();
  const before = readFileSync(paths.config, "utf8");
  await expect(applyClinePassConfiguration({ apiKey: 'secret\ninvalid', contextWindow: 64000 }, { environment })).rejects.toThrow("API Key 无效");
  expect(readFileSync(paths.config, "utf8")).toBe(before);
  expect(existsSync(paths.marker)).toBe(false);
});
