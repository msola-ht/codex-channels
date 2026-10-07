import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Attachment = { appPath: string; pipePath: string; toolsEnabled: boolean };
type ServiceOperations = {
  ensureProvider(provider: string): Promise<void>;
  releaseProvider(provider: string): Promise<boolean>;
  attachDesktopApp(attachment: Attachment, signal: AbortSignal, canAttach: () => boolean): Promise<void>;
};

const serviceMocks = vi.hoisted(() => ({
  socketReady: vi.fn(),
  spawn: vi.fn(),
  hostedSpawn: vi.fn(),
  validateAttachment: vi.fn(),
  terminate: vi.fn(),
  countActive: vi.fn(),
  connect: vi.fn(),
  closeClient: vi.fn(),
  closeOwner: vi.fn(),
  operations: undefined as ServiceOperations | undefined,
}));

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: serviceMocks.spawn,
}));
vi.mock("../runtime/app-server-supervisor.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../runtime/app-server-supervisor.mjs")>(),
  appServerSocketAcceptsWebSocket: serviceMocks.socketReady,
  prepareAppServerSocketPaths: async () => undefined,
  AppServerSupervisorOwner: class {
    constructor(_socket: string, _topology: unknown, operations: ServiceOperations) {
      serviceMocks.operations = operations;
    }
    async start() {}
    close = serviceMocks.closeOwner;
    markRunning() {}
    markReleased() {}
  },
}));
vi.mock("../runtime/desktop-app-host.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../runtime/desktop-app-host.mjs")>(),
  validateMacDesktopAppAttachment: serviceMocks.validateAttachment,
  spawnMacDesktopHostedCodex: serviceMocks.hostedSpawn,
}));
vi.mock("../runtime/process-lifecycle.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../runtime/process-lifecycle.mjs")>(),
  terminateChildProcess: serviceMocks.terminate,
  installProcessSignalHandlers: () => () => undefined,
  signalChildProcesses: () => undefined,
}));
vi.mock("../runtime/network-proxy.mjs", async importOriginal => ({
  ...await importOriginal<typeof import("../runtime/network-proxy.mjs")>(),
  createRefreshableHttpProxySelector: () => ({
    validate: async () => undefined,
    close: async () => undefined,
  }),
}));
vi.mock("../dist/provider-proxy/index.js", () => ({
  ProviderProxy: class {
    async start() {}
    async close() {}
    address() { return "127.0.0.1:12345"; }
  },
  ChatCompletionsBridge: class {},
  pruneModelTrafficDumpSessions: () => undefined,
  sendProviderProxyMetrics: () => undefined,
}));
vi.mock("../dist/codex-client/index.js", () => ({
  createAppServerTransport: () => ({}),
  JsonRpcClient: class {},
  CodexAppServerClient: class {
    connect = serviceMocks.connect;
    close = serviceMocks.closeClient;
    countActiveLoadedThreads = serviceMocks.countActive;
  },
}));

// @ts-expect-error JavaScript service runtime intentionally has no declaration file.
import { applyAppServerTimezone, runAppServerService } from "../runtime/app-server-service-runtime.mjs";

