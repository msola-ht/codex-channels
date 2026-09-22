import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
import { configuredHome, configureCcgAccounts, configureOpenCodeGo, testEnvironment } from "./model-provider-runtime-test-fixture.js";
import { applyDeepseekAccountConfiguration, deepseekAccountPaths, removeDeepseekAccount } from "../scripts/deepseek-account-management.mjs";
import { applyCcgConfiguration, ccgSetupPaths, removeCcgConfiguration } from "../scripts/ccg-setup.mjs";
import { applyOpencodeGoAccountConfiguration } from "../scripts/opencode-go-account-provisioning.mjs";
import { applyOpencodeGoAccountRemoval } from "../scripts/opencode-go-account-management.mjs";
import { opencodeGoAccountPaths } from "../scripts/opencode-go-account-files.mjs";
import { runDeepseekSetup } from "../scripts/deepseek-account-setup.mjs";
import { runCcgSetup } from "../scripts/ccg-setup.mjs";
import type { ManagedAccountRuntimeOptions } from "../scripts/managed-provider-account-runtime.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
// @ts-expect-error JavaScript account settings helper intentionally has no declaration file.
import { previewAccountSettingsMutation } from "../scripts/webui-account-settings-management.mjs";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

async function fixture(family: "ds" | "ocg" | "ccg") {
  const home = await configuredHome("switching");
  homes.push(home);
  configureOpenCodeGo(home);
  configureCcgAccounts(home);
  const environment = testEnvironment(home);
  writeOpencodeGoAccounts(environment, [{ id: "main", default: false, email: "main@example.com" }, { id: "other", default: true }]);
  const accountId = family === "ds" ? "test" : "main";
  const provider = `${family}-${accountId}`;
  const dsPaths = deepseekAccountPaths(environment, "test");
  const ccgPaths = ccgSetupPaths(environment, "main");
  const ocgPaths = opencodeGoAccountPaths(environment, "main");
  writePrivateFileAtomicSync(ccgPaths.backup, JSON.stringify({ config: { model: "original" } }));
  const paths = family === "ds" ? dsPaths : family === "ccg" ? ccgPaths : {
    profile: ocgPaths.profilePath, marker: ocgPaths.markerPath,
    registry: join(environment.CODEX_CONNECT_HOME!, "providers", "opencode-go", "accounts.json"),
    catalog: ocgPaths.catalogPath,
  };
  const snapshot = () => Object.fromEntries(Object.values(paths).map((path) => [path,
    existsSync(path) ? readFileSync(path, "utf8") : null]));
  const reconfigure = () => family === "ds"
    ? applyDeepseekAccountConfiguration({ accountId, reconfigure: true, apiKey: "sk-fixture" }, { environment })
    : family === "ccg"
      ? applyCcgConfiguration({ accountId, reconfigure: true, apiKey: "cmd_fixture", model: "deepseek/deepseek-v4-flash", catalog: { models: [] } }, { environment })
      : applyOpencodeGoAccountConfiguration({ accountId, reconfigure: true, apiKey: "sk-fixture" }, { environment });
  const remove = (options: ManagedAccountRuntimeOptions) => family === "ds"
    ? removeDeepseekAccount({ accountId, confirmRemove: true }, { environment, ...options })
    : family === "ccg"
      ? removeCcgConfiguration({ accountId, confirmRemove: true }, { environment, ...options })
      : applyOpencodeGoAccountRemoval({ accountId, confirmHistoryLoss: true }, { environment, ...options });
  return { environment, provider, paths, snapshot, reconfigure, remove };
}

