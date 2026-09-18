import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { terminateChildProcess } from "../../runtime/process-lifecycle.mjs";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));

export interface ServiceRestartRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function restartAppServerService(
  options: ServiceRestartRunnerOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? 180_000;
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(packageDir, "bin", "codexc.mjs"),
      "service",
      "restart",
      "app-server",
    ], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-4_000);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    let settled = false;
    let terminationError: Error | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error: Error, cleanupMessage: string): void => {
      if (settled || terminationError) return;
      terminationError = error;
      void terminateChildProcess(child).then(
        () => finish(error),
        (cleanupError) => finish(new Error(cleanupMessage, { cause: cleanupError })),
      );
    };
    const abort = () => terminate(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("codexc service restart app-server 已取消"),
      "codexc service restart app-server 取消且子进程树清理失败",
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => terminate(
      new Error("codexc service restart app-server 超时"),
      "codexc service restart app-server 超时且子进程树清理失败",
    ), timeoutMs);
    child.once("error", (error) => {
      finish(terminationError ?? error);
    });
    child.once("close", (code) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      finish(new Error(
        `codexc service restart app-server 失败：exit=${code ?? "?"}`
        + (detail ? ` ${detail}` : ""),
      ));
    });
    if (options.signal?.aborted) abort();
  });
}