class TestChild extends EventEmitter {
  pid = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

const attachment: Attachment = {
  appPath: "/Applications/Codex.app",
  pipePath: "/tmp/desktop-contract-pipe",
  toolsEnabled: true,
};
let testRoot: string | undefined;
let liveChildren: Set<TestChild>;
let foreignSocket = false;
let platform: PropertyDescriptor | undefined;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  liveChildren = new Set();
  foreignSocket = false;
  previousExitCode = process.exitCode;
  serviceMocks.operations = undefined;
  serviceMocks.socketReady.mockImplementation(async () => foreignSocket || liveChildren.size > 0);
  const spawnChild = () => {
    const child = new TestChild();
    liveChildren.add(child);
    return child;
  };
  serviceMocks.spawn.mockImplementation(spawnChild);
  serviceMocks.hostedSpawn.mockImplementation(spawnChild);
  serviceMocks.validateAttachment.mockImplementation(value => ({ ...value, key: "desktop-attachment" }));
  serviceMocks.terminate.mockImplementation(async (child: TestChild) => {
    liveChildren.delete(child);
    child.exitCode = 0;
    child.emit("exit", 0, null);
  });
  serviceMocks.countActive.mockResolvedValue(0);
  serviceMocks.connect.mockResolvedValue(undefined);
  serviceMocks.closeClient.mockResolvedValue(undefined);
  serviceMocks.closeOwner.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (serviceMocks.operations) {
    process.emit("message", { type: "codexc-stop" }, undefined);
    await vi.waitFor(() => expect(liveChildren.size).toBe(0));
    await vi.waitFor(() => expect(serviceMocks.closeOwner).toHaveBeenCalled());
  }
  process.exitCode = previousExitCode;
  if (platform) Object.defineProperty(process, "platform", platform);
  platform = undefined;
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

async function startDesktopService(): Promise<ServiceOperations> {
  platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  testRoot = mkdtempSync(join(tmpdir(), "app-host-runtime-"));
  const codexHome = join(testRoot, "codex-home");
  mkdirSync(codexHome, { mode: 0o700 });
  writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', { mode: 0o600 });
  await runAppServerService({
    document: {
      codex: {
        binary: process.execPath,
        socket_path: join(testRoot, "app.sock"),
        sandbox: "read-only",
        desktop_app: { enabled: true, port: 49204 },
      },
    },
    environment: {
      CODEX_BINARY: process.execPath,
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: join(testRoot, "connect-home"),
      PATH: process.env.PATH,
    },
    dataDir: testRoot,
  }, () => ({ cwd: testRoot }));
  return serviceMocks.operations!;
}

describe("App Server service runtime", () => {
  it("only sets the process timezone when it is configured", () => {
    const inherited = { TZ: "Asia/Shanghai", PATH: "/usr/bin" };
    applyAppServerTimezone(inherited, undefined);
    expect(inherited).toEqual({ TZ: "Asia/Shanghai", PATH: "/usr/bin" });

    applyAppServerTimezone(inherited, "America/Los_Angeles");
    expect(inherited.TZ).toBe("America/Los_Angeles");
  });

  it("rejects enabled Desktop App sharing on unsupported platforms before startup", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      ...platform,
      value: "linux",
    });
    try {
      await expect(runAppServerService({
        document: {
          codex: {
            desktop_app: { enabled: true, port: 49_204 },
          },
        },
        environment: {},
        dataDir: "/tmp/codexc-unsupported-desktop-app",
      }, () => {
        throw new Error("不应继续解析默认 Workspace");
      })).rejects.toThrow("Codex Desktop App 共享当前只支持 macOS 与 Windows");
    } finally {
      Object.defineProperty(process, "platform", platform ?? {
        value: process.platform,
        configurable: true,
      });
    }
  });

  it("restores an idle-released managed instance before checking and attaching the Host", async () => {
    const operations = await startDesktopService();
    await expect(operations.releaseProvider("openai")).resolves.toBe(true);
    const controller = new AbortController();
    await operations.attachDesktopApp(attachment, controller.signal, () => true);

    expect(serviceMocks.spawn).toHaveBeenCalledTimes(2);
    expect(serviceMocks.countActive).toHaveBeenCalledOnce();
    expect(serviceMocks.hostedSpawn).toHaveBeenCalledOnce();
    expect(liveChildren.size).toBe(1);
  });

  it("refuses a live socket outside the service after an idle release", async () => {
    const operations = await startDesktopService();
    await operations.releaseProvider("openai");
    foreignSocket = true;
    serviceMocks.terminate.mockClear();
    await expect(operations.attachDesktopApp(attachment, new AbortController().signal, () => true))
      .rejects.toThrow("不受当前服务监管");
    expect(serviceMocks.spawn).toHaveBeenCalledTimes(1);
    expect(serviceMocks.hostedSpawn).not.toHaveBeenCalled();
    expect(serviceMocks.terminate).not.toHaveBeenCalled();
  });

  it.each(["active", "read-failure", "new-lease", "cancelled"])(
    "preserves the managed instance when the Host check encounters %s",
    async failure => {
      const operations = await startDesktopService();
      const controller = new AbortController();
      let available = true;
      serviceMocks.countActive.mockImplementation(async () => {
        if (failure === "active") return 1;
        if (failure === "read-failure") throw new Error("权威读取失败");
        if (failure === "new-lease") available = false;
        if (failure === "cancelled") controller.abort(new Error("调用方断开"));
        return 0;
      });
      await expect(operations.attachDesktopApp(attachment, controller.signal, () => available))
        .rejects.toThrow();
      expect(serviceMocks.terminate).not.toHaveBeenCalled();
      expect(serviceMocks.hostedSpawn).not.toHaveBeenCalled();
      expect(liveChildren.size).toBe(1);
      expect(serviceMocks.closeClient).toHaveBeenCalled();
    },
  );

  it("restores the previous launch mode if Host startup fails", async () => {
    const operations = await startDesktopService();
    serviceMocks.hostedSpawn.mockImplementation(() => { throw new Error("Host 启动失败"); });
    await expect(operations.attachDesktopApp(attachment, new AbortController().signal, () => true))
      .rejects.toThrow("Host 启动失败");
    expect(serviceMocks.spawn).toHaveBeenCalledTimes(2);
    expect(liveChildren.size).toBe(1);
  });

  it("finishes Host restoration when the requester disconnects after release begins", async () => {
    const operations = await startDesktopService();
    const controller = new AbortController();
    const terminate = serviceMocks.terminate.getMockImplementation()!;
    serviceMocks.terminate.mockImplementationOnce(async child => {
      controller.abort(new Error("调用方断开"));
      await terminate(child);
    });
    await operations.attachDesktopApp(attachment, controller.signal, () => true);
    expect(serviceMocks.hostedSpawn).toHaveBeenCalledOnce();
    expect(liveChildren.size).toBe(1);
  });

  it("reports both Host startup and previous-mode recovery failures", async () => {
    const operations = await startDesktopService();
    serviceMocks.hostedSpawn.mockImplementation(() => { throw new Error("Host 启动失败"); });
    serviceMocks.spawn.mockImplementation(() => { throw new Error("普通实例恢复失败"); });
    await expect(operations.attachDesktopApp(attachment, new AbortController().signal, () => true))
      .rejects.toThrow("Desktop Host 附加失败，且主 App Server 未能恢复");
    expect(liveChildren.size).toBe(0);
  });
});
