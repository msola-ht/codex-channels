import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readOpenAiSubscription } from "../runtime/openai-subscription.mjs";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(claims: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "subscription-")); directories.push(directory);
  const payload = { exp: 1, "https://api.openai.com/auth": { chatgpt_account_id: "account-a", ...claims } };
  await writeFile(join(directory, "auth.json"), JSON.stringify({ tokens: { id_token: `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`, access_token: "SECRET" } }));
  return { CODEX_HOME: directory };
}
it("returns only cache dates for the matching quota account, without using token expiry", async () => {
  const environment = await fixture({ chatgpt_subscription_active_until: "2026-10-03T02:05:55Z", chatgpt_subscription_last_checked: "2026-09-23T02:41:57.551880Z" });
  expect(await readOpenAiSubscription("account-a", environment)).toEqual({ activeUntil: 1790993155, lastChecked: 1790131317 });
  expect(await readOpenAiSubscription("account-b", environment)).toBeNull();
  expect(await readOpenAiSubscription(null, environment)).toBeNull();
});
it("omits missing and malformed dates without inferring them from token expiry", async () => {
  const environment = await fixture({ chatgpt_subscription_active_until: "secret", chatgpt_subscription_last_checked: 123 });
  expect(await readOpenAiSubscription("account-a", environment)).toBeNull();
  await writeFile(join(environment.CODEX_HOME, "auth.json"), "invalid SECRET");
  expect(await readOpenAiSubscription("account-a", environment)).toBeNull();
  await writeFile(join(environment.CODEX_HOME, "auth.json"), "x".repeat(128 * 1024 + 1));
  expect(await readOpenAiSubscription("account-a", environment)).toBeNull();
});
it("handles absent and single-date login metadata", async () => {
  const environment = await fixture({ chatgpt_subscription_active_until: "2026-10-03T02:05:55+00:00" });
  expect(await readOpenAiSubscription("account-a", environment)).toEqual({ activeUntil: 1790993155, lastChecked: null });
  await rm(join(environment.CODEX_HOME, "auth.json"));
  expect(await readOpenAiSubscription("account-a", environment)).toBeNull();
});
