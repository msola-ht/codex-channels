import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { registerChildProcessGroup, terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import { withCliProgress } from "./cli-operation-progress.mjs";

const maximumTail = 64 * 1024;
const maximumCapturedOutput = 8 * 1024 * 1024;
const workerPath = fileURLToPath(import.meta.url);

// Keep the Unix group leader alive while descendants still own output pipes.
// The parent can then escalate cancellation without signalling a recycled PGID.
async function superviseInstallationCommand(command, args) {
  const onTerminate = () => {};
  process.on("SIGTERM", onTerminate);
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let failure;
  child.once("error", error => { failure = error; });
  const code = await new Promise(resolve => child.once("close", code => resolve(code)));
  process.off("SIGTERM", onTerminate);
  if (failure) console.error(failure.message);
  process.exitCode = failure ? 1 : code ?? 1;
}

export async function runInstallationCommand(label, command, args, { cwd = process.cwd(), captureStdout = false } = {}) {
  return withCliProgress(label, async (progress) => {
    const invocation = resolveExecutableInvocation(command, args);
    let tail = "";
    let stdout = "";
    let capturedBytes = 0;
    let stderr = "";
    let stdoutTail = "";
    let truncated = false;
    let failure;
    let stopping;
    const unix = process.platform !== "win32";
    const child = spawn(unix ? process.execPath : invocation.file, unix
      ? [workerPath, "--internal-run", invocation.file, ...invocation.args]
      : invocation.args, {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (process.platform !== "win32") registerChildProcessGroup(child);
    const stop = () => {
      stopping ??= terminateChildProcess(child).catch((error) => { failure = error; });
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
      const { code, signal } = await new Promise((resolveClose) => {
        child.once("error", (error) => { failure = error; });
        child.once("close", (code, signal) => resolveClose({ code, signal }));
      });
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
  if (process.argv[2] === "--internal-run" && process.platform !== "win32") {
    await superviseInstallationCommand(process.argv[3], process.argv.slice(4));
  } else {
    const [label, separator, command, ...args] = process.argv.slice(2);
    if (!label || separator !== "--" || !command) throw new Error("用法：installation-command.mjs 阶段名称 -- 命令 [参数...]");
    try { await runInstallationCommand(label, command, args); }
    catch (error) {
      console.error(error instanceof Error ? error.message : "安装命令失败");
      process.exitCode = error?.exitCode ?? 1;
    }
  }
}
