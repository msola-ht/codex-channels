import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createHook } from "node:async_hooks";

import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DesktopAppBridge,
  proxyDesktopAppStdioToUnixSocket,
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
  it.skipIf(process.platform === "win32").each(["directory", "link"])(
    "rejects an unsafe macOS proxy socket %s before connecting", async scenario => {
      const directory = mkdtempSync("/tmp/cdsp-");
      temporaryDirectories.push(directory);
      const socketPath = join(directory, "a.sock");
      const server = createServer();
      let connections = 0;
      server.on("connection", socket => { connections++; socket.destroy(); });
      const physical = scenario === "link" ? join(directory, "other.sock") : socketPath;
      await new Promise<void>(resolve => server.listen(physical, resolve));
      if (scenario === "directory") chmodSync(directory, 0o755);
      else symlinkSync(physical, socketPath);
      try {
        await expect(proxyDesktopAppStdioToUnixSocket({ socketPath })).rejects.toThrow(
          scenario === "directory" ? "父目录权限不安全" : "链接目标",
        );
        expect(connections).toBe(0);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  );

  it("delivers messages arriving as the downstream sender becomes idle", async () => {
    const port = await reservePort();
    const transport = new FakeTransport();
    const bridge = new DesktopAppBridge({ port, token, createTransport: () => transport,
      acquireLease: async () => ({ close: async () => {} }) });
    bridges.push(bridge);
    await bridge.start();
    const socket = await connectBridge(port);
    sockets.push(socket);
    const received: string[] = [];
    socket.on("message", data => received.push(data.toString()));
    const send = WebSocket.prototype.send;
    const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data, ...args) {
      const callback = args.at(-1);
      if (typeof data !== "string" || !data.startsWith("first:") || typeof callback !== "function") {
        return Reflect.apply(send, this, [data, ...args]);
      }
      const depth = Number(data.slice("first:".length));
      return Reflect.apply(send, this, [data, ...args.slice(0, -1), (error?: Error) => {
        callback(error);
        let next = Promise.resolve();
        for (let step = 0; step < depth; step++) next = next.then(() => {});
        void next.then(() => transport.emitMessage(`second:${depth}`));
      }]);
    });
    try {
      for (let depth = 0; depth < 12; depth++) {
        transport.emitMessage(`first:${depth}`);
        await waitUntil(() => received.length === (depth + 1) * 2);
        expect(received.slice(-2)).toEqual([`first:${depth}`, `second:${depth}`]);
      }
    } finally { spy.mockRestore(); }
  });

  it("does not accumulate unresolved async waits over a long-lived connection", async () => {
    const port = await reservePort();
    const transport = new FakeTransport();
    const bridge = new DesktopAppBridge({ port, token, createTransport: () => transport,
      acquireLease: async () => ({ close: async () => {} }) });
    bridges.push(bridge);
    await bridge.start();
    const socket = await connectBridge(port);
    sockets.push(socket);
    const pending = new Set<number>();
    const hook = createHook({
      init: (id, type) => { if (type === "PROMISE") pending.add(id); },
      promiseResolve: id => { pending.delete(id); },
      destroy: id => { pending.delete(id); },
    });
    const sendBatch = async (count: number) => {
      for (let index = 0; index < count; index++) {
        const delivered = nextMessage(socket);
        transport.emitMessage("notification");
        await delivered;
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    hook.enable();
    try {
      await sendBatch(32);
      const baseline = pending.size;
      await sendBatch(256);
      // Allow fixed async test/transport overhead, but no growth per message.
      expect(pending.size).toBeLessThanOrEqual(baseline + 8);
    } finally { hook.disable(); }
  });

  it("bounds shutdown while still cleaning a lease that arrives after the deadline", async () => {
    const port = await reservePort();
    let release!: (lease: { close(): Promise<void> }) => void;
    let started = false;
    let closed = false;
    const lease = new Promise<{ close(): Promise<void> }>(resolve => { release = resolve; });
    const bridge = new DesktopAppBridge({ port, token, createTransport: () => new FakeTransport(),
      acquireLease: () => { started = true; return lease; } });
    await bridge.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/codex-app-server?token=${token}`);
    socket.on("error", () => {});
    sockets.push(socket);
    await waitUntil(() => started);
    try {
      await expect(bridge.close()).rejects.toThrow("关闭超时");
    } finally {
      release({ close: async () => { closed = true; } });
      await waitUntil(() => closed);
    }
  }, 8_000);

  it("reports lease cleanup failure while still closing the upstream transport", async () => {
    const port = await reservePort();
    const transport = new FakeTransport();
    const bridge = new DesktopAppBridge({ port, token, createTransport: () => transport,
      acquireLease: async () => ({ close: async () => { throw new Error("lease close failed"); } }) });
    await bridge.start();
    const socket = await connectBridge(port);
    sockets.push(socket);
    await expect(bridge.close()).rejects.toThrow("资源清理失败");
    expect(transport.closed).toBe(true);
  });

  it("bounds downstream bursts and releases the connection", async () => {
    const port = await reservePort();
    const transport = new FakeTransport();
    const bridge = new DesktopAppBridge({ port, token, createTransport: () => transport,
      acquireLease: async () => ({ close: async () => {} }) });
    bridges.push(bridge);
    await bridge.start();
    const socket = await connectBridge(port);
    sockets.push(socket);
    const closed = nextClose(socket);
    for (let index = 0; index < 130; index++) transport.emitMessage("queued");
    await expect(closed).resolves.toBe(1013);
    await bridge.close();
    expect(transport.closed).toBe(true);
  });

  it.skipIf(process.platform === "win32").each(["input-error", "output-error", "blocked-output"])(
    "cleans up the macOS stdio proxy on %s", async scenario => {
      const directory = mkdtempSync("/tmp/cdsp-");
      temporaryDirectories.push(directory);
      const socketPath = join(directory, "a.sock");
      const server = createHttpServer();
      const webSocketServer = new WebSocketServer({ noServer: true });
      server.on("upgrade", (request, socket, head) => {
        webSocketServer.handleUpgrade(request, socket, head, ws => webSocketServer.emit("connection", ws));
      });
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      const input = new PassThrough();
      const output = new Writable({ write(_chunk, _encoding, callback) {
        if (scenario !== "blocked-output") callback();
      } });
      const connected = new Promise<WebSocket>(resolve => webSocketServer.once("connection", resolve));
      const proxy = proxyDesktopAppStdioToUnixSocket({ socketPath, input, output });
      const outcome = expect(proxy).rejects.toThrow(scenario === "blocked-output" ? "超时" : "fixture stream failure");
      const upstream = await connected;
      try {
        // Wait for the client-side handshake before injecting stream failures.
        input.write('{}\n');
        await new Promise<void>(resolve => upstream.once("message", () => resolve()));
        if (scenario === "blocked-output") {
          upstream.send('{"result":true}');
          upstream.close();
        } else (scenario === "input-error" ? input : output).emit("error", new Error("fixture stream failure"));
        await outcome;
        expect(input.listenerCount("data")).toBe(0);
        expect(output.listenerCount("error")).toBe(0);
      } finally {
        upstream.terminate();
        input.destroy();
        output.destroy();
        await new Promise<void>(resolve => webSocketServer.close(() => resolve()));
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 8_000,
  );

  it("closes an overloaded connection and releases its lease without waiting for a stuck send", async () => {
    const port = await reservePort();
    let sends = 0;
    const transport = new FakeTransport(async () => { sends++; await new Promise<void>(() => {}); });
    let leaseCloses = 0;
    const bridge = new DesktopAppBridge({ port, token, createTransport: () => transport,
      acquireLease: async () => ({ close: async () => { leaseCloses++; } }) });
    bridges.push(bridge);
    await bridge.start();
    const socket = await connectBridge(port);
    sockets.push(socket);
    const closed = nextClose(socket);
    for (let index = 0; index < 130; index++) socket.send("queued");
    await expect(closed).resolves.toBe(1013);
    await bridge.close();
    expect(transport.closed).toBe(true);
    expect(leaseCloses).toBe(1);
    expect(sends).toBeLessThanOrEqual(1);
  });

  it("closes when an upstream send never completes", async () => {
    const port = await reservePort();
    const transport = new FakeTransport(async () => { await new Promise<void>(() => {}); });
    const bridge = new DesktopAppBridge({ port, token, createTransport: () => transport,
      acquireLease: async () => ({ close: async () => {} }) });
    bridges.push(bridge);
    await bridge.start();
    const socket = await connectBridge(port);
    sockets.push(socket);
    const closed = nextClose(socket);
    socket.send("blocked");
    await expect(closed).resolves.toBe(1013);
    await bridge.close();
    expect(transport.closed).toBe(true);
  }, 8_000);

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

  it.skipIf(process.platform === "win32")(
    "translates Desktop JSONL stdio to Unix WebSocket text frames",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "codexc-desktop-stdio-"));
      temporaryDirectories.push(directory);
      const socketPath = join(directory, "app-server.sock");
      const server = createHttpServer();
      const webSocketServer = new WebSocketServer({ noServer: true });
      server.on("upgrade", (request, socket, head) => {
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit("connection", webSocket, request);
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      const input = new PassThrough();
      const output = new PassThrough();
      output.setEncoding("utf8");
      let outputText = "";
      output.on("data", (chunk: string) => { outputText += chunk; });
      const received: string[] = [];
      webSocketServer.on("connection", (socket) => {
        socket.on("message", (data, isBinary) => {
          expect(isBinary).toBe(false);
          received.push(data.toString("utf8"));
          socket.send('{"id":1,"result":{"ready":true}}');
        });
      });

      const proxy = proxyDesktopAppStdioToUnixSocket({ socketPath, input, output });
      input.write('{"id":1,"method":"initialize","params":{}}\n');
      await waitUntil(() => outputText.endsWith("\n"));
      expect(received).toEqual(['{"id":1,"method":"initialize","params":{}}']);
      expect(outputText).toBe('{"id":1,"result":{"ready":true}}\n');

      input.end();
      await proxy;
      webSocketServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  );
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
