import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppServerSupervisorOwner,
  applyAppServerProviderSettings,
  acquireAppServerProviderLease,
  acquireMacDesktopAppHostLease,
  appServerSupervisorSocketPath,
  ensureAppServerProvider,
  inspectAppServerSupervisor,
  inspectAppServerSupervisorState,
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
  const unixIt = process.platform === "win32" ? it.skip : it;
  const darwinIt = process.platform === "darwin" ? it : it.skip;
  it("applies only the selected Provider and defers leased or active instances", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "sup-"));
    temporaryDirectories.push(root);
    const primary = join(root, "s.sock");
    const applied: string[] = [];
    const snapshot = { fingerprint: "a".repeat(64), defaultModel: "fixture-default" };
    let active = true;
    const owner = new AppServerSupervisorOwner(primary, {
      primaryProvider: "openai", managedProviders: ["ds-test"], socketPaths: [primary],
    }, {
      ensureProvider: async () => undefined,
      providerSettingsSnapshot: () => snapshot,
      applyProviderSettings: async provider => {
        if (active) return { applied: false, reason: "active" };
        applied.push(provider); return { applied: true, changed: true };
      },
    });
    let lease;
    try {
      await owner.start();
      await expect(applyAppServerProviderSettings(primary, "ds-test")).resolves.toEqual({ applied: false, reason: "active", snapshot });
      lease = await acquireAppServerProviderLease(primary, "ds-test");
      active = false;
      await expect(applyAppServerProviderSettings(primary, "ds-test")).resolves.toEqual({ applied: false, reason: "leased", snapshot });
      expect(applied).toEqual([]);
      await lease.close();
      await vi.waitFor(async () => expect((await inspectAppServerSupervisor(primary))?.leasedProviders).toEqual([]));
      await expect(applyAppServerProviderSettings(primary, "ds-test")).resolves.toEqual({ applied: true, changed: true, snapshot });
      expect(applied).toEqual(["ds-test"]);
      await expect(applyAppServerProviderSettings(primary, "unknown")).rejects.toThrow("应用失败");
    } finally { await lease?.close(); await owner.close(); }
  });

  it("rechecks a lease arriving during settings preparation before applying", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "sup-"));
    temporaryDirectories.push(root);
    const primary = join(root, "s.sock");
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = new AppServerSupervisorOwner(primary, {
      primaryProvider: "openai", managedProviders: [], socketPaths: [primary],
    }, {
      ensureProvider: async () => undefined,
      applyProviderSettings: async (_provider, _signal, canApply) => {
        enter(); await gate;
        return canApply() ? { applied: true, changed: true } : { applied: false, reason: "leased" };
      },
    });
    await owner.start();
    const applying = applyAppServerProviderSettings(primary, "openai");
    let lease;
    try {
      await entered;
      const acquiring = acquireAppServerProviderLease(primary, "openai");
      await vi.waitFor(async () => expect((await inspectAppServerSupervisor(primary))?.leasedProviders).toEqual(["openai"]));
      release();
      expect(await applying).toEqual({ applied: false, reason: "leased" });
      lease = await acquiring;
    } finally { release(); await applying.catch(() => undefined); await lease?.close(); await owner.close(); }
  });

  it.each(["caller", "owner"])("cancels settings preparation when the %s closes", async ending => {
    const root = mkdtempSync(join(unixSocketTmpdir, "sup-"));
    temporaryDirectories.push(root);
    const primary = join(root, "s.sock");
    let entered = false;
    let cancelled = false;
    const owner = new AppServerSupervisorOwner(primary, {
      primaryProvider: "openai", managedProviders: [], socketPaths: [primary],
    }, { applyProviderSettings: async (_provider, signal) => {
      entered = true;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      signal.throwIfAborted();
      return { applied: true, changed: true };
    } });
    const controller = new AbortController();
    try {
      await owner.start();
      const result = applyAppServerProviderSettings(primary, "openai", controller.signal).catch(error => error);
      await vi.waitFor(() => expect(entered).toBe(true));
      if (ending === "caller") controller.abort();
      else await owner.close();
      expect(await result).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(cancelled).toBe(true));
    } finally { controller.abort(); await owner.close(); }
  });

  it("finishes an already started restoration before accepting the next lease after cancellation", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "sup-"));
    temporaryDirectories.push(root);
    const primary = join(root, "s.sock");
    let released = false;
    let restored = false;
    let resume!: () => void;
    const recovery = new Promise<void>(resolve => { resume = resolve; });
    const owner = new AppServerSupervisorOwner(primary, {
      primaryProvider: "openai", managedProviders: [], socketPaths: [primary],
    }, {
      ensureProvider: async () => { expect(restored).toBe(true); },
      applyProviderSettings: async () => {
        released = true;
        await recovery;
        restored = true;
        return { applied: true, changed: true };
      },
    });
    const controller = new AbortController();
    let lease;
    try {
      await owner.start();
      const applying = applyAppServerProviderSettings(primary, "openai", controller.signal).catch(error => error);
      await vi.waitFor(() => expect(released).toBe(true));
      controller.abort();
      expect(await applying).toBeInstanceOf(Error);
      const acquiring = acquireAppServerProviderLease(primary, "openai");
      await vi.waitFor(async () => expect((await inspectAppServerSupervisor(primary))?.leasedProviders).toEqual(["openai"]));
      expect(restored).toBe(false);
      resume();
      lease = await acquiring;
      expect(restored).toBe(true);
    } finally { resume(); await lease?.close(); await owner.close(); }
  });
  unixIt("preserves a replaced public endpoint on close", async () => {
    const root = mkdtempSync("/tmp/sup-");
    temporaryDirectories.push(root);
    const primary = join(root, "s.sock");
    const path = appServerSupervisorSocketPath(primary);
    const owner = new AppServerSupervisorOwner(primary, {
      primaryProvider: "openai", managedProviders: [], socketPaths: [primary],
    });
    try {
      await owner.start();
      renameSync(path, join(root, "old.sock"));
      writeFileSync(path, "replacement", { mode: 0o600 });
      await owner.close();
      expect(readFileSync(path, "utf8")).toBe("replacement");
      await expect(owner.start()).rejects.toThrow("正在关闭");
    } finally { await owner.close(); }
  });

  it("retries an occupied endpoint after the previous owner closes", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "sup-"));
    temporaryDirectories.push(root);
    const primary = join(root, "s.sock");
    const topology = { primaryProvider: "openai", managedProviders: [], socketPaths: [primary] };
    const first = new AppServerSupervisorOwner(primary, topology);
    const second = new AppServerSupervisorOwner(primary, topology);
    try {
      await first.start();
      await expect(second.start()).rejects.toThrow("已在运行");
      await first.close();
      await second.start();
      await first.close();
      expect(await inspectAppServerSupervisor(primary)).toMatchObject({ primaryProvider: "openai" });
    } finally { await first.close(); await second.close(); }
  });

  it("waits for an in-flight Provider operation while closing the listener", async () => {
    const root = mkdtempSync(join(unixSocketTmpdir, "sup-"));
    temporaryDirectories.push(root);
    const primary = join(root, "s.sock");
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const owner = new AppServerSupervisorOwner(primary, {
      primaryProvider: "openai", managedProviders: [], socketPaths: [primary],
    }, { ensureProvider: async () => { started(); await pending; } });
    await owner.start();
    const request = ensureAppServerProvider(primary, "openai").catch(() => undefined);
    try {
      await entered;
      let closed = false;
      const closing = owner.close().then(() => { closed = true; });
      await request;
      expect(closed).toBe(false);
      finish();
      await closing;
      expect(closed).toBe(true);
      expect(existsSync(appServerSupervisorSocketPath(primary))).toBe(false);
    } finally { finish(); await owner.close(); await request; }
  });

  it("refuses an unsafe supervisor path before requesting a Provider", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-unsafe-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    writeFileSync(appServerSupervisorSocketPath(primarySocketPath), "not a socket", {
      mode: 0o600,
    });

    await expect(ensureAppServerProvider(primarySocketPath, "opencode-go"))
      .rejects.toThrow(/监管 Socket 路径不安全|Windows 私有 IPC 端点不安全/u);
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
      version: 5,
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

  unixIt("reports a supervisor protocol version mismatch with a restart hint", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-version-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const supervisorSocketPath = appServerSupervisorSocketPath(primarySocketPath);
    const server = createServer((socket) => {
      socket.once("data", (data) => {
        const settings = JSON.parse(data.toString()).action === "applyProviderSettings";
        socket.end(`${JSON.stringify({ version: settings ? 5 : 4, provider: "openai", ok: true })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(supervisorSocketPath, () => resolve()));
    chmodSync(supervisorSocketPath, 0o600);
    try {
      await expect(ensureAppServerProvider(primarySocketPath, "openai"))
        .rejects.toThrow("请运行 codexc restart all");
      await expect(applyAppServerProviderSettings(primarySocketPath, "openai"))
        .rejects.toThrow("请运行 codexc restart app-server");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  unixIt("reports a missing supervisor for the standalone App Server path", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-missing-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");

    await expect(inspectAppServerSupervisorState(primarySocketPath))
      .resolves.toEqual({ status: "missing" });
  });

  unixIt("rejects a supervisor socket path that exceeds the platform length limit", async () => {
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

  darwinIt("holds the primary Provider until the last Desktop Host lease detaches", async () => {
    const runtimeDir = mkdtempSync(join(unixSocketTmpdir, "codexc-supervisor-desktop-"));
    temporaryDirectories.push(runtimeDir);
    const primarySocketPath = join(runtimeDir, "codex-app-server.sock");
    const attached: Array<{ appPath: string; pipePath: string; toolsEnabled: boolean }> = [];
    const released: string[] = [];
    let reportDetached: (() => void) | undefined;
    const detached = new Promise<void>((resolve) => {
      reportDetached = resolve;
    });
    const owner = new AppServerSupervisorOwner(primarySocketPath, {
      primaryProvider: "openai",
      managedProviders: [],
      socketPaths: [primarySocketPath],
    }, {
      attachDesktopApp: async (attachment) => { attached.push(attachment); },
      detachDesktopApp: async () => { reportDetached?.(); },
      releaseProvider: async (provider) => {
        released.push(provider);
        return true;
      },
    });
    await owner.start();
    const lease = await acquireMacDesktopAppHostLease(primarySocketPath, {
      provider: "openai",
      appPath: "/Applications/ChatGPT.app",
      pipePath: "/tmp/codex-app-tools.sock",
      toolsEnabled: true,
    });

    try {
      expect(attached).toEqual([{
        appPath: "/Applications/ChatGPT.app",
        pipePath: "/tmp/codex-app-tools.sock",
        toolsEnabled: true,
      }]);
      await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
        desktopAppHostProtocolVersion: 1,
        desktopAppAttached: true,
        leasedProviders: ["openai"],
      });
      await expect(releaseAppServerProvider(primarySocketPath, "openai"))
        .resolves.toEqual({ released: false, reason: "leased" });
      expect(released).toEqual([]);

      await lease.close();
      await detached;
      await expect(inspectAppServerSupervisor(primarySocketPath)).resolves.toMatchObject({
        desktopAppAttached: false,
        leasedProviders: [],
      });
      await expect(releaseAppServerProvider(primarySocketPath, "openai"))
        .resolves.toEqual({ released: true, reason: "released" });
      expect(released).toEqual(["openai"]);
    } finally {
      await owner.close();
    }
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

  unixIt("closes promptly while a local client keeps its connection open", async () => {
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
