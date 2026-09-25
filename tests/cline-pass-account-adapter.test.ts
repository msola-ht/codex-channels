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
  writePrivateFileAtomicSync(join(environment.CODEX_CONNECT_HOME, "providers", "deepseek", "models.json"), JSON.stringify({ models: [{
    slug: "deepseek-flash", display_name: "DeepSeek Flash", visibility: "list", supported_in_api: true,
    context_window: 64000, max_context_window: 128000, input_modalities: ["text", "image"],
    default_reasoning_level: "high", supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort })),
  }] }));
  writePrivateFileAtomicSync(join(environment.CODEX_HOME, "config.toml"), 'model_provider = "openai"\n');
  await applyClinePassConfiguration({accountId:"test", apiKey: "sk_fixture-secret", mode, confirmExclusiveConfigChange: true }, { environment });
  return environment;
}

it.each(["switching", "exclusive"] as const)("queries Cline quota using %s credentials", async mode => {
  const fetchImpl = vi.fn(async () => Response.json(valid));
  const adapter = createClinePassAccountAdapter({provider:"clp-test", environment: await fixture(mode), fetchImpl });
  expect(await adapter.accountUsage()).toEqual({ kind: "quota-windows", provider: "clp-test", available: true,
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
  const adapter = createClinePassAccountAdapter({provider:"clp-test", environment: await fixture(), fetchImpl });
  const snapshots: OfficialAccountSnapshot[] = [];
  const service = new ProviderAccountService([adapter], { writeOfficialAccountSnapshot: snapshot => { snapshots.push(snapshot); } });
  await service.refreshAccountSnapshot("clp-test");
  await expect(service.refreshAccountSnapshot("clp-test")).rejects.toMatchObject({ code: "provider.account.unavailable", message: "CLP 账户查询失败" });
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ available: true, usage: { kind: "quota-windows" } });
});

it.each([401, 403, 429, 500])("sanitizes HTTP %s without claiming no subscription", async status => {
  const adapter = createClinePassAccountAdapter({provider:"clp-test", environment: await fixture(), fetchImpl: async () => new Response("secret", { status }) });
  await expect(adapter.accountUsage()).rejects.toMatchObject({ message: "CLP 账户查询失败" });
});

it.each(["oversize", "invalid-json", "network"])("sanitizes %s failures", async kind => {
  const adapter = createClinePassAccountAdapter({provider:"clp-test", environment: await fixture(), fetchImpl: async () => {
    if (kind === "network") throw new Error("secret");
    return new Response(kind === "oversize" ? "x".repeat(65537) : "secret");
  } });
  await expect(adapter.accountUsage()).rejects.toMatchObject({ message: "CLP 账户查询失败" });
});

it("refreshes two account quotas concurrently with their own credentials and snapshots", async () => {
  const environment = await fixture();
  await applyClinePassConfiguration({ accountId: "work", apiKey: "sk_work" }, { environment });
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const key = new Headers(init?.headers).get("authorization")!;
    seen.push(key);
    return Response.json({ success: true, data: { limits: valid.data.limits.map(limit => ({ ...limit, percentUsed: key === "Bearer sk_work" ? 70 : 10 })) } });
  };
  const snapshots: OfficialAccountSnapshot[] = [];
  const service = new ProviderAccountService(["clp-test", "clp-work"].map(provider =>
    createClinePassAccountAdapter({ provider: provider as `clp-${string}`, environment, fetchImpl })),
  { writeOfficialAccountSnapshot: snapshot => { snapshots.push(snapshot); } });
  await Promise.all([service.refreshAccountSnapshot("clp-test"), service.refreshAccountSnapshot("clp-work")]);
  expect(seen.sort()).toEqual(["Bearer sk_fixture-secret", "Bearer sk_work"]);
  for (const [provider, usedPercent] of [["clp-test", 10], ["clp-work", 70]]) {
    expect(snapshots.find(snapshot => snapshot.provider === provider)).toMatchObject({ usage: { windows: [{ usedPercent }, { usedPercent }, { usedPercent }] } });
  }
});
