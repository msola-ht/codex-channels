import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const fileRemovalFailure = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: (path: string) => {
      if (path === fileRemovalFailure.path) throw new Error("injected remove failure");
      return actual.unlinkSync(path);
    },
  };
});

import {
  AppServerSupervisorOwner,
  acquireAppServerProviderLease,
  appServerSupervisorSocketPath,
} from "../runtime/app-server-supervisor.mjs";
import { resolvePrimaryAppServerSocketPath } from "../runtime/app-server-runtime.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  addOpencodeGoAccount,
  printOpencodeGoAccounts,
  removeOpencodeGoAccount,
  runOpencodeGoAccountCli,
  setOpencodeGoDefaultAccount,
} from "../scripts/opencode-go-setup.mjs";
import {
  loadOpencodeGoAccounts,
  opencodeGoAccountsFilePath,
  opencodeGoAccountMarkerPath,
} from "../runtime/opencode-go-accounts.mjs";
import { initializeUserData, runtimeConfig } from "../scripts/runtime-config.mjs";

const unixSocketTmpdir = process.platform === "darwin" ? "/tmp" : tmpdir();

describe("OpenCode Go account CLI", () => {
  it("adds the first account as default and a second account without changing the role", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    const output = { write: vi.fn() };

    const result = await addOpencodeGoAccount("main", {
      environment,
      output,
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output,
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: true, email: "user@example.com" },
      { id: "b", default: false, email: "user@example.com" },
    ]);
    expect(existsSync(join(codexHome(home), "sf-ocg-main.config.toml"))).toBe(true);
    expect(existsSync(join(codexHome(home), "sf-ocg-b.config.toml"))).toBe(true);
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "main"))).toBe(true);
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "b"))).toBe(true);
    expect(existsSync(join(codexHome(home), "sf-agent.config.toml"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-opencode-test");
  });

  it("lists accounts and prints the default marker", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const output = { write: vi.fn() };

    printOpencodeGoAccounts(environment, output);

    expect(output.write).toHaveBeenCalledWith(
      expect.stringContaining("ocg-user@example.com（默认）"),
    );
  });

  it("removes an account after backing up its profile and marker", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const profilePath = join(codexHome(home), "sf-ocg-b.config.toml");

    await removeOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompts: { confirm: async () => true, isCancel: () => false },
    });

    expect(existsSync(profilePath)).toBe(false);
    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: true, email: "user@example.com" },
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
    expect(existsSync(join(backup, "sf-ocg-b.config.toml"))).toBe(true);
  });

  it("restores the account when removing a managed file fails midway", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const profilePath = join(codexHome(home), "sf-ocg-b.config.toml");
    const markerPath = opencodeGoAccountMarkerPath(environment, "b");
    fileRemovalFailure.path = markerPath;

    try {
      await expect(removeOpencodeGoAccount("b", {
        environment,
        output: { write: () => undefined },
        confirm: false,
      })).rejects.toThrow("injected remove failure");
    } finally {
      fileRemovalFailure.path = undefined;
    }

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: true, email: "user@example.com" },
      { id: "b", default: false, email: "user@example.com" },
    ]);
    expect(existsSync(profilePath)).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
  });

  it("deletes the final switching account and cleans the shared provider files", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const profilePath = join(codexHome(home), "sf-ocg-main.config.toml");
    const markerPath = opencodeGoAccountMarkerPath(environment, "main");
    const catalogPath = join(
      home,
      ".codex-connect",
      "providers",
      "opencode-go",
      "models.json",
    );
    const manifestPath = join(
      home,
      ".codex-connect",
      "providers",
      "opencode-go",
      "models.manifest.json",
    );

    const result = await removeOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      confirm: false,
    });

    expect(result).toMatchObject({ action: "removed", accountId: "main" });
    expect(loadOpencodeGoAccounts(environment)).toEqual([]);
    expect(existsSync(profilePath)).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(opencodeGoAccountsFilePath(environment))).toBe(false);
    expect(existsSync(catalogPath)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("deletes the final exclusive account and restores the Codex main config", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    const originalConfig = 'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n';
    writeFileSync(join(codexHome(home), "config.toml"), originalConfig, { mode: 0o600 });
    await addOpencodeGoAccount("main", {
      mode: "exclusive",
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const configPath = join(codexHome(home), "config.toml");
    expect(readFileSync(configPath, "utf8")).toContain('model_provider = "ocg-main"');

    const result = await removeOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      confirm: false,
    });

    expect(result).toMatchObject({ action: "removed", accountId: "main" });
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(existsSync(join(codexHome(home), "sf-ocg-main.config.toml"))).toBe(false);
    expect(existsSync(opencodeGoAccountMarkerPath(environment, "main"))).toBe(false);
    expect(existsSync(opencodeGoAccountsFilePath(environment))).toBe(false);
  });

  it("promotes the remaining account when the default is removed", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });

    await setOpencodeGoDefaultAccount("b", { environment });
    await removeOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompts: { confirm: async () => true, isCancel: () => false },
    });

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: true, email: "user@example.com" },
    ]);
  });

  it.skipIf(process.platform === "win32")("sets default without invoking shared role configuration", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });

    await setOpencodeGoDefaultAccount("b", {
      environment,
    });

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: false, email: "user@example.com" },
      { id: "b", default: true, email: "user@example.com" },
    ]);
  });

  it.skipIf(process.platform === "win32")("does not replace a DeepSeek shared role when the GO default account changes", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const rolePath = join(codexHome(home), "sf-agent.config.toml");
    writeFileSync(
      join(codexHome(home), "config.toml"),
      `[agents.external]\nconfig_file = ${JSON.stringify(rolePath)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      rolePath,
      'model = "deepseek-v4-flash"\nmodel_provider = "deepseek"\nmodel_reasoning_effort = "high"\n',
      { mode: 0o600 },
    );
    await setOpencodeGoDefaultAccount("b", { environment });

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: false, email: "user@example.com" },
      { id: "b", default: true, email: "user@example.com" },
    ]);
    expect(readFileSync(rolePath, "utf8")).toContain('model_provider = "deepseek"');
  });

  it("sets the default even when the shared role cannot be read safely", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const rolePath = join(codexHome(home), "sf-agent.config.toml");
    writeFileSync(
      join(codexHome(home), "config.toml"),
      `[agents.external]\nconfig_file = ${JSON.stringify(rolePath)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(rolePath, "not valid [ toml", { mode: 0o600 });

    await setOpencodeGoDefaultAccount("b", { environment });

    expect(loadOpencodeGoAccounts(environment)).toEqual([
      { id: "main", default: false, email: "user@example.com" },
      { id: "b", default: true, email: "user@example.com" },
    ]);
    expect(readFileSync(rolePath, "utf8")).toBe("not valid [ toml");
  });

  it("runs the list subcommand through the CLI entry", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const output = { write: vi.fn() };

    await runOpencodeGoAccountCli(["account", "list"], { environment, output });

    expect(output.write).toHaveBeenCalledWith(expect.stringContaining("ocg-user@example.com（默认）"));
  });

  it("prints a structured JSON account list without secrets", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    const emptyOutput = { write: vi.fn() };
    await runOpencodeGoAccountCli(["account", "list", "--json"], {
      environment,
      output: emptyOutput,
    });
    expect(JSON.parse(emptyOutput.write.mock.calls[0]?.[0] as string)).toEqual({ accounts: [] });

    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const configuredOutput = { write: vi.fn() };
    await runOpencodeGoAccountCli(["account", "list", "--json"], {
      environment,
      output: configuredOutput,
    });
    expect(JSON.parse(configuredOutput.write.mock.calls[0]?.[0] as string).accounts[0].mode).toBe("switching");
    const markerPath = opencodeGoAccountMarkerPath(environment, "main");
    unlinkSync(markerPath);
    const output = { write: vi.fn() };
    await runOpencodeGoAccountCli(["account", "list", "--json"], { environment, output });
    const payload = JSON.parse(output.write.mock.calls[0]?.[0] as string);
    expect(payload).toEqual({
      accounts: [{
        id: "main",
        email: "user@example.com",
        displayName: "ocg-user@example.com",
        default: true,
        provider: "ocg-main",
        mode: "unconfigured",
      }],
    });
    expect(JSON.stringify(payload)).not.toContain("apiKey");
    expect(JSON.stringify(payload)).not.toContain("Bearer");
  });

  it("reports the default-account change and required restart through the CLI", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const output = { write: vi.fn() };

    await runOpencodeGoAccountCli(
      ["account", "default", "b"],
      { environment, output },
    );

    expect(output.write).toHaveBeenCalledWith("默认 OpenCode Go 账户已设置为 b。\n");
    expect(output.write).toHaveBeenCalledWith(
      "[提示] 配置已保存。请重启 Gateway 与 App Server：codexc service restart all\n",
    );
  });

  it("reports a not-running account on stop", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const output = { write: vi.fn() };

    const result = await runOpencodeGoAccountCli(
      ["account", "stop", "main"],
      { environment, output },
    );

    expect(result).toEqual({ action: "not-running", accountId: "main" });
  });

  it("does not remove an account while a Remote TUI holds its Provider lease", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const runtime = runtimeConfig(environment);
    const primarySocketPath = resolvePrimaryAppServerSocketPath(
      readGatewayConfig(runtime.configPath),
      runtime.dataDir,
    );
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["ocg-main", "ocg-b"],
      socketPaths: [primarySocketPath],
    }, {
      ensureProvider: async () => undefined,
      releaseProvider: async () => true,
    });
    await owner.start();
    const lease = await acquireAppServerProviderLease(primarySocketPath, "ocg-b");

    try {
      await expect(removeOpencodeGoAccount("b", {
        environment,
        output: { write: () => undefined },
        confirm: false,
      })).rejects.toThrow("Remote TUI");
      expect(loadOpencodeGoAccounts(environment)).toEqual([
        { id: "main", default: true, email: "user@example.com" },
        { id: "b", default: false, email: "user@example.com" },
      ]);
    } finally {
      await lease.close();
      await owner.close();
    }
  });

  it.skipIf(process.platform === "win32")("does not remove an account when the running Supervisor protocol is incompatible", async () => {
    const home = fixture();
    const environment = testEnvironment(home);
    await addOpencodeGoAccount("main", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    await addOpencodeGoAccount("b", {
      environment,
      output: { write: () => undefined },
      prompter: testPrompter(),
      downloadCatalog: successfulCatalog,
    });
    const runtime = runtimeConfig(environment);
    const primarySocketPath = resolvePrimaryAppServerSocketPath(
      readGatewayConfig(runtime.configPath),
      runtime.dataDir,
    );
    const supervisorSocketPath = appServerSupervisorSocketPath(primarySocketPath);
    const server = createServer((socket) => {
      socket.once("data", () => socket.end(`${JSON.stringify({
        version: 3,
        pid: process.pid,
        primaryProvider: "openai",
        managedProviders: ["ocg-main", "ocg-b"],
        socketPaths: [primarySocketPath],
        runningProviders: ["ocg-b"],
        releasedProviders: [],
      })}\n`));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(supervisorSocketPath, resolve);
    });
    chmodSync(supervisorSocketPath, 0o600);

    try {
      await expect(removeOpencodeGoAccount("b", {
        environment,
        output: { write: () => undefined },
        confirm: false,
      })).rejects.toThrow("监管协议");
      expect(loadOpencodeGoAccounts(environment)).toEqual([
        { id: "main", default: true, email: "user@example.com" },
        { id: "b", default: false, email: "user@example.com" },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function fixture() {
  const home = mkdtempSync(join(unixSocketTmpdir, "codexc-go-account-cli-"));
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
    contact: async () => "user@example.com",
    accountId: async () => "main",
    selectAccount: async () => "main",
    select: async () => "switching",
  };
}

async function successfulCatalog() {
  return {
    catalog: {
      models: [
        "deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
        "deepseek-v4-pro",
      ].map((slug) => ({
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
