import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readOpenAiCredentialRefreshTime } from "../runtime/openai-credentials.mjs";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(lastRefresh: unknown, claims: Record<string, unknown> = {}, tokens: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "credentials-")); directories.push(directory);
  const payload = { exp: 1, "https://api.openai.com/auth": { chatgpt_account_id: "account-a", ...claims } };
  await writeFile(join(directory, "auth.json"), JSON.stringify({ tokens: { account_id: "account-a", id_token: `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`, access_token: "SECRET", ...tokens }, last_refresh: lastRefresh }));
  return { CODEX_HOME: directory };
}
it("returns only last_refresh for the matching quota account, without using token expiry or subscription claims", async () => {
  const environment = await fixture("2026-09-23T02:41:57.551880Z", { chatgpt_subscription_active_until: "2026-10-03T02:05:55Z", chatgpt_subscription_last_checked: "2026-09-24T02:41:57Z" });
  expect(await readOpenAiCredentialRefreshTime("account-a", environment)).toBe(1790131317);
  expect(await readOpenAiCredentialRefreshTime("account-b", environment)).toBeNull();
  expect(await readOpenAiCredentialRefreshTime(null, environment)).toBeNull();
});
it("matches the selected credential account instead of a conflicting ID token account", async () => {
  const environment = await fixture("2026-09-23T02:41:57Z", { chatgpt_account_id: "previous-account" });
  expect(await readOpenAiCredentialRefreshTime("account-a", environment)).toBe(1790131317);
  expect(await readOpenAiCredentialRefreshTime("previous-account", environment)).toBeNull();
});
it("reads the selected account refresh time without an ID token", async () => {
  const environment = await fixture("2026-09-23T02:41:57Z", {}, { id_token: undefined });
  expect(await readOpenAiCredentialRefreshTime("account-a", environment)).toBe(1790131317);
});
it.each([undefined, null, "", 123])("does not fall back to ID token claims when the selected account is %j", async accountId => {
  const environment = await fixture("2026-09-23T02:41:57Z", {}, { account_id: accountId });
  expect(await readOpenAiCredentialRefreshTime("account-a", environment)).toBeNull();
});
it.each([undefined, null, "secret", 123, "2026-09-23", "1970-01-01T00:00:00Z"])("omits missing or malformed credential refresh time %j", async lastRefresh => {
  const environment = await fixture(lastRefresh, { chatgpt_subscription_last_checked: "2026-09-23T02:41:57Z" });
  expect(await readOpenAiCredentialRefreshTime("account-a", environment)).toBeNull();
});
it("omits malformed and oversized credential files", async () => {
  const environment = await fixture("2026-09-23T02:41:57Z");
  await writeFile(join(environment.CODEX_HOME, "auth.json"), "invalid SECRET");
  expect(await readOpenAiCredentialRefreshTime("account-a", environment)).toBeNull();
  await writeFile(join(environment.CODEX_HOME, "auth.json"), "x".repeat(128 * 1024 + 1));
  expect(await readOpenAiCredentialRefreshTime("account-a", environment)).toBeNull();
});
it("handles timezone offsets and absent credential files", async () => {
  const environment = await fixture("2026-10-03T03:05:55+01:00");
  expect(await readOpenAiCredentialRefreshTime("account-a", environment)).toBe(1790993155);
  await rm(join(environment.CODEX_HOME, "auth.json"));
  expect(await readOpenAiCredentialRefreshTime("account-a", environment)).toBeNull();
});
