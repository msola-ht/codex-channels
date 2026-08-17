import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeepseekAccountAdapter } from "../src/bootstrap/deepseek-account-adapter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("DeepSeek account adapter", () => {
  it("reads the private Setup credential and maps the official balance response", async () => {
    const codexHome = await createCodexHome();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: "CNY",
        total_balance: "110.00",
        granted_balance: "10.00",
        topped_up_balance: "100.00",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = createDeepseekAccountAdapter({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toEqual({
      kind: "balance",
      provider: "deepseek",
      available: true,
      balances: [{
        currency: "CNY",
        totalBalance: "110.00",
        grantedBalance: "10.00",
        toppedUpBalance: "100.00",
      }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer sk-test-secret" }),
      }),
    );
  });

  it("fails with a stable user error without exposing malformed responses", async () => {
    const codexHome = await createCodexHome();
    const adapter = createDeepseekAccountAdapter({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: async () => new Response("secret-upstream-body", { status: 200 }),
    });

    await expect(adapter.accountUsage()).rejects.toMatchObject({
      code: "provider.account.unavailable",
      message: "DeepSeek 账户查询失败",
    });
  });

  it("falls back to the fixed-mode base config when no managed profile exists", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-deepseek-fixed-account-"));
    temporaryDirectories.push(codexHome);
    await writeFile(
      join(codexHome, "config.toml"),
      providerConfig("sk-fixed-secret"),
      { mode: 0o600 },
    );
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      is_available: false,
      balance_infos: [],
    }), { status: 200 }));
    const adapter = createDeepseekAccountAdapter({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toMatchObject({
      kind: "balance",
      provider: "deepseek",
      available: false,
    });
  });

});

async function createCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexc-deepseek-account-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "config.toml"), 'model = "gpt-5.6-sol"\n', { mode: 0o600 });
  await writeFile(
    join(directory, "sf-deepseek.config.toml"),
    `model = "deepseek-v4-flash"\nmodel_provider = "deepseek"\n${providerConfig("sk-test-secret")}`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "sf-deepseek.managed.toml"),
    'version = 1\nprovider = "deepseek"\n',
    { mode: 0o600 },
  );
  return directory;
}

function providerConfig(apiKey: string): string {
  return `[model_providers.deepseek]\nname = "deepseek"\nbase_url = "https://api.deepseek.com/"\nwire_api = "responses"\nrequires_openai_auth = false\nexperimental_bearer_token = "${apiKey}"\n`;
}
