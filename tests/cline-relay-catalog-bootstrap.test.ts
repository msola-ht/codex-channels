import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClineRelayCatalogBootstrap } from "../runtime/cline-relay-catalog-bootstrap.mjs";
import * as update from "../runtime/cline-relay-catalog-update.mjs";
import { clineRelayCatalogPath, readClineRelayCatalog, type ClineRelayCatalog } from "../runtime/cline-relay-catalog.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";

const directories: string[] = [];
const owners: Array<ReturnType<typeof createClineRelayCatalogBootstrap>> = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const catalog: ClineRelayCatalog = { version: 1, commit: "a".repeat(40), downloadedAt: 1, models: [{ id: "cline-pass/test" }] };
function fixture() {
  const home = mkdtempSync("/tmp/clauto-"); directories.push(home);
  const environment = { CODEX_CONNECT_HOME: home, CODEX_CONNECT_CONFIG_FILE: join(home, "config.toml") };
  writePrivateFileAtomicSync(environment.CODEX_CONNECT_CONFIG_FILE, "version = 1\n");
  const ready = vi.fn(), failed = vi.fn();
  const owner = createClineRelayCatalogBootstrap(environment, { ready, failed }); owners.push(owner);
  return { environment, ready, failed, owner };
}
it("downloads a missing catalog once in the background and publishes it without configuration changes", async () => {
  const f = fixture();
  let complete!: (value: ClineRelayCatalog) => void;
  const download = vi.spyOn(update, "downloadClineRelayCatalog").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  expect(f.owner.ensure()).toBeUndefined(); f.owner.ensure();
  expect(download).toHaveBeenCalledTimes(1);
  expect(readClineRelayCatalog(f.environment).status).toBe("missing");
  complete(catalog);
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce());
  expect(readClineRelayCatalog(f.environment)).toMatchObject({ status: "ready", catalog });
  expect(f.failed).not.toHaveBeenCalled();
});
it("does not overwrite a manual update completed while the automatic download was in flight", async () => {
  const f = fixture();
  let complete!: (value: ClineRelayCatalog) => void;
  vi.spyOn(update, "downloadClineRelayCatalog").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  f.owner.ensure();
  update.saveClineRelayCatalog({ ...catalog, commit: "b".repeat(40) }, f.environment);
  complete(catalog);
  await vi.waitFor(() => expect(f.ready).toHaveBeenCalledOnce());
  expect(readClineRelayCatalog(f.environment)).toMatchObject({ catalog: { commit: "b".repeat(40) } });
});
it("reports failure once and never loops on each material refresh", async () => {
  const f = fixture();
  const download = vi.spyOn(update, "downloadClineRelayCatalog").mockRejectedValue(new Error("network"));
  f.owner.ensure();
  await vi.waitFor(() => expect(f.failed).toHaveBeenCalledOnce());
  for (let index = 0; index < 10; index++) f.owner.ensure();
  expect(download).toHaveBeenCalledTimes(1);
  expect(readClineRelayCatalog(f.environment).status).toBe("missing");
});
it("reuses valid files and leaves malformed files for explicit repair", () => {
  const f = fixture();
  const download = vi.spyOn(update, "downloadClineRelayCatalog");
  update.saveClineRelayCatalog(catalog, f.environment); f.owner.ensure();
  writePrivateFileAtomicSync(clineRelayCatalogPath(f.environment), "invalid"); f.owner.ensure();
  expect(download).not.toHaveBeenCalled();
});
it("aborts on shutdown and prevents a late response from creating the file", async () => {
  const f = fixture();
  let complete!: (value: ClineRelayCatalog) => void;
  const download = vi.spyOn(update, "downloadClineRelayCatalog").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  f.owner.ensure();
  const closing = f.owner.close();
  expect(download.mock.calls[0]?.[1]?.aborted).toBe(true);
  complete(catalog); await closing;
  expect(readClineRelayCatalog(f.environment).status).toBe("missing");
  expect(f.ready).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
});
