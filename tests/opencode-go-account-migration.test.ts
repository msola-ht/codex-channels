import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import { loadManagedModelProviders } from "../runtime/model-provider-runtime.mjs";
import {
  loadOpencodeGoAccounts,
  migrateLegacyOpencodeGoAccount,
  opencodeGoAccountsFilePath,
  opencodeGoAccountMarkerPath,
  readOpencodeGoAccountMarker,
} from "../runtime/opencode-go-accounts.mjs";
import {
  configuredHome,
  configureLegacyOpenCodeGo,
  configureOpenCodeGo,
  configurePrMainOpenCodeGo,
  configureReleasedRegisteredOpenCodeGo,
  connectHomeFor,
  testEnvironment,
} from "./model-provider-runtime-test-fixture.js";

describe("OpenCode Go account migration", () => {
  it("does not invent an account id for the legacy single-account layout", async () => {
    const codexHome = await configuredHome("switching");
    configureLegacyOpenCodeGo(codexHome);
    const environment = testEnvironment(codexHome);

    expect(migrateLegacyOpencodeGoAccount(environment)).toEqual({
      changed: false,
      accountId: undefined,
    });
    expect(loadOpencodeGoAccounts(environment)).toEqual([]);
    expect(readFileSync(join(codexHome, "sf-opencode-go.config.toml"), "utf8"))
      .toContain('model_provider = "opencode-go"');
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "main"))).toBe(false);
    expect(loadManagedModelProviders(environment)).toEqual([{ provider: "deepseek" }]);
  });

  it("migrates a registered legacy account without renaming its account id", async () => {
    const codexHome = await configuredHome("switching");
    configureOpenCodeGo(codexHome);
    configureReleasedRegisteredOpenCodeGo(codexHome);
    const environment = testEnvironment(codexHome);

    expect(migrateLegacyOpencodeGoAccount(environment)).toEqual({
      changed: true,
      accountId: "opencode-go",
    });
    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "opencode-go", default: true },
    ]);
    expect(parse(readFileSync(join(codexHome, "sf-ocg-opencode-go.config.toml"), "utf8")))
      .toMatchObject({ model_provider: "ocg-opencode-go" });
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "opencode-go"))).toBe(true);
    expect(readOpencodeGoAccountMarker(environment, "opencode-go"))
      .toMatchObject({ provider: "ocg-opencode-go", mode: "switching" });
  });

  it("migrates a legacy exclusive layout without touching the base config", async () => {
    const codexHome = await configuredHome("switching");
    rmSync(join(connectHomeFor(codexHome), "providers", "deepseek", "managed.toml"));
    rmSync(join(codexHome, "sf-deepseek.config.toml"));
    configureLegacyOpenCodeGo(codexHome, "exclusive");
    const environment = testEnvironment(codexHome);

    expect(migrateLegacyOpencodeGoAccount(environment)).toEqual({
      changed: false,
      accountId: undefined,
    });
    expect(parse(readFileSync(join(codexHome, "config.toml"), "utf8")))
      .toMatchObject({ model_provider: "opencode-go" });
    expect(loadOpencodeGoAccounts(environment)).toEqual([]);
  });

  it("leaves a legacy configuration without an account id untouched", async () => {
    const codexHome = await configuredHome("switching");
    configureLegacyOpenCodeGo(codexHome);
    rmSync(join(codexHome, "sf-opencode-go.config.toml"));
    const environment = testEnvironment(codexHome);

    expect(migrateLegacyOpencodeGoAccount(environment)).toEqual({
      changed: false,
      accountId: undefined,
    });
    expect(existsSync(opencodeGoAccountsFilePath(environment))).toBe(false);
  });

  it("migrates registered legacy account Profiles without changing account ids", async () => {
    const codexHome = await configuredHome("switching");
    configurePrMainOpenCodeGo(codexHome);
    writeFileSync(
      join(codexHome, "sf-agent.config.toml"),
      readFileSync(join(codexHome, "sf-opencode-go-main.config.toml"), "utf8")
        .replace('model_provider = "opencode-go-main"', "model_provider='opencode-go-main'"),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(migrateLegacyOpencodeGoAccount(environment)).toEqual({
      changed: true,
      accountId: "main",
    });
    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: true, email: "user@example.com" },
      { id: "lunare", default: false, email: "lunare@example.com" },
    ]);
    expect(readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8"))
      .toContain('model_provider = "ocg-main"');
    expect(readFileSync(join(codexHome, "sf-ocg-lunare.config.toml"), "utf8"))
      .toContain('model_provider = "ocg-lunare"');
    expect(readFileSync(join(codexHome, "sf-agent.config.toml"), "utf8"))
      .toContain('model_provider = "ocg-main"');
    expect(readOpencodeGoAccountMarker(environment, "main"))
      .toMatchObject({ provider: "ocg-main", mode: "switching" });
    expect(readOpencodeGoAccountMarker(environment, "lunare"))
      .toMatchObject({ provider: "ocg-lunare", mode: "switching" });
    expect(loadManagedModelProviders(environment)).toEqual([
      { provider: "deepseek" },
      { provider: "ocg-main" },
      { provider: "ocg-lunare" },
    ]);
  });

});
