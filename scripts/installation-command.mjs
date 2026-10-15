import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { registerChildProcessGroup, terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import { withCliProgress } from "./cli-operation-progress.mjs";
import { supervisedCliInvocation } from "./cli-command-worker.mjs";

const maximumTail = 64 * 1024;
const maximumCapturedOutput = 8 * 1024 * 1024;

export async function runInstallationCommand(label, command, args, { cwd = process.cwd(), captureStdout = false } = {}) {
  return withCliProgress(label, async (progress) => {
    const invocation = supervisedCliInvocation(resolveExecutableInvocation(command, args));
    let tail = "";
    let stdout = "";
    let capturedBytes = 0;
    let stderr = "";
    let stdoutTail = "";
    let truncated = false;
    let failure;
    let stopping;
    let resolveStopped;
    const stopped = new Promise(resolve => { resolveStopped = resolve; });
    const child = spawn(invocation.file, invocation.args, {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (process.platform !== "win32") registerChildProcessGroup(child);
    const stop = () => {
      stopping ??= terminateChildProcess(child).catch((error) => {
        failure = new Error(`${label}子进程终止未获确认`, { cause: error });
        child.unref();
      }).finally(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolveStopped({ code: null, signal: null });
      });
    };
    const abort = () => { failure ??= progress.signal.reason; stop(); };
    const collect = (chunk, stream) => {
      tail += chunk;
      if (tail.length > maximumTail) { tail = tail.slice(-maximumTail); truncated = true; }
      if (stream === "stdout" && captureStdout) {
        stdoutTail = (stdoutTail + chunk).slice(-maximumTail);
        capturedBytes += Buffer.byteLength(chunk);
        if (capturedBytes > maximumCapturedOutput) {
          failure ??= new Error(`${label}输出超过 8 MiB，已终止命令`);
          stop();
        } else stdout += chunk;
      } else if (!progress.interactive) {
        if (!process[stream].write(chunk)) {
          child[stream].pause();
          process[stream].once("drain", () => child[stream].resume());
        }
      }
      if (stream === "stderr") stderr = (stderr + chunk).slice(-maximumTail);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    progress.signal.addEventListener("abort", abort, { once: true });
    if (progress.signal.aborted) abort();
    try {
      const closed = new Promise((resolveClose) => {
        child.once("error", (error) => { failure = error; });
        child.once("close", (code, signal) => resolveClose({ code, signal }));
      });
      const { code, signal } = await Promise.race([closed, stopped]);
      await stopping;
      if (failure || code !== 0 || signal) {
        if (progress.interactive && tail) progress.log(`${truncated ? "[提示] 仅显示最后 64K 字符命令输出。\n" : ""}${tail}`, { stream: "stderr" });
        else if (captureStdout && stdoutTail) progress.log(stdoutTail, { stream: "stderr" });
        throw failure ?? Object.assign(new Error(`${label}失败（${signal ? `signal=${signal}` : `exit=${code ?? 1}`}）`), { exitCode: code || 1 });
      }
      if (progress.interactive && stderr.trim()) progress.log(stderr, { stream: "stderr" });
      return { stdout };
    } finally {
      progress.signal.removeEventListener("abort", abort);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [label, separator, command, ...args] = process.argv.slice(2);
  if (!label || separator !== "--" || !command) throw new Error("用法：installation-command.mjs 阶段名称 -- 命令 [参数...]");
  try { await runInstallationCommand(label, command, args); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "安装命令失败");
    process.exitCode = error?.exitCode ?? 1;
  }
}
