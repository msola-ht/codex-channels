import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpencodeGoAccountAdapter } from "../src/bootstrap/opencode-go-account-adapter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("OpenCode Go account adapter", () => {
  it("reads the managed profile credential and maps quota windows", async () => {
    const codexHome = await createCodexHome();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-08-16T18:03:54.934Z" },
        weekly: { status: "ok", percent: 2, resetsAt: "2026-08-17T00:00:00.934Z" },
        monthly: { status: "ok", percent: 1, resetsAt: "2026-09-15T14:22:07.934Z" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toEqual({
      kind: "quota-windows",
      provider: "opencode-go",
      available: true,
      windows: [
        {
          windowId: "rolling",
          label: "5小时",
          usedPercent: 0,
          resetsAt: Math.floor(Date.parse("2026-08-16T18:03:54.934Z") / 1_000),
          status: "ok",
        },
        {
          windowId: "weekly",
          label: "7天",
          usedPercent: 2,
          resetsAt: Math.floor(Date.parse("2026-08-17T00:00:00.934Z") / 1_000),
          status: "ok",
        },
        {
          windowId: "monthly",
          label: "月度",
          usedPercent: 1,
          resetsAt: Math.floor(Date.parse("2026-09-15T14:22:07.934Z") / 1_000),
          status: "ok",
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/usage",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer sk-test-secret" }),
      }),
    );
  });

  it("fails with a stable user error without exposing malformed responses", async () => {
    const codexHome = await createCodexHome();
    const adapter = createOpencodeGoAccountAdapter({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: async () => new Response("secret-upstream-body", { status: 200 }),
    });

    await expect(adapter.accountUsage()).rejects.toMatchObject({
      code: "provider.account.unavailable",
      message: "OpenCode Go 账户查询失败",
    });
  });

  it("falls back to the fixed-mode base config when no managed profile exists", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-opencode-go-fixed-account-"));
    temporaryDirectories.push(codexHome);
    await writeFile(
      join(codexHome, "config.toml"),
      `model = "deepseek-v4-flash"\n${providerConfig("sk-fixed-secret")}`,
      { mode: 0o600 },
    );
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 10, resetsAt: "2026-08-16T18:03:54.934Z" },
      },
    }), { status: 200 }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toMatchObject({
      kind: "quota-windows",
      provider: "opencode-go",
      available: true,
      windows: [{ windowId: "rolling", usedPercent: 10 }],
    });
  });

  it("skips invalid windows and rejects when none remain", async () => {
    const codexHome = await createCodexHome();
    const adapter = createOpencodeGoAccountAdapter({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: async () => new Response(JSON.stringify({
        usage: {
          rolling: { status: "ok", percent: "broken", resetsAt: "not-a-date" },
        },
      }), { status: 200 }),
    });

    await expect(adapter.accountUsage()).rejects.toMatchObject({
      code: "provider.account.unavailable",
      message: "OpenCode Go 账户查询失败",
    });
  });
});

async function createCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-account-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "config.toml"), 'model = "gpt-5.6-sol"\n', { mode: 0o600 });
  await writeFile(
    join(directory, "sf-opencode-go.config.toml"),
    `model = "deepseek-v4-flash"\nmodel_provider = "opencode-go"\n${providerConfig("sk-test-secret")}`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "sf-opencode-go.managed.toml"),
    'version = 1\nprovider = "opencode-go"\n',
    { mode: 0o600 },
  );
  return directory;
}

function providerConfig(apiKey: string): string {
  return `[model_providers.opencode-go]\nname = "opencode-go"\nbase_url = "https://opencode.ai/zen/go/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\nexperimental_bearer_token = "${apiKey}"\n`;
}
