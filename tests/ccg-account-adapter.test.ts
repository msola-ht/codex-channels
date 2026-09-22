import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCcgAccountAdapter } from "../src/bootstrap/ccg-account-adapter.js";
import {
  configureCcgAccounts,
  testEnvironment,
} from "./model-provider-runtime-test-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("CCG account adapter", () => {
  it("reads the selected account credential and maps credits plus quota windows", async () => {
    const codexHome = await createCodexHome();
    const fiveHourResetAt = Date.parse("2026-09-21T18:00:00.000Z");
    const weeklyResetAt = Date.parse("2026-09-28T00:00:00.000Z");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
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
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
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
});

async function createCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexc-ccg-account-adapter-"));
  temporaryDirectories.push(directory);
  configureCcgAccounts(directory);
  return directory;
}
