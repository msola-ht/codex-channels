import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopAppBridge,
  desktopAppBridgeTokenPath,
  loadOrCreateDesktopAppBridgeToken,
  startDesktopAppBridge,
} from "../runtime/desktop-app-bridge.mjs";

const token = "A".repeat(43);
const bridges: DesktopAppBridge[] = [];
const sockets: WebSocket[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.allSettled(bridges.splice(0).map((bridge) => bridge.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex Desktop App bridge", () => {
  it("creates and reuses a private bridge token", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "codexc-desktop-token-"));
    temporaryDirectories.push(dataDir);

    const first = loadOrCreateDesktopAppBridgeToken(dataDir);
    const second = loadOrCreateDesktopAppBridgeToken(dataDir);
    const path = desktopAppBridgeTokenPath(dataDir);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second).toBe(first);
    expect(readFileSync(path, "utf8")).toBe(first);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects non-OpenAI primary Providers before opening a listener", async () => {
    await expect(startDesktopAppBridge({
      port: await reservePort(),
      socketPath: "/private/app-server.sock",
      primaryProvider: "deepseek",
      codexBinary: "codex",
      dataDir: "/private/data",
      token,
      createTransport: () => new FakeTransport(),
      acquireLease: async () => ({ close: async () => undefined }),
    })).rejects.toThrow("只支持 OpenAI 主 Provider");
  });

  it("authenticates the exact path and token before opening an upstream connection", async () => {
    const port = await reservePort();
    let transports = 0;
    const bridge = new DesktopAppBridge({
      port,
      token,
      createTransport: () => {
        transports += 1;
        return new FakeTransport();
      },
      acquireLease: async () => ({ close: async () => undefined }),
    });
    bridges.push(bridge);
    await bridge.start();

    await expectRejected(`ws://127.0.0.1:${port}/codex-app-server`, 401);
    await expectRejected(`ws://127.0.0.1:${port}/wrong?token=${token}`, 401);
    await expectRejected(
      `ws://127.0.0.1:${port}/codex-app-server?token=${"B".repeat(43)}`,
      401,
    );
    await expectRejected(
      `ws://127.0.0.1:${port}/codex-app-server?token=${token}&extra=value`,
      401,
    );
    await expectRejected(
      `ws://127.0.0.1:${port}/codex-app-server?token=${token}`,
      400,
      ["unsupported-protocol"],
    );

    expect(transports).toBe(0);
  });

  it("forwards text frames in order and releases the upstream resources", async () => {
    const port = await reservePort();
    let transport: FakeTransport | undefined;
    let leaseCloses = 0;
    let releaseFirstSend: (() => void) | undefined;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const sendStages: string[] = [];
    const bridge = new DesktopAppBridge({
      port,
      token,
      createTransport: () => {
        transport = new FakeTransport(async (message) => {
          sendStages.push(`start:${message}`);
          if (message === "one") await firstSendGate;
          sendStages.push(`end:${message}`);
        });
        return transport;
      },
      acquireLease: async () => ({
        close: async () => { leaseCloses += 1; },
      }),
    });
    bridges.push(bridge);
    await bridge.start();
    const socket = await connectBridge(port);
    sockets.push(socket);

    socket.send("one");
    socket.send("two");
    await waitUntil(() => sendStages.length === 1);
    expect(sendStages).toEqual(["start:one"]);
    releaseFirstSend?.();
    await waitUntil(() => sendStages.length === 4);
    expect(sendStages).toEqual(["start:one", "end:one", "start:two", "end:two"]);

    const downstream = nextMessage(socket);
    transport?.emitMessage("reply");
    await expect(downstream).resolves.toBe("reply");

    socket.close();
    await waitUntil(() => leaseCloses === 1);
    expect(transport?.closed).toBe(true);
  });

  it("closes binary clients and refuses a fifth concurrent connection", async () => {
    const port = await reservePort();
    const bridge = new DesktopAppBridge({
      port,
      token,
      createTransport: () => new FakeTransport(),
      acquireLease: async () => ({ close: async () => undefined }),
    });
    bridges.push(bridge);
    await bridge.start();

    const binarySocket = await connectBridge(port);
    sockets.push(binarySocket);
    const binaryClose = nextClose(binarySocket);
    binarySocket.send(Buffer.from("binary"));
    await expect(binaryClose).resolves.toBe(1003);

    const active = await Promise.all(Array.from({ length: 4 }, () => connectBridge(port)));
    sockets.push(...active);
    await expectRejected(
      `ws://127.0.0.1:${port}/codex-app-server?token=${token}`,
      503,
    );
  });

  it("closes downstream, transport and lease when the bridge stops", async () => {
    const port = await reservePort();
    const transport = new FakeTransport();
    let leaseCloses = 0;
    const bridge = new DesktopAppBridge({
      port,
      token,
      createTransport: () => transport,
      acquireLease: async () => ({
        close: async () => { leaseCloses += 1; },
      }),
    });
    bridges.push(bridge);
    await bridge.start();
    const socket = await connectBridge(port);
    sockets.push(socket);
    const closed = nextClose(socket);

    await bridge.close();

    await expect(closed).resolves.toBe(1012);
    expect(transport.closed).toBe(true);
    expect(leaseCloses).toBe(1);
    expect(bridge.address()).toBeUndefined();
  });

  it("waits for and releases a lease that arrives during bridge shutdown", async () => {
    const port = await reservePort();
    let reportAcquireStarted: (() => void) | undefined;
    let releaseAcquire: ((lease: { close(): Promise<void> }) => void) | undefined;
    const acquireStarted = new Promise<void>((resolve) => {
      reportAcquireStarted = resolve;
    });
    const acquire = new Promise<{ close(): Promise<void> }>((resolve) => {
      releaseAcquire = resolve;
    });
    let leaseCloses = 0;
    const bridge = new DesktopAppBridge({
      port,
      token,
      createTransport: () => new FakeTransport(),
      acquireLease: () => {
        reportAcquireStarted?.();
        return acquire;
      },
    });
    bridges.push(bridge);
    await bridge.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/codex-app-server?token=${token}`,
    );
    sockets.push(socket);
    socket.once("error", () => undefined);
    await acquireStarted;

    const closing = bridge.close();
    releaseAcquire?.({
      close: async () => { leaseCloses += 1; },
    });
    await closing;

    expect(leaseCloses).toBe(1);
  });
});

class FakeTransport {
  readonly messageHandlers = new Set<(message: string) => void>();
  readonly closeHandlers = new Set<(error?: Error) => void>();
  closed = false;

  constructor(
    private readonly sendImplementation: (message: string) => Promise<void> = async () => undefined,
  ) {}

  async connect(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }

  send(message: string): Promise<void> {
    return this.sendImplementation(message);
  }

  onMessage(handler: (message: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emitMessage(message: string): void {
    for (const handler of this.messageHandlers) handler(message);
  }
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("测试无法取得回环端口");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function connectBridge(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/codex-app-server?token=${token}`,
      { perMessageDeflate: false },
    );
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function expectRejected(url: string, status: number, protocols?: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols);
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("WebSocket 不应建立连接"));
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode !== status) {
        reject(new Error(`预期 HTTP ${status}，实际 ${response.statusCode}`));
        return;
      }
      resolve();
    });
    socket.once("error", () => undefined);
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(data.toString("utf8")));
  });
}

function nextClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待测试条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
