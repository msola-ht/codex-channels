import { createServer } from "node:http";
import { resolve } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { WebSocketServer } from "ws";

const officialRemoteMaxPayloadBytes = 128 * 1024 * 1024;
const options = parseOptions(process.argv.slice(2));

async function runProbe() {
  if (process.platform !== "win32") {
    throw new Error("Windows Proxy 入站上限探针只支持 Windows");
  }
  const modulePath = resolve("dist/codex-client/index.js");
  const { WindowsProxyTransport } = await import(pathToFileURL(modulePath));
  const accepted = await runBoundary(
    WindowsProxyTransport,
    options.acceptedBytes,
    "accepted",
  );
  const rejected = await runBoundary(
    WindowsProxyTransport,
    options.rejectedBytes,
    "rejected",
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    transport: "windows-uds-proxy",
    scenario: "inbound-message-limit",
    acceptedBytes: accepted.bytes,
    rejectedBytes: rejected.bytes,
    rejection: rejected.error === null ? "websocket-close" : "max-payload-error",
  }, null, 2)}\n`);
}

async function runBoundary(WindowsProxyTransport, bytes, expected) {
  const scriptPath = fileURLToPath(import.meta.url);
  const transport = new WindowsProxyTransport("fixture.sock", {
    codexBinary: process.execPath,
    connectTimeoutMs: options.timeoutMs,
    maxPayloadBytes: options.acceptedBytes,
    createCodexProcessInvocation: () => ({
      file: process.execPath,
      args: [scriptPath, "--fixture-child", "--bytes", String(bytes)],
      windowsVerbatimArguments: false,
    }),
  });
  let removeMessage = () => undefined;
  let removeClose = () => undefined;
  try {
    const outcome = new Promise((resolveOutcome, rejectOutcome) => {
      const timeout = setTimeout(() => {
        rejectOutcome(new Error(`${bytes} 字节入站消息在期限内没有结果`));
      }, options.timeoutMs);
      const finish = (result) => {
        clearTimeout(timeout);
        removeMessage();
        removeClose();
        resolveOutcome(result);
      };
      removeMessage = transport.onMessage((message) => {
        finish({
          kind: "message",
          bytes: Buffer.byteLength(message, "utf8"),
          validEdges: message.charCodeAt(0) === 0x78
            && message.charCodeAt(message.length - 1) === 0x78,
        });
      });
      removeClose = transport.onClose((error) => {
        finish({ kind: "close", error: error?.message ?? null });
      });
    });
    await transport.connect();
    await transport.send("inbound-limit-probe");
    const result = await outcome;
    if (expected === "accepted") {
      if (result.kind !== "message" || result.bytes !== bytes || !result.validEdges) {
        throw new Error(`${bytes} 字节入站消息未被完整接收`);
      }
      return { bytes: result.bytes, error: null };
    }
    if (result.kind !== "close") {
      throw new Error(`${bytes} 字节入站消息未被拒绝`);
    }
    return { bytes, error: result.error };
  } finally {
    removeMessage();
    removeClose();
    await transport.close();
  }
}

async function runFixtureChild(bytes) {
  const server = createServer();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1024,
  });
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    server.once("clientError", rejectCompletion);
    process.stdin.once("end", resolveCompletion);
    server.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.once("connection", (webSocket) => {
      webSocket.once("message", () => {
        const payload = Buffer.alloc(bytes, 0x78);
        webSocket.send(payload, { binary: false, compress: false }, (error) => {
          if (error) rejectCompletion(error);
        });
      });
      webSocket.once("close", resolveCompletion);
      webSocket.once("error", rejectCompletion);
    });
  });
  server.emit("connection", new StdioSocket());
  await completion;
}

class StdioSocket extends Duplex {
  constructor() {
    super();
    process.stdin.on("data", (chunk) => {
      if (!this.push(chunk)) process.stdin.pause();
    });
    process.stdin.once("end", () => this.push(null));
    process.stdin.once("error", (error) => this.destroy(error));
  }

  _read() {
    process.stdin.resume();
  }

  _write(chunk, encoding, callback) {
    process.stdout.write(chunk, encoding, callback);
  }

  _final(callback) {
    process.stdout.end(callback);
  }

  _destroy(error, callback) {
    process.stdin.destroy();
    process.stdout.destroy();
    callback(error);
  }

  setTimeout(_timeout, callback) {
    if (callback) this.once("timeout", callback);
    return this;
  }

  setNoDelay() {
    return this;
  }

  setKeepAlive() {
    return this;
  }
}

function parseOptions(args) {
  const values = new Map();
  let fixtureChild = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--fixture-child") {
      fixtureChild = true;
      continue;
    }
    if (!["--bytes", "--accepted-bytes", "--rejected-bytes", "--timeout-ms"].includes(name)) {
      throw new Error("用法：node scripts/windows-proxy-inbound-limit-probe.mjs [--accepted-bytes <字节>] [--rejected-bytes <字节>] [--timeout-ms <毫秒>]");
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${name} 缺少值`);
    values.set(name, parsePositiveInteger(value, name));
    index += 1;
  }
  const acceptedBytes = values.get("--accepted-bytes") ?? officialRemoteMaxPayloadBytes;
  const rejectedBytes = values.get("--rejected-bytes") ?? officialRemoteMaxPayloadBytes + 1;
  const fixtureBytes = values.get("--bytes") ?? 0;
  const timeoutMs = values.get("--timeout-ms") ?? 30_000;
  if (fixtureChild) {
    if (fixtureBytes < 1 || values.size !== 1) {
      throw new Error("内部夹具只接受 --fixture-child --bytes <字节>");
    }
  } else if (
    values.has("--bytes")
    || acceptedBytes !== officialRemoteMaxPayloadBytes
    || rejectedBytes !== officialRemoteMaxPayloadBytes + 1
  ) {
    if (
      acceptedBytes < 1024
      || rejectedBytes <= acceptedBytes
      || rejectedBytes > officialRemoteMaxPayloadBytes + 1
    ) {
      throw new Error("消息边界必须满足 1024 <= --accepted-bytes < --rejected-bytes <= 128 MiB + 1");
    }
  }
  return { fixtureChild, fixtureBytes, acceptedBytes, rejectedBytes, timeoutMs };
}

function parsePositiveInteger(value, name) {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} 必须是正整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是 JavaScript 安全范围内的正整数`);
  }
  return parsed;
}

if (options.fixtureChild) {
  await runFixtureChild(options.fixtureBytes);
} else {
  await runProbe();
}
