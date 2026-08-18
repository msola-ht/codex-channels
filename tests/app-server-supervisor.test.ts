import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppServerSupervisorOwner,
  appServerSupervisorSocketPath,
  ensureAppServerProvider,
  inspectAppServerSupervisor,
  releaseAppServerProvider,
} from "../runtime/app-server-supervisor.mjs";

const temporaryDirectories: string[] = [];
const unixSocketTmpdir = process.platform === "darwin" ? "/tmp" : tmpdir();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("App Server supervisor", () => {
  it("refuses an unsafe supervisor path before requesting a Provider", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-unsafe-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    writeFileSync(appServerSupervisorSocketPath(primarySocketPath), "not a socket", {
      mode: 0o600,
    });

    await expect(ensureAppServerProvider(primarySocketPath, "opencode-go"))
      .rejects.toThrow("监管 Socket 路径不安全");
  });

  it("starts a configured Provider through the private supervisor request", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-provider-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const ensured: string[] = [];
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["deepseek", "opencode-go"],
      socketPaths: [
        primarySocketPath,
        join(runtimeDir, "codex-app-server-deepseek.sock"),
        join(runtimeDir, "codex-app-server-opencode-go.sock"),
      ],
    }, {
      ensureProvider: async (provider) => { ensured.push(provider); },
    });
    await owner.start();

    await ensureAppServerProvider(primarySocketPath, "opencode-go");

    expect(ensured).toEqual(["opencode-go"]);
    await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
      version: 2,
      managedProviders: ["deepseek", "opencode-go"],
    });
    await owner.close();
  });

  it("rejects a supervisor socket path that exceeds the platform length limit", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-long-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, `${"a".repeat(110)}.sock`);
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: [],
      socketPaths: [primarySocketPath],
    });

    await expect(owner.start()).rejects.toThrow("路径可能超过平台长度限制");
  });

  it("releases a Provider through the private supervisor request", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-release-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const released: string[] = [];
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["opencode-go-main"],
      socketPaths: [
        primarySocketPath,
        join(runtimeDir, "codex-app-server-opencode-go-main.sock"),
      ],
    }, {
      releaseProvider: async (provider) => {
        if (provider !== "opencode-go-main") {
          throw new Error("未知 Provider");
        }
        released.push(provider);
        return true;
      },
    });
    await owner.start();

    await expect(releaseAppServerProvider(primarySocketPath, "opencode-go-main"))
      .resolves.toBe(true);
    expect(released).toEqual(["opencode-go-main"]);
    await expect(releaseAppServerProvider(primarySocketPath, "unknown-provider"))
      .rejects.toThrow("未知 Provider");
    await owner.close();
  });

  it("closes promptly while a local client keeps its connection open", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-close-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: [],
      socketPaths: [primarySocketPath],
    });
    await owner.start();
    const client = createConnection(appServerSupervisorSocketPath(primarySocketPath));
    client.on("error", () => undefined);
    client.pause();
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client.once("connect", resolveConnect);
      client.once("error", rejectConnect);
    });

    const closed = await Promise.race([
      owner.close().then(() => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 250)),
    ]);

    client.destroy();
    expect(closed).toBe(true);
    expect(existsSync(appServerSupervisorSocketPath(primarySocketPath))).toBe(false);
  });
});