describe.each(["ds", "ocg", "ccg"] as const)("%s account lifecycle contract", (family) => {
  it("rejects reconfiguration of incomplete registered accounts without changing files", async () => {
    const account = await fixture(family);
    unlinkSync(account.paths.profile);
    unlinkSync(account.paths.marker);
    const before = account.snapshot();
    await expect(account.reconfigure()).rejects.toThrow("配置不完整");
    expect(account.snapshot()).toEqual(before);
  });

  it.each(["leased", "incompatible", "release-failed"])("keeps files intact when deletion runtime is %s", async (failure) => {
    const account = await fixture(family);
    const before = account.snapshot();
    const releaseProvider = vi.fn(async () => {
      if (failure === "release-failed") throw new Error("release failed");
      return { released: false as const, reason: "leased" as const };
    });
    const options: ManagedAccountRuntimeOptions = {
      resolvePrimarySocket: () => "/fixture/app-server.sock",
      inspectSupervisor: async () => failure === "incompatible" ? { status: "incompatible" } : {
        status: "ready", topology: {
          version: 5, pid: 1, primaryProvider: "openai", managedProviders: [account.provider],
          socketPaths: [], runningProviders: [account.provider], releasedProviders: [], leasedProviders: [],
        },
      },
      releaseProvider,
    };
    await expect(account.remove(options)).rejects.toThrow(failure === "leased" ? "Remote TUI" : failure === "incompatible" ? "监管协议" : "release failed");
    expect(account.snapshot()).toEqual(before);
    if (failure === "incompatible") expect(releaseProvider).not.toHaveBeenCalled();
    else expect(releaseProvider).toHaveBeenCalledWith("/fixture/app-server.sock", account.provider);
  });

  it("releases only the selected provider before deleting its files", async () => {
    const account = await fixture(family);
    const releaseProvider = vi.fn(async () => {
      expect(existsSync(account.paths.profile)).toBe(true);
      expect(existsSync(account.paths.marker)).toBe(true);
      return { released: true as const, reason: "released" as const };
    });
    await expect(account.remove({
      resolvePrimarySocket: () => "/fixture/app-server.sock",
      inspectSupervisor: async () => ({ status: "ready", topology: {
        version: 5, pid: 1, primaryProvider: "openai", managedProviders: [account.provider], socketPaths: [],
        runningProviders: [account.provider, "ccg-work"], releasedProviders: [], leasedProviders: [],
      } }), releaseProvider,
    })).resolves.toMatchObject({ action: "removed", runtime: "stopped", activation: "restart-all" });
    expect(releaseProvider).toHaveBeenCalledExactlyOnceWith("/fixture/app-server.sock", account.provider);
    expect(existsSync(account.paths.profile)).toBe(false);
    expect(existsSync(account.paths.marker)).toBe(false);
  });
});

describe("account CLI activation", () => {
  it("previews DS deletion through the WebUI using the same removal validation", async () => {
    const account = await fixture("ds");
    initializeUserData({ environment: account.environment, cwd: account.environment.HOME! });
    const before = account.snapshot();
    await expect(previewAccountSettingsMutation({ operation: "deepseek.remove", accountId: "test" }, account.environment))
      .resolves.toMatchObject({ effects: { stopsRunningAppServer: false, historyThreadsBecomeUnavailable: true, preservesPrivateBackup: true }, activation: "restart-all" });
    expect(account.snapshot()).toEqual(before);
    unlinkSync(account.paths.profile);
    unlinkSync(account.paths.marker);
    await expect(previewAccountSettingsMutation({ operation: "deepseek.remove", accountId: "test" }, account.environment))
      .rejects.toThrow("配置不完整");
  });

  it.each(["ds", "ccg"] as const)("prints the required restart after %s default changes", async (family) => {
    const account = await fixture(family);
    const chunks: string[] = [];
    const options = { environment: account.environment, action: "default" as const,
      accountId: family === "ds" ? "test" : "main",
      prompts: { isCancel: () => false }, output: { write: (value: string) => { chunks.push(value); } } };
    const result = family === "ds" ? await runDeepseekSetup(options) : await runCcgSetup(options);
    expect(result).toMatchObject({ activation: "restart-all" });
    expect(chunks.join("")).toContain("codexc service restart all");
    expect(chunks.join("")).not.toContain("会自动重新读取配置");
  });
});
