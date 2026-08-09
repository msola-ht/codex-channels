import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GatewayOwner,
  gatewayOwnerSocketPath,
} from "../runtime/gateway-owner.mjs";

const temporaryDirectories: string[] = [];
const unixSocketTmpdir = process.platform === "darwin" ? "/tmp" : tmpdir();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Gateway owner", () => {
  it("allows only one Gateway for the same configuration regardless of Provider", async () => {
    const dataDir = mkdtempSync(join(unixSocketTmpdir, "codexc-gateway-owner-"));
    temporaryDirectories.push(dataDir);
    const configPath = join(dataDir, "config.toml");
    const first = new GatewayOwner(configPath);
    const second = new GatewayOwner(configPath);

    await first.start();
    const socketPath = gatewayOwnerSocketPath(configPath);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    await expect(second.start()).rejects.toThrow("Gateway 已在运行");

    await first.close();
    expect(existsSync(socketPath)).toBe(false);
    await second.start();
    await second.close();
  });

  it("makes concurrent close callers wait for the same Socket cleanup", async () => {
    const dataDir = mkdtempSync(join(unixSocketTmpdir, "codexc-gateway-owner-close-"));
    temporaryDirectories.push(dataDir);
    const configPath = join(dataDir, "config.toml");
    const owner = new GatewayOwner(configPath);
    await owner.start();
    const socketPath = gatewayOwnerSocketPath(configPath);
    const client = createConnection(socketPath);
    client.on("error", () => undefined);
    client.pause();
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client.once("connect", resolveConnect);
      client.once("error", rejectConnect);
    });

    const firstClose = owner.close();
    const secondClose = owner.close();
    await secondClose;

    expect(existsSync(socketPath)).toBe(false);
    client.destroy();
    await firstClose;
  });
});
