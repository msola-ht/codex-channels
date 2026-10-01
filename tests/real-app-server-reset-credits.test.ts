import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient, JsonRpcClient, StdioTransport } from "../src/codex-client/index.js";

const suite = process.env.RUN_CODEX_CONTRACT === "1" ? describe : describe.skip;
suite("real App Server reset credit contract with isolated mock account", () => {
  it("reads selected credits and forwards an explicit idempotent consume without model calls", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reset-contract-"));
    const accountId = "123e4567-e89b-42d3-a456-426614174000";
    const calls: Array<{ path: string; body: unknown }> = [];
    let outcome = "reset";
    const backend = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += String(chunk);
      const path = request.url ?? ""; calls.push({ path, body: body ? JSON.parse(body) : null });
      response.setHeader("content-type", "application/json");
      const value = path.includes("accounts/check") ? { accounts: [{ id: accountId, workspace_backend_origin: "https://chatgpt.com", account_routing_override: "us" }] }
        : path.endsWith("/consume") ? { code: outcome, windows_reset: 2 }
        : path.endsWith("/rate-limit-reset-credits") ? { available_count: 1, total_earned_count: 1, credits: [
          { id: "credit-fixture", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-01-01T00:00:00Z", expires_at: null, title: "Fixture reset", description: "Fixture scope" },
        ] }
        : path.endsWith("/usage") ? { account_id: accountId, plan_type: "pro", rate_limit: { allowed: true, limit_reached: false,
          primary_window: { used_percent: 50, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: 2000000000 } },
          credits: { has_credits: true, unlimited: false, balance: "10" }, rate_limit_reset_credits: { available_count: 1 } }
        : { models: [] };
      response.end(JSON.stringify(value));
    });
    let client: CodexAppServerClient | undefined;
    try {
      await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
      const address = backend.address(); if (!address || typeof address === "string") throw new Error("No fixture address");
      const payload = Buffer.from(JSON.stringify({ email: "fixture@example.test", "https://api.openai.com/auth": {
        chatgpt_account_id: accountId, chatgpt_plan_type: "pro", chatgpt_user_id: "fixture-user",
      } })).toString("base64url");
      writeFileSync(join(directory, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {
        id_token: `eyJhbGciOiJub25lIn0.${payload}.fixture`, access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", account_id: accountId,
      }, last_refresh: new Date().toISOString() }), { mode: 0o600 });
      writeFileSync(join(directory, "config.toml"), `chatgpt_base_url = "http://127.0.0.1:${address.port}/backend-api"\ncli_auth_credentials_store = "file"\n`);
      client = new CodexAppServerClient(new JsonRpcClient(new StdioTransport({ codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: directory,
        environment: { PATH: process.env.PATH, CODEX_HOME: directory } })), { sandbox: "read-only" });
      await client.connect();
      await expect(client.readResetCredits()).resolves.toEqual({ accountId, availableCount: "1", credits: [
        { id: "credit-fixture", title: "Fixture reset", description: "Fixture scope", expiresAt: null },
      ] });
      for (const [code, expected] of [["reset", "reset"], ["nothing_to_reset", "nothingToReset"], ["no_credit", "noCredit"], ["already_redeemed", "alreadyRedeemed"]]) {
        outcome = code!;
        await expect(client.consumeResetCredit("credit-fixture", "fixture-attempt")).resolves.toBe(expected);
      }
      expect(calls.filter(call => call.path.endsWith("/consume")).map(call => call.body)).toEqual(Array(4).fill({ redeem_request_id: "fixture-attempt", credit_id: "credit-fixture" }));
      expect(calls.some(call => call.path.includes("responses"))).toBe(false);
    } finally {
      await client?.close(); backend.closeAllConnections();
      await new Promise<void>(resolve => backend.close(() => resolve()));
      rmSync(directory, { force: true, recursive: true });
    }
  }, 30_000);
});
