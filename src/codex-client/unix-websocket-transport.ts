import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";

import WebSocket, { type ClientOptions, type RawData } from "ws";

import { BaseTransport } from "./transport.js";

export interface UnixWebSocketTransportOptions {
  connectTimeoutMs?: number;
  maxPayloadBytes?: number;
}

export class UnixWebSocketTransport extends BaseTransport {
  readonly kind = "unix-websocket" as const;
  private socket: WebSocket | undefined;

  private readonly connectTimeoutMs: number;
  private readonly maxPayloadBytes: number;

  constructor(
    private readonly socketPath: string,
    options: UnixWebSocketTransportOptions = {},
  ) {
    super();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 8 * 1024 * 1024;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    validateUnixSocket(this.socketPath);
    const options: ClientOptions = {
      perMessageDeflate: false,
      handshakeTimeout: this.connectTimeoutMs,
      maxPayload: this.maxPayloadBytes,
      // 与原生 `codex --remote` 一致，只发送标准 WebSocket Upgrade 头；
      // clientInfo 在 initialize 中标识本集成，不用 HTTP User-Agent 冒充 TUI。
      createConnection: () => createConnection(this.socketPath),
    };
    const socket = new WebSocket("ws://localhost/", options);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error(`连接 Codex Unix WebSocket 超时：${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      timeout.unref();
      const onOpen = (): void => {
        opened = true;
        clearTimeout(timeout);
        resolve();
      };
      const onError = (error: Error): void => {
        if (opened) {
          this.emitClose(error);
        } else {
          clearTimeout(timeout);
          reject(error);
        }
      };
      const onClose = (): void => {
        clearTimeout(timeout);
        if (opened) {
          this.emitClose();
        } else {
          reject(new Error("Codex Unix WebSocket 在握手完成前关闭"));
        }
      };
      socket.once("open", onOpen);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (!isBinary) {
          this.emitMessage(decodeTextMessage(data));
        }
      });
    });
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

function validateUnixSocket(socketPath: string): void {
  let parentStatus: ReturnType<typeof lstatSync>;
  let socketStatus: ReturnType<typeof lstatSync>;
  try {
    parentStatus = lstatSync(dirname(socketPath));
  } catch (error) {
    throw new Error("Codex Unix Socket 父目录不可用", { cause: error });
  }
  const currentUserId = process.getuid?.();
  if (
    !parentStatus.isDirectory()
    || (parentStatus.mode & 0o077) !== 0
    || (currentUserId !== undefined && parentStatus.uid !== currentUserId)
  ) {
    throw new Error("Codex Unix Socket 父目录权限不安全");
  }
  try {
    socketStatus = lstatSync(socketPath);
  } catch (error) {
    throw new Error("Codex Unix Socket 不可用", { cause: error });
  }
  if (
    !socketStatus.isSocket()
    || (currentUserId !== undefined && socketStatus.uid !== currentUserId)
  ) {
    throw new Error("Codex Unix Socket 必须是当前用户拥有的 Socket");
  }
}

export function decodeTextMessage(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
