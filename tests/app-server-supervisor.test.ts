import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppServerSupervisorOwner,
  acquireAppServerProviderLease,
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
      version: 4,
      managedProviders: ["deepseek", "opencode-go"],
    });
    await owner.close();
  });

  it("accepts the exact uppercase OpenAI custom Provider ID", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-openai-alias-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const ensured: string[] = [];
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["OpenAI"],
      socketPaths: [
        primarySocketPath,
        join(runtimeDir, "codex-app-server-OpenAI.sock"),
      ],
    }, {
      ensureProvider: async (provider) => { ensured.push(provider); },
    });
    await owner.start();

    await ensureAppServerProvider(primarySocketPath, "OpenAI");

    expect(ensured).toEqual(["OpenAI"]);
    await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
      managedProviders: ["OpenAI"],
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
      managedProviders: ["opencode-go"],
      socketPaths: [
        primarySocketPath,
        join(runtimeDir, "codex-app-server-opencode-go.sock"),
      ],
    }, {
      releaseProvider: async (provider) => {
        if (provider !== "opencode-go") {
          throw new Error("未知 Provider");
        }
        released.push(provider);
        return true;
      },
    });
    await owner.start();

    await expect(releaseAppServerProvider(primarySocketPath, "opencode-go"))
      .resolves.toEqual({ released: true, reason: "released" });
    expect(released).toEqual(["opencode-go"]);
    await expect(releaseAppServerProvider(primarySocketPath, "unknown-provider"))
      .rejects.toThrow("未知 Provider");
    await owner.close();
  });

  it("distinguishes a missing Provider process from a held lease", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-missing-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["opencode-go"],
      socketPaths: [primarySocketPath],
    }, {
      releaseProvider: async () => false,
    });
    await owner.start();

    await expect(releaseAppServerProvider(primarySocketPath, "opencode-go"))
      .resolves.toEqual({ released: false, reason: "not-running" });
    await owner.close();
  });

  it("keeps a Provider running while a Remote client holds a lease", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-lease-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const released: string[] = [];
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["opencode-go"],
      socketPaths: [
        primarySocketPath,
        join(runtimeDir, "codex-app-server-opencode-go.sock"),
      ],
    }, {
      ensureProvider: async () => undefined,
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
    });
    await owner.start();
    const lease = await acquireAppServerProviderLease(primarySocketPath, "opencode-go");

    await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
      leasedProviders: ["opencode-go"],
    });
    await expect(releaseAppServerProvider(primarySocketPath, "opencode-go"))
      .resolves.toEqual({ released: false, reason: "leased" });
    expect(released).toEqual([]);

    await lease.close();
    await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
      leasedProviders: [],
    });
    await expect(releaseAppServerProvider(primarySocketPath, "opencode-go"))
      .resolves.toEqual({ released: true, reason: "released" });
    expect(released).toEqual(["opencode-go"]);
    await owner.close();
  });

  it("finishes an in-flight release before granting a new Provider lease", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-race-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    let finishRelease: (() => void) | undefined;
    let reportReleaseStarted: (() => void) | undefined;
    const releaseStarted = new Promise<void>((resolve) => {
      reportReleaseStarted = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["opencode-go"],
      socketPaths: [primarySocketPath],
    }, {
      ensureProvider: async () => undefined,
      releaseProvider: async () => {
        reportReleaseStarted?.();
        await releaseGate;
        return true;
      },
    });
    await owner.start();
    await ensureAppServerProvider(primarySocketPath, "opencode-go");
    const release = releaseAppServerProvider(primarySocketPath, "opencode-go");
    await releaseStarted;
    let leaseSettled = false;
    const leaseRequest = acquireAppServerProviderLease(primarySocketPath, "opencode-go")
      .then((lease) => {
        leaseSettled = true;
        return lease;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const settledBeforeReleaseFinished = leaseSettled;
    finishRelease?.();
    const lease = await leaseRequest;
    const released = await release;
    try {
      expect(settledBeforeReleaseFinished).toBe(false);
      expect(released).toEqual({ released: false, reason: "leased" });
      await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
        runningProviders: ["opencode-go"],
        releasedProviders: [],
        leasedProviders: ["opencode-go"],
      });
      const leaseClosed = await Promise.race([
        lease.close().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(leaseClosed).toBe(true);
    } finally {
      await owner.close();
    }
  });

  it("reports running and intentionally released Providers across lifecycle requests", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-state-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["opencode-go"],
      socketPaths: [
        primarySocketPath,
        join(runtimeDir, "codex-app-server-opencode-go.sock"),
      ],
    }, {
      ensureProvider: async () => undefined,
      releaseProvider: async () => true,
    });
    await owner.start();

    await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
      runningProviders: [],
      releasedProviders: [],
    });
    await ensureAppServerProvider(primarySocketPath, "opencode-go");
    await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
      runningProviders: ["opencode-go"],
      releasedProviders: [],
    });
    await releaseAppServerProvider(primarySocketPath, "opencode-go");
    await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
      runningProviders: [],
      releasedProviders: ["opencode-go"],
    });
    await ensureAppServerProvider(primarySocketPath, "opencode-go");
    await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
      runningProviders: ["opencode-go"],
      releasedProviders: [],
    });
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

  it("waits for an in-flight Provider operation before closing", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-operation-close-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    let finishEnsure: (() => void) | undefined;
    let reportEnsureStarted: (() => void) | undefined;
    const ensureStarted = new Promise<void>((resolve) => {
      reportEnsureStarted = resolve;
    });
    const ensureGate = new Promise<void>((resolve) => {
      finishEnsure = resolve;
    });
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: ["opencode-go"],
      socketPaths: [primarySocketPath],
    }, {
      ensureProvider: async () => {
        reportEnsureStarted?.();
        await ensureGate;
      },
    });
    await owner.start();
    const ensureRequest = ensureAppServerProvider(primarySocketPath, "opencode-go")
      .catch(() => undefined);
    await ensureStarted;
    let closeSettled = false;
    const closeRequest = owner.close().then(() => {
      closeSettled = true;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closeSettled).toBe(false);
    } finally {
      finishEnsure?.();
      await Promise.allSettled([ensureRequest, closeRequest]);
    }
    expect(closeSettled).toBe(true);
    expect(existsSync(appServerSupervisorSocketPath(primarySocketPath))).toBe(false);
  });
});
