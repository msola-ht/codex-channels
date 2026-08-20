import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpencodeGoQuotaWindowsProvider } from "../runtime/opencode-go-quota-windows.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("OpenCode Go quota windows provider", () => {
  it("caches window snapshots until the earliest reset time", async () => {
    const codexHome = await createCodexHome();
    const nowMs = Date.parse("2026-08-17T14:00:00.000Z");
    const rollingResetsAt = new Date(nowMs + 30 * 60 * 1_000).toISOString();
    const weeklyResetsAt = new Date(nowMs + 12 * 60 * 60 * 1_000).toISOString();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 45, resetsAt: rollingResetsAt },
        weekly: { status: "ok", percent: 18, resetsAt: weeklyResetsAt },
        monthly: { status: "ok", percent: 15, resetsAt: "2026-09-15T10:22:00.000Z" },
      },
    }), { status: 200 }));
    const provider = createOpencodeGoQuotaWindowsProvider({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => nowMs,
    });
    const expected = [
      { windowId: "rolling", resetsAt: Math.floor(Date.parse(rollingResetsAt) / 1_000) },
      { windowId: "weekly", resetsAt: Math.floor(Date.parse(weeklyResetsAt) / 1_000) },
      {
        windowId: "monthly",
        resetsAt: Math.floor(Date.parse("2026-09-15T10:22:00.000Z") / 1_000),
      },
    ];

    await expect(provider()).resolves.toEqual(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(provider()).resolves.toEqual(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the earliest reset time passes", async () => {
    const codexHome = await createCodexHome();
    let nowMs = Date.parse("2026-08-17T14:00:00.000Z");
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({
        usage: {
          rolling: {
            status: "ok",
            percent: calls * 10,
            resetsAt: new Date(nowMs + 30 * 60 * 1_000).toISOString(),
          },
          weekly: {
            status: "ok",
            percent: calls * 5,
            resetsAt: new Date(nowMs + 12 * 60 * 60 * 1_000).toISOString(),
          },
          monthly: { status: "ok", percent: calls * 2, resetsAt: "2026-09-15T10:22:00.000Z" },
        },
      }), { status: 200 });
    });
    const provider = createOpencodeGoQuotaWindowsProvider({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => nowMs,
    });

    const first = await provider();
    expect(calls).toBe(1);
    expect(first?.[0]?.resetsAt).toBe(
      Math.floor((nowMs + 30 * 60 * 1_000) / 1_000),
    );

    nowMs += 31 * 60 * 1_000;
    const second = await provider();
    expect(calls).toBe(2);
    expect(second?.[0]?.resetsAt).toBe(
      Math.floor((nowMs + 30 * 60 * 1_000) / 1_000),
    );
  });

  it("backs off when a successful snapshot contains an already elapsed reset time", async () => {
    const codexHome = await createCodexHome();
    const nowMs = Date.parse("2026-08-17T14:00:00.000Z");
    const elapsedReset = new Date(nowMs - 1_000).toISOString();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 45, resetsAt: elapsedReset },
        weekly: { status: "ok", percent: 18, resetsAt: elapsedReset },
        monthly: { status: "ok", percent: 15, resetsAt: elapsedReset },
      },
    }), { status: 200 }));
    const provider = createOpencodeGoQuotaWindowsProvider({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => nowMs,
    });

    await expect(provider()).resolves.toHaveLength(3);
    await expect(provider()).resolves.toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("backs off for a short interval after a failed fetch", async () => {
    const codexHome = await createCodexHome();
    let nowMs = Date.parse("2026-08-17T14:00:00.000Z");
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    const provider = createOpencodeGoQuotaWindowsProvider({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => nowMs,
    });

    await expect(provider()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowMs += 30_000;
    await expect(provider()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowMs += 31_000;
    await expect(provider()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off when the usage response has no usable windows", async () => {
    const codexHome = await createCodexHome();
    let nowMs = Date.parse("2026-08-17T14:00:00.000Z");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {},
    }), { status: 200 }));
    const provider = createOpencodeGoQuotaWindowsProvider({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => nowMs,
    });

    await expect(provider()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowMs += 30_000;
    await expect(provider()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    nowMs += 31_000;
    await expect(provider()).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches successful snapshots without reset times for a short interval", async () => {
    const codexHome = await createCodexHome();
    const nowMs = Date.parse("2026-08-17T14:00:00.000Z");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 45 },
        weekly: { status: "ok", percent: 18 },
        monthly: { status: "ok", percent: 15 },
      },
    }), { status: 200 }));
    const provider = createOpencodeGoQuotaWindowsProvider({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      nowMs: () => nowMs,
    });

    await expect(provider()).resolves.toEqual([
      { windowId: "rolling", resetsAt: null },
      { windowId: "weekly", resetsAt: null },
      { windowId: "monthly", resetsAt: null },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(provider()).resolves.toEqual([
      { windowId: "rolling", resetsAt: null },
      { windowId: "weekly", resetsAt: null },
      { windowId: "monthly", resetsAt: null },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

async function createCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-quota-windows-"));
  temporaryDirectories.push(directory);
  const providerDirectory = join(
    directory,
    ".codex-connect",
    "providers",
    "opencode-go",
  );
  await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "config.toml"), 'model = "gpt-5.6-sol"\n', { mode: 0o600 });
  await writeFile(
    join(directory, "sf-opencode-go.config.toml"),
    `model = "deepseek-v4-flash"\nmodel_provider = "opencode-go"\n${providerConfig("sk-test-secret")}`,
    { mode: 0o600 },
  );
  await writeFile(
    join(providerDirectory, "managed.toml"),
    'version = 1\nprovider = "opencode-go"\n',
    { mode: 0o600 },
  );
  return directory;
}

function testEnvironment(codexHome: string): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: codexHome,
    CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
  };
}

function providerConfig(apiKey: string): string {
  return `[model_providers.opencode-go]\nname = "opencode-go"\nbase_url = "https://opencode.ai/zen/go/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\nexperimental_bearer_token = "${apiKey}"\n`;
}
