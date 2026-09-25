import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClinePassAccountAdapter } from "../src/bootstrap/cline-pass-account-adapter.js";
import { ProviderAccountService, type OfficialAccountSnapshot } from "../src/application/index.js";
import { applyClinePassConfiguration } from "../scripts/cline-pass-setup.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";

vi.mock("../scripts/model-catalog-validation.mjs", () => ({ validateModelCatalogWithCodex: async () => undefined }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const reset = "2026-10-25T06:33:57.103237285Z";
const valid = { success: true, data: { limits: ["five_hour", "weekly", "monthly"].map((type, index) => ({ type, percentUsed: index * 12.5, resetsAt: reset })) } };
async function fixture(mode: "switching" | "exclusive" = "switching") {
  const root = mkdtempSync(join(tmpdir(), "cline-quota-")); roots.push(root);
  const environment = { CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
  writePrivateFileAtomicSync(join(environment.CODEX_HOME, "config.toml"), 'model_provider = "openai"\n');
  await applyClinePassConfiguration({ apiKey: "sk_fixture-secret", contextWindow: 64000, mode, confirmExclusiveConfigChange: true }, { environment });
  return environment;
}

it.each(["switching", "exclusive"] as const)("queries Cline quota using %s credentials", async mode => {
  const fetchImpl = vi.fn(async () => Response.json(valid));
  const adapter = createClinePassAccountAdapter({ environment: await fixture(mode), fetchImpl });
  expect(await adapter.accountUsage()).toEqual({ kind: "quota-windows", provider: "cline-pass", available: true,
    windows: ["five-hour", "weekly", "monthly"].map((windowId, index) => ({ windowId, label: ["5小时", "7天", "月度"][index], usedPercent: index * 12.5, resetsAt: Math.floor(Date.parse(reset) / 1000), status: null })) });
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://api.cline.bot/api/v1/users/me/plan/usage-limits", expect.objectContaining({
    method: "GET", redirect: "error", signal: expect.any(AbortSignal), headers: { accept: "application/json", authorization: "Bearer sk_fixture-secret" },
  }));
});

it.each([
  {}, { ...valid, success: false }, { success: true, data: { limits: [] } },
  ...[
    { type: "unknown" }, { type: "weekly" }, { percentUsed: "0" }, { percentUsed: -1 },
    { resetsAt: null }, { resetsAt: "secret" }, { resetsAt: "2026-02-31T06:33:57Z" },
  ].map(change => ({ success: true, data: { limits: [{ ...valid.data.limits[0], ...change }, ...valid.data.limits.slice(1)] } })),
])("preserves a valid snapshot on malformed quota responses", async invalid => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(valid)).mockResolvedValueOnce(Response.json(invalid));
  const adapter = createClinePassAccountAdapter({ environment: await fixture(), fetchImpl });
  const snapshots: OfficialAccountSnapshot[] = [];
  const service = new ProviderAccountService([adapter], { writeOfficialAccountSnapshot: snapshot => { snapshots.push(snapshot); } });
  await service.refreshAccountSnapshot("cline-pass");
  await expect(service.refreshAccountSnapshot("cline-pass")).rejects.toMatchObject({ code: "provider.account.unavailable", message: "Cline Pass 账户查询失败" });
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ available: true, usage: { kind: "quota-windows" } });
});

it.each([401, 403, 429, 500])("sanitizes HTTP %s without claiming no subscription", async status => {
  const adapter = createClinePassAccountAdapter({ environment: await fixture(), fetchImpl: async () => new Response("secret", { status }) });
  await expect(adapter.accountUsage()).rejects.toMatchObject({ message: "Cline Pass 账户查询失败" });
});

it.each(["oversize", "invalid-json", "network"])("sanitizes %s failures", async kind => {
  const adapter = createClinePassAccountAdapter({ environment: await fixture(), fetchImpl: async () => {
    if (kind === "network") throw new Error("secret");
    return new Response(kind === "oversize" ? "x".repeat(65537) : "secret");
  } });
  await expect(adapter.accountUsage()).rejects.toMatchObject({ message: "Cline Pass 账户查询失败" });
});
