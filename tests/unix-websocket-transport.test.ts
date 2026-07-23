import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  UnixWebSocketTransport,
  unixWebSocketHandshakeSummary,
} from "../src/codex-client/unix-websocket-transport.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("UnixWebSocketTransport", () => {
  it("matches the native remote handshake without custom identity or auth headers", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-ws-"));
    temporaryDirectories.push(root);
    const socketPath = join(root, "app.sock");
    const server = createServer();
    const webSocketServer = new WebSocketServer({ server });
    let headers: Record<string, string | string[] | undefined> | undefined;
    webSocketServer.on("connection", (_socket, request) => {
      headers = request.headers;
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });

    const transport = new UnixWebSocketTransport(socketPath);
    try {
      await transport.connect();
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
      expect(unixWebSocketHandshakeSummary).toEqual({
        userAgent: null,
        requestHeaders: [
          "Host=localhost",
          "Connection=Upgrade",
          "Upgrade=websocket",
          "Sec-WebSocket-Version=13",
          "Sec-WebSocket-Key=动态值（不展示）",
        ],
        omittedHeaders: ["User-Agent", "Origin", "Authorization", "Cookie"],
      });
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
