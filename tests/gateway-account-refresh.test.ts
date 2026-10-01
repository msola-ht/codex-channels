import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayAccountRefreshError,
  GatewayAccountRefreshServer,
  requestGatewayAccountRefresh,
  requestGatewayResetCredits,
} from "../runtime/gateway-account-refresh.mjs";

const temporaryDirectories: string[] = [];
const servers: GatewayAccountRefreshServer[] = [];
const socketTmpdir = process.platform === "darwin" ? "/tmp" : tmpdir();

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Gateway account refresh IPC", () => {
  it("routes reset requests and strips internal failure text", async () => {
    const configPath = createConfigPath();
    const reset = vi.fn(async (request: { method: string }) => {
      if (request.method === "reset/consume") throw new GatewayAccountRefreshError("reset_unknown", "sensitive payload");
      return { credits: [] };
    });
    const server = new GatewayAccountRefreshServer(configPath, async () => true, reset);
    servers.push(server); await server.start();
    await expect(requestGatewayResetCredits(configPath, { method: "reset/list" })).resolves.toEqual({ credits: [] });
    await expect(requestGatewayResetCredits(configPath, { method: "reset/consume", attemptId: "attempt" })).rejects.toMatchObject({ code: "reset_unknown" });
    await expect(requestGatewayResetCredits(configPath, { method: "reset/preview", creditId: "" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(requestGatewayResetCredits(configPath, { method: "reset/cancel", attemptId: "attempt" })).resolves.toEqual({ credits: [] });
    await expect(requestGatewayResetCredits(configPath, { method: "reset/cancel", attemptId: "" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(reset).toHaveBeenCalledTimes(3);
  });

  it("refreshes a supported account through the private Gateway endpoint", async () => {
    const configPath = createConfigPath();
    const refreshAccount = vi.fn(async (provider: string) => provider === "deepseek");
    const server = new GatewayAccountRefreshServer(configPath, refreshAccount);
    servers.push(server);
    await server.start();

    await expect(requestGatewayAccountRefresh(configPath, "deepseek"))
      .resolves.toEqual({ provider: "deepseek" });
    expect(refreshAccount).toHaveBeenCalledWith("deepseek", expect.any(AbortSignal));
  });

  it("returns stable errors for unknown providers and refresh failures", async () => {
    const configPath = createConfigPath();
    const server = new GatewayAccountRefreshServer(configPath, async (provider) => {
      if (provider === "ocg-failed") throw new Error("sensitive upstream failure");
      return false;
    });
    servers.push(server);
    await server.start();

    await expect(requestGatewayAccountRefresh(configPath, "ocg-missing"))
      .rejects.toMatchObject({ code: "provider_not_found" });
    await expect(requestGatewayAccountRefresh(configPath, "ocg-failed"))
      .rejects.toMatchObject({
        code: "refresh_failed",
        message: "账户刷新失败",
      });
  });

  it("generates public text from safe reasons, never from exception messages", async () => {
    const configPath = createConfigPath();
    const server = new GatewayAccountRefreshServer(configPath, async provider => {
      throw new GatewayAccountRefreshError("refresh_failed", "secret response", { ...(provider === "clp-main" ? { reason: "authentication" as const } : {}) });
    });
    servers.push(server);
    await server.start();
    await expect(requestGatewayAccountRefresh(configPath, "clp-main")).rejects.toMatchObject({ code: "refresh_failed", message: "账户认证失败，请检查配置" });
    await expect(requestGatewayAccountRefresh(configPath, "ccg-main")).rejects.toMatchObject({ code: "refresh_failed", message: "账户刷新失败" });
  });

  it.each(["caller", "shutdown"])("cancels an active refresh on %s even when a callback never resolves", async mode => {
    const configPath = createConfigPath();
    let outbound: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const server = new GatewayAccountRefreshServer(configPath, (_provider, signal) => {
      outbound = signal;
      started();
      return new Promise<boolean>(() => {});
    });
    servers.push(server);
    await server.start();
    const caller = new AbortController();
    const result = requestGatewayAccountRefresh(configPath, "ds-main", caller.signal);
    const rejected = expect(result).rejects.toBeInstanceOf(Error);
    await ready;
    if (mode === "caller") caller.abort();
    else await server.close();
    await rejected;
    await vi.waitFor(() => expect(outbound?.aborted).toBe(true));
    await server.close();
  });

});

function createConfigPath(): string {
  const directory = mkdtempSync(join(socketTmpdir, "codexc-account-refresh-"));
  temporaryDirectories.push(directory);
  return join(directory, "config.toml");
}
