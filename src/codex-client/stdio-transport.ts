import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import type {
  CreateCodexProcessInvocation,
  TerminateCodexProcess,
} from "./codex-process.js";
import { BaseTransport } from "./transport.js";

export interface StdioTransportOptions {
  codexBinary: string;
  createCodexProcessInvocation?: CreateCodexProcessInvocation;
  terminateCodexProcess?: TerminateCodexProcess;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
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
    const args = ["app-server", "--stdio"];
    const invocation = this.options.createCodexProcessInvocation?.(args) ?? {
      file: this.options.codexBinary,
      args,
      windowsVerbatimArguments: false,
    };
    const child = spawn(invocation.file, invocation.args, {
      cwd: this.options.cwd,
      env: this.options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: process.platform === "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
    if (this.options.terminateCodexProcess) {
      await this.options.terminateCodexProcess(child);
      return;
    }
    child.kill("SIGTERM");
    await waitForExit(child, 5_000);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, 1_000);
    }
  }
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, timeoutMs);
    timeout.unref();
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}
