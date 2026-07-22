import { createConnection } from "node:net";

import WebSocket, { type ClientOptions, type RawData } from "ws";

import { BaseTransport } from "./transport.js";

export class UnixWebSocketTransport extends BaseTransport {
  readonly kind = "unix-websocket" as const;
  private socket: WebSocket | undefined;

  constructor(private readonly socketPath: string) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const options: ClientOptions = {
      perMessageDeflate: false,
      createConnection: () => createConnection(this.socketPath),
    };
    const socket = new WebSocket("ws://localhost/", options);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        this.emitMessage(data.toString("utf8"));
      }
    });
    socket.on("error", (error) => this.emitClose(error));
    socket.on("close", () => this.emitClose());
  }

  async send(message: string): Promise<void> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Codex Unix WebSocket 尚未连接");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(message, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.close();
      setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) {
          socket.terminate();
        }
        resolve();
      }, 2_000).unref();
    });
  }
}
