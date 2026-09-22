import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ path: "" }));
vi.mock("../runtime/private-file.mjs", async (original) => {
  const actual = await original<typeof import("../runtime/private-file.mjs")>();
  return { ...actual, writePrivateFileAtomic: async (...args: Parameters<typeof actual.writePrivateFileAtomic>) => {
    if (args[0] === failure.path) throw new Error("injected write failure");
    return actual.writePrivateFileAtomic(...args);
  } };
});
import { writePrivateFileAtomicSync as write } from "../runtime/private-file.mjs";
import { hasLegacyOpencodeGoConfiguration, previewLegacyOpencodeGoRemoval, removeLegacyOpencodeGoAccount } from "../scripts/opencode-go-account-management.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
import { runOpencodeGoAccountCli } from "../scripts/opencode-go-setup.mjs";

const homes: string[] = [];
function fixture(mode: "switching" | "exclusive", accountId?: string) {
  const home = mkdtempSync(join(tmpdir(), "ocg-legacy-removal-"));
  homes.push(home);
  const environment = { ...process.env, CODEX_HOME: join(home, "codex"), CODEX_CONNECT_HOME: join(home, "connect") };
  initializeUserData({ environment, cwd: home });
  const directory = join(environment.CODEX_CONNECT_HOME, "providers", "opencode-go");
  const provider = accountId === undefined ? "opencode-go" : `opencode-go-${accountId}`;
  const marker = join(directory, ...(accountId === undefined ? [] : ["accounts", accountId]), "managed.toml");
  const profile = join(environment.CODEX_HOME, `sf-${provider}.config.toml`);
  const config = join(environment.CODEX_HOME, "config.toml");
  const backup = join(directory, "backup", "config.toml");
  const registry = join(directory, "accounts.json");
  const catalog = join(directory, "models.json");
  write(marker, stringify({ version: 1, provider, mode }));
  write(config, stringify({ model: "original", personal_setting: "keep" }));
  write(backup, 'model = "original"\n');
  write(catalog, '{"models":[]}\n');
  write(mode === "exclusive" ? config : profile, stringify({
    model: "old-model", model_provider: provider, personal_setting: "keep",
    model_providers: { [provider]: { name: provider, experimental_bearer_token: "sk-fixture" } },
  }));
  if (accountId !== undefined) write(registry, JSON.stringify([{ id: accountId, default: true }]));
  return { environment, marker, profile, config, backup, registry, catalog };
}
afterEach(() => {
  failure.path = "";
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("explicit legacy OCG removal", () => {
  it.each(["deepseek", "opencode-go", "ccg"])("shows %s removal help before user initialization", (provider) => {
    const options = fixture("switching");
    const environment = { ...options.environment, CODEX_CONNECT_HOME: join(options.environment.CODEX_HOME, "missing") };
    for (const help of ["-h", "--help"]) {
      const result = spawnSync(process.execPath, ["bin/codexc.mjs", provider, "legacy", "remove", help], { env: environment, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`codexc ${provider} legacy remove`);
    }
  });

  it.each([
    ["switching", undefined], ["exclusive", undefined], ["switching", "old"], ["exclusive", "old"],
  ] as const)("removes a %s account (%s) after confirmation and preserves the baseline", async (mode, accountId) => {
    const options = fixture(mode, accountId);
    expect(hasLegacyOpencodeGoConfiguration(options.environment, accountId)).toBe(true);
    const preview = await previewLegacyOpencodeGoRemoval(accountId, options);
    expect(JSON.stringify(preview)).not.toContain("sk-fixture");
    const input = accountId === undefined ? {} : { accountId };
    await expect(removeLegacyOpencodeGoAccount(input, options)).rejects.toThrow("明确确认");
    expect(existsSync(options.marker)).toBe(true);
    await removeLegacyOpencodeGoAccount({ ...input, confirmRemove: true }, options);
    expect(existsSync(options.marker)).toBe(false);
    expect(existsSync(options.profile)).toBe(false);
    expect(existsSync(options.catalog)).toBe(false);
    expect(existsSync(options.backup)).toBe(true);
    expect(parse(readFileSync(options.config, "utf8"))).toEqual({ model: "original", personal_setting: "keep" });
  });

  it("removes a registered legacy account through account remove without modifying another account", async () => {
    const options = fixture("switching", "old");
    const directory = join(options.environment.CODEX_CONNECT_HOME, "providers", "opencode-go");
    write(options.registry, JSON.stringify([{ id: "old", default: false }, { id: "new", default: true }]));
    const newMarker = join(directory, "accounts", "new", "managed.toml");
    write(newMarker, 'version = 1\nprovider = "ocg-new"\nmode = "switching"\n');
    const retained = [newMarker, options.config, options.catalog, options.backup];
    const before = retained.map((path) => readFileSync(path));
    await runOpencodeGoAccountCli(["account", "remove", "old"], {
      environment: options.environment, output: { write: () => undefined },
      prompts: { confirm: async () => true, isCancel: () => false },
    });
    expect(JSON.parse(readFileSync(options.registry, "utf8"))).toEqual([{ id: "new", default: true }]);
    expect(retained.map((path) => readFileSync(path))).toEqual(before);
    expect(existsSync(options.marker)).toBe(false);
    expect(existsSync(options.profile)).toBe(false);
  });

  it("removes the old provider without interpreting unrelated Codex role files", async () => {
    const options = fixture("switching");
    write(join(options.environment.CODEX_HOME, "role.toml"), 'model_provider = "opencode-go"\n');
    write(options.config, stringify({ agents: { external: { config_file: "role.toml" } } }));
    await expect(removeLegacyOpencodeGoAccount({ confirmRemove: true }, options)).resolves.toMatchObject({ action: "legacy-removed" });
    expect(existsSync(options.marker)).toBe(false);
    expect(readFileSync(join(options.environment.CODEX_HOME, "role.toml"), "utf8")).toBe('model_provider = "opencode-go"\n');
  });

  it("refuses a missing fixed-mode baseline before removing any file", async () => {
    const options = fixture("exclusive");
    rmSync(options.backup);
    await expect(removeLegacyOpencodeGoAccount({ confirmRemove: true }, options)).rejects.toThrow("备份缺失");
    expect(existsSync(options.marker)).toBe(true);
    expect(existsSync(options.catalog)).toBe(true);
  });

  it("refuses removal while Remote TUI holds the legacy runtime", async () => {
    const options = fixture("switching");
    await expect(removeLegacyOpencodeGoAccount({ confirmRemove: true }, {
      ...options,
      inspectSupervisor: async () => ({ status: "ready", topology: {
        version: 5, pid: 1, primaryProvider: "openai", managedProviders: ["opencode-go"],
        socketPaths: [], runningProviders: ["opencode-go"], releasedProviders: [], leasedProviders: ["opencode-go"],
      } }),
      releaseProvider: async () => ({ released: false, reason: "leased" }),
    })).rejects.toThrow("Remote TUI");
    expect(existsSync(options.marker)).toBe(true);
    expect(existsSync(options.profile)).toBe(true);
  });

  it("rolls back file removal when restoring the fixed config fails", async () => {
    const options = fixture("exclusive");
    const files = [options.marker, options.config, options.catalog];
    const before = files.map((path) => readFileSync(path));
    failure.path = options.config;
    await expect(removeLegacyOpencodeGoAccount({ confirmRemove: true }, options)).rejects.toThrow("injected");
    expect(files.map((path) => readFileSync(path))).toEqual(before);
  });

  it("cancels legacy removal without modifying files", async () => {
    const options = fixture("switching");
    await runOpencodeGoAccountCli(["legacy", "remove"], {
      environment: options.environment, output: { write: () => undefined },
      prompts: { confirm: async () => false, isCancel: () => false },
    });
    expect(existsSync(options.marker)).toBe(true);
    expect(existsSync(options.profile)).toBe(true);
  });
});
