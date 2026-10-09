import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import type {
  CreateCodexProcessInvocation,
  TerminateCodexProcess,
} from "./codex-process.js";
import { BaseTransport } from "./transport.js";

export interface StdioTransportOptions {
  createCodexProcessInvocation: CreateCodexProcessInvocation;
  terminateCodexProcess: TerminateCodexProcess;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  onStderr?: (text: string) => void;
}

export class StdioTransport extends BaseTransport {
  readonly kind = "stdio" as const;
  private process: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private closeTask: Promise<void> | undefined;
  private closing = false;

  constructor(private readonly options: StdioTransportOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.closeTask) await this.closeTask;
    if (this.closing && this.process) await this.close();
    if (this.process) {
      return;
    }
    this.closing = false;
    const args = ["app-server", "--stdio"];
    const invocation = this.options.createCodexProcessInvocation(args);
    const child = spawn(invocation.file, invocation.args, {
      cwd: this.options.cwd,
      env: this.options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: process.platform === "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    this.process = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => { if (this.process === child) this.emitMessage(line); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.options.onStderr?.(chunk));
    child.on("error", (error) => {
      if (this.process !== child) return;
      if (child.pid === undefined) {
        this.process = undefined;
        this.lines?.close();
        this.lines = undefined;
      }
      if (!this.closing) this.emitClose(error);
    });
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.lines?.close();
      this.lines = undefined;
      if (!this.closing) this.emitClose(new Error(`Codex App Server 已退出：code=${code} signal=${signal}`));
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async send(message: string): Promise<void> {
    const child = this.process;
    if (this.closing || !child || child.stdin.destroyed) {
      throw new Error("Codex stdio Transport 尚未连接");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${message}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    const task = Promise.resolve().then(() => this.closeProcess());
    this.closeTask = task;
    try {
      await task;
    } finally {
      if (this.closeTask === task) this.closeTask = undefined;
    }
  }

  private async closeProcess(): Promise<void> {
    this.lines?.close();
    this.lines = undefined;
    const child = this.process;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      await this.options.terminateCodexProcess(child);
    }
    if (this.process === child) this.process = undefined;
  }
}
