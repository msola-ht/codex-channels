import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertManagedModelProviderCapabilities,
  ccgAccountDefinition,
  commandCodeProviderDefinition,
  deepseekProviderDefinition,
  deepseekAccountDefinition,
  expandManagedModelProviderDefinitions,
  loadManagedModelProviderWatcherDefinitions,
  managedModelProviderDefinitions,
  opencodeGoAccountDefinition,
  opencodeGoProviderDefinition,
} from "../runtime/model-provider-definitions.mjs";
import { writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
import { ccgAccountsFilePath } from "../runtime/ccg-accounts.mjs";
import { deepseekAccountsFilePath } from "../runtime/deepseek-accounts.mjs";
import { resolveDefaultManagedProvider } from "../runtime/managed-provider-account-routing.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import {
  createManagedProviderAccountAdapters,
} from "../src/bootstrap/managed-provider-capabilities.js";

describe("managed Provider capability registry", () => {
  it("resolves the registered default for every homogeneous managed account family", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-provider-family-defaults-"));
    const environment = { CODEX_CONNECT_HOME: join(home, ".codex-connect") };
    try {
      writePrivateFileAtomicSync(deepseekAccountsFilePath(environment), JSON.stringify([
        { id: "main", default: false }, { id: "work", default: true },
      ]));
      writeOpencodeGoAccounts(environment, [
        { id: "main", default: false, email: "main@example.com" },
        { id: "work", default: true, email: "work@example.com" },
      ]);
      writePrivateFileAtomicSync(ccgAccountsFilePath(environment), JSON.stringify([
        { id: "main", default: false }, { id: "work", default: true },
      ]));

      expect(resolveDefaultManagedProvider(["ds-main", "ds-work"], environment))
        .toBe("ds-work");
      expect(resolveDefaultManagedProvider(["ocg-main", "ocg-work"], environment))
        .toBe("ocg-work");
      expect(resolveDefaultManagedProvider(["ccg-main", "ccg-work"], environment))
        .toBe("ccg-work");
      expect(resolveDefaultManagedProvider(["ds-main", "ccg-work"], environment))
        .toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses one canonical Profile name for CLI selection and the profile file", () => {
    for (const definition of [
      ...managedModelProviderDefinitions,
      ccgAccountDefinition("main"),
      opencodeGoAccountDefinition("lunare"),
    ]) {
      expect(definition.profileName).toMatch(/^sf-/u);
      expect(definition.profileFileName).toBe(`${definition.profileName}.config.toml`);
    }
    expect(opencodeGoAccountDefinition("work")).toMatchObject({
      profileName: "sf-ocg-work",
      profileFileName: "sf-ocg-work.config.toml",
    });
    expect(ccgAccountDefinition("work")).toMatchObject({
      profileName: "sf-ccg-work",
      profileFileName: "sf-ccg-work.config.toml",
    });
  });

  it("fails closed when a future Provider Profile file diverges from its canonical name", () => {
    const futureProvider = {
      ...deepseekProviderDefinition,
      id: "future-provider",
      profileName: "sf-future-provider",
      profileFileName: "sf-other.config.toml",
    } as unknown as typeof deepseekProviderDefinition;
    expect(() => expandManagedModelProviderDefinitions([futureProvider], process.env))
      .toThrow("受管 Provider Profile 定义无效：future-provider");
  });

  it("declares the reviewed capability kinds and preserves them for Go accounts", () => {
    expect(deepseekProviderDefinition.capabilities).toEqual({
      accountAdapter: "deepseek",
      instanceAdapter: "deepseek-accounts",
    });
    expect(opencodeGoAccountDefinition("lunare").capabilities)
      .toBe(opencodeGoProviderDefinition.capabilities);
    expect(commandCodeProviderDefinition.capabilities).toEqual({
      accountAdapter: "ccg",
      instanceAdapter: "ccg-accounts",
    });
  });

  it("expands every single-instance base definition into the runtime registry", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-empty-provider-definitions-"));
    const futureProvider = {
      ...deepseekProviderDefinition,
      id: "future-provider",
      capabilities: {
        ...deepseekProviderDefinition.capabilities,
        instanceAdapter: "single",
      },
    } as unknown as typeof deepseekProviderDefinition;

    try {
      expect(expandManagedModelProviderDefinitions(
        [deepseekProviderDefinition, futureProvider],
        { CODEX_CONNECT_HOME: join(home, ".codex-connect") },
      ).map(({ id }) => id)).toEqual(["future-provider"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("supports a managed Provider without account or catalog update adapters", () => {
    const futureProvider = {
      ...deepseekProviderDefinition,
      id: "future-provider",
      capabilities: {
        ...deepseekProviderDefinition.capabilities,
        accountAdapter: "none",
      },
    } as unknown as typeof deepseekProviderDefinition;

    expect(assertManagedModelProviderCapabilities(futureProvider)).toMatchObject({
      accountAdapter: "none",
    });
    expect(createManagedProviderAccountAdapters([futureProvider], {
      metricsDatabasePath: join(tmpdir(), "codexc-future-provider.sqlite3"),
    })).toEqual([]);
  });

  it("keeps shared definitions and configured OCG/CCG accounts in one watcher set", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-provider-definitions-"));
    try {
      const environment = {
        ...process.env,
        CODEX_HOME: home,
        CODEX_CONNECT_HOME: join(home, ".codex-connect"),
      };
      expect(loadManagedModelProviderWatcherDefinitions(environment).map(({ id }) => id))
        .toEqual(["deepseek", "ocg", "ccg", "cline-pass"]);

      writeOpencodeGoAccounts(environment, [
        { id: "main", default: true },
        { id: "lunare", default: false },
      ]);
      writePrivateFileAtomicSync(ccgAccountsFilePath(environment), `${JSON.stringify([
        { id: "main", default: true },
        { id: "work", default: false },
      ])}\n`);
      expect(loadManagedModelProviderWatcherDefinitions(environment).map(({ id }) => id))
        .toEqual([
          "deepseek", "ocg", "ocg-main", "ocg-lunare", "ccg", "ccg-main", "ccg-work", "cline-pass",
        ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("selects account adapters by capability without merging provider keys", () => {
    const definitions = [
      deepseekAccountDefinition("test"),
      opencodeGoAccountDefinition("lunare"),
      ccgAccountDefinition("main"),
    ];
    const accounts = createManagedProviderAccountAdapters(definitions, {
      environment: process.env,
      fetchImpl: fetch,
      metricsDatabasePath: join(tmpdir(), "codexc-provider-capabilities.sqlite3"),
    });
    expect(accounts.map(({ provider }) => provider)).toEqual([
      "ds-test",
      "ocg-lunare",
      "ccg-main",
    ]);
  });

  it("fails closed for unknown capability kinds", () => {
    const invalid = {
      ...deepseekProviderDefinition,
      capabilities: {
        ...deepseekProviderDefinition.capabilities,
        accountAdapter: "unknown",
      },
    } as unknown as typeof deepseekProviderDefinition;
    expect(() => assertManagedModelProviderCapabilities(invalid))
      .toThrow("受管 Provider 能力定义无效");
  });
});
