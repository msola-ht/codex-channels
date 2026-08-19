import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  addOpencodeGoAccount,
  printOpencodeGoAccounts,
  removeOpencodeGoAccount,
  runOpencodeGoAccountCli,
  setOpencodeGoDefaultAccount,
} from "../scripts/opencode-go-setup.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountMarkerPath,
} from "../runtime/opencode-go-accounts.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

describe("OpenCode Go account CLI", () => {
  it("adds the first account as default and a second account without changing the role", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    const configureRole = vi.fn(async () => undefined);
    const output = { write: vi.fn() };

    await addOpencodeGoAccount("opencode-go", {
      environment,
      output,
      prompter: testPrompter(),
      configureRole,
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output,
      prompter: testPrompter(),
      configureRole,
      downloadCatalog: successfulCatalog,
    });

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "opencode-go", default: true },
      { id: "b", default: false },
    ]);
    expect(existsSync(join(codexHome(home), "sf-opencode-go.config.toml"))).toBe(true);
    expect(existsSync(join(codexHome(home), "sf-opencode-go-b.config.toml"))).toBe(true);
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "opencode-go"))).toBe(true);
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "b"))).toBe(true);
    expect(configureRole).toHaveBeenCalledTimes(1);
    expect(configureRole).toHaveBeenCalledWith(
      "opencode-go",
      "deepseek-v4-flash",
      environment,
    );
  });

  it("lists accounts and prints the default marker", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("opencode-go", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      configureRole: async () => undefined,
      downloadCatalog: successfulCatalog,
    });
    const output = { write: vi.fn() };

    printOpencodeGoAccounts(environment, output);

    expect(output.write).toHaveBeenCalledWith(
      expect.stringContaining("opencode-go（默认）"),
    );
  });

  it("removes an account after backing up its profile and marker", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("opencode-go", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      configureRole: async () => undefined,
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      configureRole: async () => undefined,
      downloadCatalog: successfulCatalog,
    });
    const profilePath = join(codexHome(home), "sf-opencode-go-b.config.toml");

    await removeOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompts: { confirm: async () => true, isCancel: () => false },
    });

    expect(existsSync(profilePath)).toBe(false);
    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "opencode-go", default: true },
    ]);
    const backup = join(
      home,
      ".codex-connect",
      "providers",
      "opencode-go",
      "accounts",
      "b",
      "backup",
    );
    expect(existsSync(join(backup, "managed.toml"))).toBe(true);
    expect(existsSync(join(backup, "sf-opencode-go-b.config.toml"))).toBe(true);
  });

  it("refuses to delete the final account before stopping its App Server", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("opencode-go", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      configureRole: async () => undefined,
      downloadCatalog: successfulCatalog,
    });

    await expect(removeOpencodeGoAccount("opencode-go", {
      environment,
      output: { write: () => undefined },
      confirm: false,
    })).rejects.toThrow("不能删除最后一个");

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "opencode-go", default: true },
    ]);
  });

  it("promotes the remaining account when the default is removed", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("opencode-go", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      configureRole: async () => undefined,
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      configureRole: async () => undefined,
      downloadCatalog: successfulCatalog,
    });

    await setOpencodeGoDefaultAccount("b", { environment });
    await removeOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompts: { confirm: async () => true, isCancel: () => false },
    });

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "opencode-go", default: true },
    ]);
  });

  it("runs the list subcommand through the CLI entry", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("opencode-go", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      configureRole: async () => undefined,
      downloadCatalog: successfulCatalog,
    });
    const output = { write: vi.fn() };

    await runOpencodeGoAccountCli(["account", "list"], { environment, output });

    expect(output.write).toHaveBeenCalledWith(expect.stringContaining("opencode-go（默认）"));
  });

  it("reports a not-running account on stop", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("opencode-go", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      configureRole: async () => undefined,
      downloadCatalog: successfulCatalog,
    });
    const output = { write: vi.fn() };

    const result = await runOpencodeGoAccountCli(
      ["account", "stop", "opencode-go"],
      { environment, output },
    );

    expect(result).toEqual({ action: "not-running", accountId: "opencode-go" });
  });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "codexc-go-account-cli-"));
  const connectHome = join(home, ".codex-connect");
  const codex = join(home, ".codex");
  mkdirSync(connectHome, { recursive: true, mode: 0o700 });
  mkdirSync(codex, { recursive: true, mode: 0o700 });
  initializeUserData({
    environment: {
      ...cleanEnvironment(),
      CODEX_HOME: codex,
      CODEX_CONNECT_HOME: connectHome,
    },
    cwd: connectHome,
  });
  return home;
}

function codexHome(home: string) {
  return join(home, ".codex");
}

function testEnvironment(home: string) {
  return {
    ...cleanEnvironment(),
    CODEX_HOME: codexHome(home),
    CODEX_CONNECT_HOME: join(home, ".codex-connect"),
    CODEX_CONNECT_CONFIG_FILE: join(home, ".codex-connect", "config.toml"),
  };
}

function cleanEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("CODEX_CONNECT_") && key !== "CODEX_CONNECT_HOME") {
      delete environment[key];
    }
  }
  return environment;
}

function testPrompter() {
  return {
    secret: async () => "sk-opencode-test",
    confirm: async () => true,
    accountId: async () => "opencode-go",
    selectAccount: async () => "opencode-go",
    select: async () => "switching",
  };
}

async function successfulCatalog() {
  return {
    catalog: {
      models: ["deepseek-v4-flash", "deepseek-v4-pro"].map((slug) => ({
        slug,
        context_window: 1_000_000,
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "high", description: "High" },
          { effort: "max", description: "Max" },
        ],
      })),
    },
    sha256: "a".repeat(64),
  };
}
