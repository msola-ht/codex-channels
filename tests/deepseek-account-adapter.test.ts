import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeepseekAccountAdapter } from "../src/bootstrap/deepseek-account-adapter.js";
import { configuredHome, testEnvironment } from "./model-provider-runtime-test-fixture.js";

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
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toEqual({
      kind: "balance",
      provider: "ds-test",
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
      environment: testEnvironment(codexHome),
      fetchImpl: async () => new Response("secret-upstream-body", { status: 200 }),
    });

    await expect(adapter.accountUsage()).rejects.toMatchObject({
      code: "provider.account.unavailable",
      message: "DeepSeek 账户查询失败",
    });
  });

  it("reads the selected fixed account credential from its main config", async () => {
    const codexHome = await configuredHome("exclusive");
    temporaryDirectories.push(codexHome);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      is_available: false,
      balance_infos: [],
    }), { status: 200 }));
    const adapter = createDeepseekAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toMatchObject({
      kind: "balance",
      provider: "ds-test",
      available: false,
    });
  });

});

async function createCodexHome(): Promise<string> {
  const directory = await configuredHome("switching");
  temporaryDirectories.push(directory);
  return directory;
}
