import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayAccountRefreshServer } from "../runtime/gateway-account-refresh.mjs";
import { OpenAiResetCreditService } from "../src/application/index.js";
import { cleanupWebuiTestFixtures, createWebuiTestFixture, startWebuiTestServer, type WebuiTestServer } from "./webui-server-test-fixture.js";
const roots: string[] = []; const servers: WebuiTestServer[] = [];
afterEach(async () => cleanupWebuiTestFixtures(servers, roots));
describe("WebUI reset credit confirmation over real IPC", () => {
  it.each(["reset", "unknown"])("requires origin and one-use confirmation, preserving %s outcome", async outcome => {
    const fixture = createWebuiTestFixture(roots);
    const consume = vi.fn(async () => { if (outcome === "unknown") throw new Error("private account response"); return "reset" as const; });
    const service = new OpenAiResetCreditService({ readResetCredits: async () => ({ accountId: "account", availableCount: "1",
      credits: [{ id: "credit", title: "Fixture", description: "Scope", expiresAt: null }] }), consumeResetCredit: consume }, async () => {});
    const ipc = new GatewayAccountRefreshServer(join(fixture.home, "config.toml"), async () => true,
      (request, signal) => request.method === "reset/list" ? service.list(signal)
        : request.method === "reset/preview" ? service.preview(request.creditId, signal) : service.consume(request.attemptId, signal));
    await ipc.start();
    try {
      const managementOrigin = "http://127.0.0.1:0";
      const { origin } = await startWebuiTestServer(servers, fixture.environment, undefined, { managementOrigin, token: "fixture-token" });
      const base = `${origin}/api/v1/management/accounts/openai/reset-credits`;
      const post = (path: string, body: unknown, source = managementOrigin) => fetch(`${base}/${path}`, {
        method: "POST", headers: { authorization: "Bearer fixture-token", origin: source, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect((await fetch(base)).status).toBe(401);
      expect((await fetch(base, { headers: { authorization: "Bearer fixture-token" } })).status).toBe(200);
      const forbidden = await post("preview", { creditId: "credit" }, "https://attacker.invalid");
      expect(forbidden.status).toBe(403);
      expect((await post("consume", {})).status).toBe(400);
      const response = await post("preview", { creditId: "credit" });
      expect(response.status).toBe(200);
      const preview = await response.json() as { preview: { attemptId: string }; confirmationToken: string };
      expect(consume).not.toHaveBeenCalled();
      const input = { attemptId: preview.preview.attemptId, confirmationToken: preview.confirmationToken };
      const result = await post("consume", input);
      expect(result.status).toBe(outcome === "reset" ? 200 : 503);
      const body = await result.json();
      expect(body).toMatchObject(outcome === "reset" ? { outcome: "reset", refreshed: true, auditRecorded: true } : { error: { code: "reset_unknown" } });
      expect(JSON.stringify(body)).not.toContain("private account response");
      expect((await post("consume", input)).status).toBe(409);
      expect(consume).toHaveBeenCalledOnce();
    } finally { await ipc.close(); }
  });
});
