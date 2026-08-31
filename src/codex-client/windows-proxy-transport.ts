import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { Duplex, type Readable, type Writable } from "node:stream";

import WebSocket, { type ClientOptions, type RawData } from "ws";

import type {
  CreateCodexProcessInvocation,
  TerminateCodexProcess,
} from "./codex-process.js";
import { BaseTransport } from "./transport.js";
import { decodeTextMessage } from "./unix-websocket-transport.js";

const officialRemoteMaxPayloadBytes = 128 * 1024 * 1024;

export interface WindowsProxyTransportOptions {
  codexBinary: string;
  createCodexProcessInvocation?: CreateCodexProcessInvocation;
  terminateCodexProcess?: TerminateCodexProcess;
  connectTimeoutMs?: number;
  maxPayloadBytes?: number;
}

export class WindowsProxyTransport extends BaseTransport {
  readonly kind = "windows-uds-proxy" as const;
  private process: ChildProcessWithoutNullStreams | undefined;
  private socket: WebSocket | undefined;
  private connection: ProxyDuplex | undefined;
  private connectTask: Promise<void> | undefined;
  private closing = false;

  private readonly connectTimeoutMs: number;
  private readonly maxPayloadBytes: number;

  constructor(
    private readonly socketPath: string,
    private readonly options: WindowsProxyTransportOptions,
  ) {
    super();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.maxPayloadBytes = options.maxPayloadBytes ?? officialRemoteMaxPayloadBytes;
  }

  async connect(): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("Windows Proxy Transport 只支持 Windows");
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectTask) {
      return this.connectTask;
    }
    this.closing = false;
    const task = this.open();
    this.connectTask = task;
    try {
      await task;
    } finally {
      if (this.connectTask === task) {
        this.connectTask = undefined;
      }
    }
  }

  async send(message: string): Promise<void> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Codex Windows Proxy Transport 尚未连接");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(message, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    this.socket = undefined;
    const connection = this.connection;
    this.connection = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 2_000);
        timeout.unref();
        socket.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.close();
      });
    }
    connection?.destroy();
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null) {
      return;
    }
    child.stdin.end();
    const exited = await waitForExit(child, 2_000);
    if (!exited && child.exitCode === null) {
      await this.terminate(child);
    }
  }

  private async open(): Promise<void> {
    const args = ["app-server", "proxy", "--sock", this.socketPath];
    const invocation = this.options.createCodexProcessInvocation?.(args) ?? {
      file: this.options.codexBinary,
      args,
      windowsVerbatimArguments: false,
    };
    const child = spawn(
      invocation.file,
      invocation.args,
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
    );
    this.process = child;
    child.stderr.resume();
    const connection = new ProxyDuplex(child.stdout, child.stdin);
    this.connection = connection;
    const webSocketOptions: ClientOptions = {
      perMessageDeflate: false,
      handshakeTimeout: this.connectTimeoutMs,
      maxPayload: this.maxPayloadBytes,
      createConnection: (() => connection) as unknown as NonNullable<
        ClientOptions["createConnection"]
      >,
    };
    const socket = new WebSocket("ws://localhost/", webSocketOptions);
    this.socket = socket;

    let opened = false;
    let closeEmitted = false;
    const emitUnexpectedClose = (error?: Error): void => {
      if (closeEmitted || this.closing) return;
      closeEmitted = true;
      this.emitClose(error);
    };
    child.once("error", (error) => {
      if (!opened) return;
      emitUnexpectedClose(error);
      socket.terminate();
    });
    child.once("exit", (code, signal) => {
      if (this.process === child) {
        this.process = undefined;
      }
      if (!opened) return;
      emitUnexpectedClose(
        new Error(`Codex App Server Proxy 已退出：code=${code} signal=${signal}`),
      );
      socket.terminate();
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) {
        this.emitMessage(decodeTextMessage(data));
      }
    });
    socket.on("error", (error) => {
      if (opened) {
        emitUnexpectedClose(error);
      }
    });
    socket.on("close", () => {
      if (opened) {
        emitUnexpectedClose();
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          opened = true;
          cleanup();
          resolve();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error("Codex Windows Proxy 在握手完成前关闭"));
        };
        const onChildError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onChildExit = (): void => {
          cleanup();
          reject(new Error("Codex Windows Proxy 在握手完成前退出"));
        };
        const cleanup = (): void => {
          socket.off("open", onOpen);
          socket.off("error", onError);
          socket.off("close", onClose);
          child.off("error", onChildError);
          child.off("exit", onChildExit);
        };
        socket.once("open", onOpen);
        socket.once("error", onError);
        socket.once("close", onClose);
        child.once("error", onChildError);
        child.once("exit", onChildExit);
      });
    } catch (error) {
      socket.terminate();
      connection.destroy();
      if (child.exitCode === null) {
        await this.terminate(child, { gracePeriodMs: 0, forcePeriodMs: 2_000 });
      }
      if (this.socket === socket) this.socket = undefined;
      if (this.connection === connection) this.connection = undefined;
      if (this.process === child) this.process = undefined;
      throw error;
    }
  }

  private async terminate(
    child: ChildProcessWithoutNullStreams,
    options?: { gracePeriodMs?: number; forcePeriodMs?: number },
  ): Promise<void> {
    if (this.options.terminateCodexProcess) {
      await this.options.terminateCodexProcess(child, options);
      return;
    }
    child.kill("SIGKILL");
    await waitForExit(child, options?.forcePeriodMs ?? 2_000);
  }
}

class ProxyDuplex extends Duplex {
  constructor(
    private readonly source: Readable,
    private readonly sink: Writable,
  ) {
    super();
    source.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) {
        source.pause();
      }
    });
    source.once("end", () => this.push(null));
    source.once("error", (error) => this.destroy(error));
    sink.once("error", (error) => this.destroy(error));
  }

  override _read(): void {
    this.source.resume();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.sink.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.sink.end(callback);
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.source.destroy();
    this.sink.destroy();
    callback(error);
  }

  setTimeout(_timeout: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timeout.unref();
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}
