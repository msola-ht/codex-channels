import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { BaseTransport } from "./transport.js";

export interface StdioTransportOptions {
  codexBinary: string;
  cwd: string;
  onStderr?: (text: string) => void;
}

export class StdioTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  private process: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;

  constructor(private readonly options: StdioTransportOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.process) {
      return;
    }
    const child = spawn(this.options.codexBinary, ["app-server", "--stdio"], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.emitMessage(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.options.onStderr?.(chunk));
    child.on("error", (error) => this.emitClose(error));
    child.on("exit", (code, signal) => {
      this.emitClose(new Error(`Codex App Server 已退出：code=${code} signal=${signal}`));
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async send(message: string): Promise<void> {
    const child = this.process;
    if (!child || child.stdin.destroyed) {
      throw new Error("Codex stdio Transport 尚未连接");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${message}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.lines?.close();
    this.lines = undefined;
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 5_000).unref();
      }),
    ]);
  }
}
