import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ path: "", observeWrite: undefined as ((path: string) => void) | undefined }));
vi.mock("../runtime/private-file.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/private-file.mjs")>();
  return {
    ...actual,
    writePrivateFileAtomic: async (...args: Parameters<typeof actual.writePrivateFileAtomic>) => {
      failure.observeWrite?.(args[0]);
      if (args[0] === failure.path) throw new Error("injected restore failure");
      return actual.writePrivateFileAtomic(...args);
    },
  };
});

import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { addProviderFileArchive, applyProviderFileUpdates, restoreProviderFileSnapshots, snapshotProviderFiles } from "../scripts/managed-provider-files.mjs";
import { applyManagedProviderAccountConfiguration, planManagedProviderAccountConfiguration } from "../scripts/managed-model-provider-setup.mjs";
import { ccgAccountDefinition, clinePassAccountDefinition, deepseekAccountDefinition } from "../runtime/model-provider-definitions.mjs";

const directories: string[] = [];
afterEach(() => {
  failure.path = "";
  failure.observeWrite = undefined;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.each([
  { family: "DS", definitionFor: deepseekAccountDefinition, apiKey: "sk-fixture", model: "deepseek-flash" },
  { family: "CCG", definitionFor: ccgAccountDefinition, apiKey: "cmd_fixture", model: "deepseek/deepseek-v4-flash" },
  { family: "CLP", definitionFor: clinePassAccountDefinition, apiKey: "sk_fixture", model: "cline-pass/deepseek-v4.1-flash" },
])("$family account publication", ({ definitionFor, apiKey, model }) => {
  it.each(["switching", "exclusive"] as const)("writes dependencies before publishing %s configuration", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "provider-publication-"));
    directories.push(directory);
    const definition = definitionFor("test");
    const paths = {
      config: join(directory, "config.toml"), backup: join(directory, "backup.json"),
      profile: join(directory, "profile.toml"), marker: join(directory, "marker.toml"),
      registry: join(directory, "accounts.json"), catalog: join(directory, "models.json"),
      manifest: join(directory, "manifest.json"),
    };
    const original = 'model_provider = "openai"\n';
    writePrivateFileAtomicSync(paths.config, original);
    const snapshots = snapshotProviderFiles(Object.values(paths));
    const catalog = { models: [{ slug: model, default_reasoning_level: "high" }] };
    const { updates } = planManagedProviderAccountConfiguration({ model_provider: "openai" }, undefined, definition, {
      paths, mode, apiKey, catalog, model,
    });
    const accounts = [{ id: "test", default: true }];
    updates.set(paths.registry, JSON.stringify(accounts));
    updates.set(paths.catalog, JSON.stringify(catalog));
    updates.set(paths.manifest, "{}");
    const writes: string[] = [];
    failure.observeWrite = path => {
      writes.push(path);
      if ([paths.profile, paths.marker, paths.registry, paths.config].includes(path)) {
        expect(JSON.parse(readFileSync(paths.catalog, "utf8"))).toEqual(catalog);
        expect(JSON.parse(readFileSync(paths.manifest, "utf8"))).toEqual({});
      }
      if (path === paths.config) {
        expect(JSON.parse(readFileSync(paths.registry, "utf8"))).toEqual(accounts);
        expect(readFileSync(paths.marker, "utf8")).toContain(definition.id);
      }
    };
    await applyManagedProviderAccountConfiguration(updates, snapshots, paths);
    if (mode === "exclusive") expect(writes.at(-1)).toBe(paths.config);
    else expect(readFileSync(paths.config, "utf8")).toBe(original);
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "provider-rollback-"));
  directories.push(directory);
  const paths = [join(directory, "first.json"), join(directory, "second.json")];
  for (const path of paths) writePrivateFileAtomicSync(path, "before");
  const snapshots = snapshotProviderFiles(paths);
  for (const path of paths) writePrivateFileAtomicSync(path, "after");
  return { paths, snapshots, guards: snapshotProviderFiles(paths) };
}

describe("managed Provider file rollback", () => {
  it("preserves the old baseline when writing its archive fails", async () => {
    const { paths } = fixture();
    const source = paths[0]!;
    const archive = join(dirname(source), "archive.json");
    const snapshots = snapshotProviderFiles([source]);
    const updates = new Map<string, string | Uint8Array | undefined>([[source, "new baseline"]]);
    addProviderFileArchive(updates, snapshots, source, archive);
    failure.path = archive;
    await expect(applyProviderFileUpdates(updates, snapshots)).rejects.toThrow("injected restore failure");
    expect(readFileSync(source, "utf8")).toBe("after");
  });

  it("does not overwrite an occupied archive or add it to the rollback plan", () => {
    const { paths, snapshots } = fixture();
    const updates = new Map<string, string | Uint8Array | undefined>();
    const before = [...snapshots];
    expect(() => addProviderFileArchive(updates, snapshots, paths[0]!, paths[1]!))
      .toThrow("归档路径已被占用");
    expect(updates.size).toBe(0);
    expect(snapshots).toEqual(before);
    expect(readFileSync(paths[1]!, "utf8")).toBe("after");
  });

  it("restores remaining files after one restoration fails", async () => {
    const { paths, snapshots, guards } = fixture();
    failure.path = paths[0]!;
    await expect(restoreProviderFileSnapshots(snapshots, guards)).rejects.toThrow("回滚未完成");
    expect(readFileSync(paths[0]!, "utf8")).toBe("after");
    expect(readFileSync(paths[1]!, "utf8")).toBe("before");
  });

  it("rejects rollback when files have changed outside the transaction", async () => {
    const { paths, snapshots, guards } = fixture();
    writePrivateFileAtomicSync(paths[0]!, "external change");
    await expect(restoreProviderFileSnapshots(snapshots, guards)).rejects.toThrow("事务期间发生变化");
    expect(readFileSync(paths[0]!, "utf8")).toBe("external change");
    expect(readFileSync(paths[1]!, "utf8")).toBe("after");
  });
});
