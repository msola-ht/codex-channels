import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayAccountRefreshServer,
  requestGatewayAccountRefresh,
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
  it("refreshes a supported account through the private Gateway endpoint", async () => {
    const configPath = createConfigPath();
    const refreshAccount = vi.fn(async (provider: string) => provider === "deepseek");
    const server = new GatewayAccountRefreshServer(configPath, refreshAccount);
    servers.push(server);
    await server.start();

    await expect(requestGatewayAccountRefresh(configPath, "deepseek"))
      .resolves.toEqual({ provider: "deepseek" });
    expect(refreshAccount).toHaveBeenCalledWith("deepseek");
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

  it("waits for an active refresh before closing", async () => {
    const configPath = createConfigPath();
    let completeRefresh: ((supported: boolean) => void) | undefined;
    let markRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const server = new GatewayAccountRefreshServer(configPath, async () => {
      markRefreshStarted?.();
      return await new Promise<boolean>((resolve) => {
        completeRefresh = resolve;
      });
    });
    servers.push(server);
    await server.start();

    const request = requestGatewayAccountRefresh(configPath, "deepseek");
    await refreshStarted;
    const close = server.close();
    let closed = false;
    void close.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    completeRefresh?.(true);
    await expect(request).resolves.toEqual({ provider: "deepseek" });
    await close;
  });
});

function createConfigPath(): string {
  const directory = mkdtempSync(join(socketTmpdir, "codexc-account-refresh-"));
  temporaryDirectories.push(directory);
  return join(directory, "config.toml");
}
