import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Preserve a live Unix process-group leader until every inherited output pipe
// closes, so cancellation can escalate without targeting a recycled group ID.
export function supervisedCliInvocation(invocation) {
  if (process.platform === "win32") return invocation;
  return {
    file: process.execPath,
    args: [fileURLToPath(import.meta.url), invocation.file, ...invocation.args],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform === "win32" || !process.argv[2]) throw new Error("CLI 进程组监管需要 Unix 命令");
  const onTerminate = () => {};
  process.on("SIGTERM", onTerminate);
  const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let failure;
  child.once("error", error => { failure = error; });
  const code = await new Promise(resolve => child.once("close", code => resolve(code)));
  process.off("SIGTERM", onTerminate);
  if (failure) console.error(failure.message);
  process.exitCode = failure ? 1 : code ?? 1;
}
