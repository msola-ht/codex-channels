import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Preserve a live Unix process-group leader until every inherited output pipe
// closes, so cancellation can escalate without targeting a recycled group ID.
export function supervisedCliInvocation(invocation, { forwardInput = false } = {}) {
  if (process.platform === "win32") return invocation;
  return {
    file: process.execPath,
    args: [fileURLToPath(import.meta.url), ...(forwardInput ? ["--forward-input"] : []), invocation.file, ...invocation.args],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform === "win32" || !process.argv[2]) throw new Error("CLI 进程组监管需要 Unix 命令");
  const onTerminate = () => {};
  process.on("SIGTERM", onTerminate);
  const forwardInput = process.argv[2] === "--forward-input";
  const offset = forwardInput ? 3 : 2;
  const child = spawn(process.argv[offset], process.argv.slice(offset + 1), { stdio: [forwardInput ? "pipe" : "ignore", "pipe", "pipe"] });
  if (forwardInput) {
    child.stdin.on("error", () => {});
    process.stdin.pipe(child.stdin);
  }
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let failure;
  child.once("error", error => { failure = error; });
  const code = await new Promise(resolve => child.once("close", code => resolve(code)));
  if (forwardInput) process.stdin.destroy();
  process.off("SIGTERM", onTerminate);
  if (failure) console.error(failure.message);
  process.exitCode = failure ? 1 : code ?? 1;
}
