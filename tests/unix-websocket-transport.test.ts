import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  decodeTextMessage,
  UnixWebSocketTransport,
} from "../src/codex-client/unix-websocket-transport.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("UnixWebSocketTransport", () => {
  it("decodes every WebSocket text payload representation", () => {
    const text = "消息 text";
    const bytes = Buffer.from(text);

    expect(decodeTextMessage(bytes)).toBe(text);
    expect(decodeTextMessage([
      bytes.subarray(0, 1),
      bytes.subarray(1),
    ])).toBe(text);
    expect(decodeTextMessage(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    )).toBe(text);
  });

  it("matches the native remote handshake without custom identity or auth headers", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-ws-"));
    temporaryDirectories.push(root);
    const socketPath = join(root, "app.sock");
    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    let headers: Record<string, string | string[] | undefined> | undefined;
    let sendText: (() => void) | undefined;
    webSocketServer.on("connection", (socket, request) => {
      headers = request.headers;
      sendText = () => socket.send("server message");
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });

    const transport = new UnixWebSocketTransport(socketPath);
    try {
      const received = new Promise<string>((resolve) => {
        transport.onMessage(resolve);
      });
      await transport.connect();
      sendText?.();
      await expect(received).resolves.toBe("server message");
      expect(headers).toMatchObject({
        host: "localhost",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
      });
      expect(headers).not.toHaveProperty("user-agent");
      expect(headers).not.toHaveProperty("origin");
      expect(headers).not.toHaveProperty("authorization");
      expect(headers).not.toHaveProperty("cookie");
      expect(headers?.["sec-websocket-key"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    } finally {
      await transport.close();
      for (const client of webSocketServer.clients) {
        client.terminate();
      }
      await new Promise<void>((resolveClose) => webSocketServer.close(() => resolveClose()));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
