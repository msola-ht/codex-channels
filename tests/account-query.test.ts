import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { AccountQuery } from "../src/bootstrap/account-query.js";

afterEach(() => vi.restoreAllMocks());

describe("account query boundary", () => {
  it.each([[401, "authentication"], [403, "authentication"], [429, "rate-limited"], [503, "upstream"]] as const)("classifies HTTP %i without storing its body in diagnostics", async (status, reason) => {
    const query = new AccountQuery("fixture");
    const error = await query.run(() => query.json(async () => new Response("secret", { status }), "https://fixture.invalid", "secret-key", "usage")).catch(error => error);
    expect(error.diagnostic).toMatchObject({ reason, httpStatus: status, stage: "request", operation: "usage" });
    expect(JSON.stringify(error.diagnostic)).not.toContain("secret");
  });

  it("distinguishes credentials, malformed response, network and local processing failures", async () => {
    for (const [phase, reason] of [["configuration", "configuration"], ["parse", "invalid-response"], ["request", "network"], ["local", "internal"]] as const) {
      const query = new AccountQuery("fixture");
      query.stage = phase;
      const error = await query.run(async () => { throw new Error("secret failure"); }).catch(error => error);
      expect(error.diagnostic.reason).toBe(reason);
      expect(JSON.stringify(error.diagnostic)).not.toContain("secret");
    }
    const query = new AccountQuery("fixture");
    const error = await query.run(() => query.json(async () => { throw new TypeError("private", { cause: Object.assign(new Error("private"), { code: "ECONNRESET" }) }); }, "https://fixture.invalid", "key", "usage")).catch(error => error);
    expect(error.diagnostic).toMatchObject({ reason: "network", networkCode: "ECONNRESET" });
  });

  it("enforces the shared deadline while reading a real stalled HTTP response", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 10_000 ? 500 : ms));
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"pending":');
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const query = new AccountQuery("fixture");
      await expect(query.run(() => query.json(fetch, `http://127.0.0.1:${address.port}`, "fixture", "usage")))
        .rejects.toMatchObject({ diagnostic: { reason: "timeout", stage: "response" } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
