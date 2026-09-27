import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCcgAccountAdapter } from "../src/bootstrap/ccg-account-adapter.js";
import { ProviderAccountService, type OfficialAccountSnapshot } from "../src/application/index.js";
import {
  configureCcgAccounts,
  testEnvironment,
} from "./model-provider-runtime-test-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("CCG account adapter", () => {
  it("expires the second request on the original deadline and keeps cancellation distinct", async () => {
    const codexHome = await createCodexHome();
    const budget = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      if (calls === 1) return Response.json({ success: true, user: {}, org: { id: "org-1" } });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        budget.abort(new DOMException("fixture", "TimeoutError"));
      });
    };
    const adapter = createCcgAccountAdapter({ provider: "ccg-main", environment: testEnvironment(codexHome), fetchImpl });
    await expect(adapter.accountUsage()).rejects.toMatchObject({ diagnostic: { reason: "timeout", operation: "credits" } });
    expect(calls).toBe(2);
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it("reads the selected account credential and maps credits plus quota windows", async () => {
    const codexHome = await createCodexHome();
    const fiveHourResetAt = Date.parse("2026-09-21T18:00:00.000Z");
    const weeklyResetAt = Date.parse("2026-09-28T00:00:00.000Z");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true, user: { id: "user-1" },
        org: { id: "org-1" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        credits: {
          planId: "individual-pro",
          monthlyCredits: 40,
          purchasedCredits: 5,
          freeCredits: 1,
        },
        windowLimits: {
          limited: true,
          fiveHour: { used: 4, cap: 16, resetAt: fiveHourResetAt },
          weekly: { used: 10, cap: 40, resetAt: weeklyResetAt },
        },
      }), { status: 200 }));
    const adapter = createCcgAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      provider: "ccg-work",
    });

    await expect(adapter.accountUsage()).resolves.toEqual({
      kind: "credit-usage",
      provider: "ccg-work",
      available: true,
      planId: "individual-pro",
      monthlyRemaining: "40.00",
      purchasedRemaining: "5.00",
      freeRemaining: "1.00",
      totalRemaining: "46.00",
      windows: [
        {
          windowId: "five-hour",
          label: "5小时",
          usedPercent: 25,
          resetsAt: fiveHourResetAt / 1_000,
          status: null,
        },
        {
          windowId: "weekly",
          label: "7天",
          usedPercent: 25,
          resetsAt: weeklyResetAt / 1_000,
          status: null,
        },
      ],
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.commandcode.ai/alpha/whoami?limits=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer cmd_work-secret" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.commandcode.ai/alpha/billing/credits?orgId=org-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer cmd_work-secret" }),
      }),
    );
  });

  it("queries personal credits without an org id", async () => {
    const codexHome = await createCodexHome();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, user: { id: "user-1" }, org: null }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        credits: { purchasedCredits: 2 },
        windowLimits: { limited: false },
      }), { status: 200 }));
    const adapter = createCcgAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      provider: "ccg-main",
    });

    await expect(adapter.accountUsage()).resolves.toMatchObject({
      provider: "ccg-main",
      totalRemaining: "2.00",
      windows: [],
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.commandcode.ai/alpha/billing/credits",
      expect.any(Object),
    );
  });

  it("fails with a stable user error without exposing malformed responses", async () => {
    const codexHome = await createCodexHome();
    const adapter = createCcgAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: async () => new Response("secret-upstream-body", { status: 200 }),
      provider: "ccg-work",
    });

    await expect(adapter.accountUsage()).rejects.toMatchObject({
      code: "provider.account.unavailable",
      message: "CCG 账户查询失败",
    });
  });

  it("keeps the underlying failure reason on the user-facing error", async () => {
    const codexHome = await createCodexHome();
    const adapter = createCcgAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: async () => { throw new Error("fixture network failure"); },
      provider: "ccg-work",
    });

    const failure: unknown = await adapter.accountUsage().catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("fixture network failure");
    expect(((failure as Error).cause as Error).message).toBe("fixture network failure");
  });

  it.each([null, {}, [], { error: { message: "private error" } },
    { credits: null }, { credits: [] }, { credits: "invalid" },
    { credits: {}, windowLimits: [] }, { credits: {}, windowLimits: { limited: "true" } },
    { credits: { monthlyCredits: "10" } },
    { credits: {}, windowLimits: { limited: true, fiveHour: { used: 1, cap: 0, resetAt: 1 } } },
  ].map((invalid) => ({ invalid })))("preserves the last successful snapshot when credits are malformed: $invalid", async ({ invalid }) => {
    const codexHome = await createCodexHome();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, user: {} }))
      .mockResolvedValueOnce(Response.json({ credits: { monthlyCredits: 10 } }))
      .mockResolvedValueOnce(Response.json({ success: true, user: {} }))
      .mockResolvedValueOnce(Response.json(invalid))
      .mockResolvedValueOnce(Response.json({ success: true, user: {} }))
      .mockResolvedValueOnce(Response.json({ credits: { monthlyCredits: 8 } }));
    const adapter = createCcgAccountAdapter({
      environment: testEnvironment(codexHome), fetchImpl, provider: "ccg-main",
    });
    const written: OfficialAccountSnapshot[] = [];
    const writer = { writeOfficialAccountSnapshot: (snapshot: OfficialAccountSnapshot) => { written.push(snapshot); } };
    const service = new ProviderAccountService([adapter], writer);
    await service.refreshAccountSnapshot("ccg-main");
    const previous = written[0];
    await expect(service.refreshAccountSnapshot("ccg-main")).rejects.toMatchObject({
      code: "provider.account.unavailable", message: "CCG 账户查询失败",
    });
    expect(written).toEqual([previous]);
    const restarted = new ProviderAccountService([adapter], writer);
    await restarted.refreshAccountSnapshot("ccg-main");
    expect(written.at(-1)).toMatchObject({ provider: "ccg-main", available: true, usage: { totalRemaining: "8.00" } });
  });

  it.each([null, [], {}, { success: false, user: {} }, { success: true, user: null },
    { success: true, user: {}, org: [] }, { success: true, user: {}, org: {} },
  ].map((invalid) => ({ invalid })))("does not query personal credits after an invalid identity response: $invalid", async ({ invalid }) => {
    const codexHome = await createCodexHome();
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(invalid));
    const adapter = createCcgAccountAdapter({
      environment: testEnvironment(codexHome), fetchImpl, provider: "ccg-main",
    });
    await expect(adapter.accountUsage()).rejects.toMatchObject({ code: "provider.account.unavailable" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("totals raw credits before rounding and retains optional zero balances", async () => {
    const codexHome = await createCodexHome();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, user: {} }))
      .mockResolvedValueOnce(Response.json({ credits: { monthlyCredits: 0.004, purchasedCredits: 0.004, freeCredits: 0.004 } }))
      .mockResolvedValueOnce(Response.json({ success: true, user: {} }))
      .mockResolvedValueOnce(Response.json({ credits: { freeCredits: null }, windowLimits: null }));
    const adapter = createCcgAccountAdapter({
      environment: testEnvironment(codexHome), fetchImpl, provider: "ccg-main",
    });
    await expect(adapter.accountUsage()).resolves.toMatchObject({ totalRemaining: "0.01" });
    await expect(adapter.accountUsage()).resolves.toMatchObject({ available: true, totalRemaining: "0.00", windows: [] });
  });

  it("bounds both CCG requests with one shared account query deadline", async () => {
    const codexHome = await createCodexHome();
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      signals.push(init?.signal);
      return String(input).includes("whoami")
        ? Response.json({ success: true, user: {}, org: { id: "org-1" } })
        : Response.json({ credits: { monthlyCredits: 1 } });
    };
    const adapter = createCcgAccountAdapter({
      environment: testEnvironment(codexHome), fetchImpl, provider: "ccg-main",
    });

    await expect(adapter.accountUsage()).resolves.toMatchObject({ kind: "credit-usage" });
    expect(signals).toHaveLength(2);
    // 两次串行请求共用同一个总预算信号，最坏耗时不会翻倍到撞上账户刷新 IPC 的上限。
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
  });
});

async function createCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexc-ccg-account-adapter-"));
  temporaryDirectories.push(directory);
  configureCcgAccounts(directory);
  return directory;
}


it("cancels the outbound account fetch with the completion signal", async () => {
  const controller = new AbortController();
  let outbound: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    outbound = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      outbound?.addEventListener("abort", () => reject(new Error("fixture aborted")), { once: true });
    });
  };
  const adapter = createCcgAccountAdapter({ provider: "ccg-work", environment: testEnvironment(await createCodexHome()), fetchImpl });
  const result = adapter.accountUsage(controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(outbound?.aborted).toBe(false);
  controller.abort();
  expect(outbound?.aborted).toBe(true);
  await rejected;
});
