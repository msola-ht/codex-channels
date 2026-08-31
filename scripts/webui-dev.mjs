import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installProcessSignalHandlers,
  signalChildProcesses,
} from "../runtime/process-lifecycle.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const children = new Set();
let shuttingDown = false;

function start(command, args, options = {}) {
  const invocation = resolveExecutableInvocation(command, args);
  const child = spawn(invocation.file, invocation.args, {
    stdio: "inherit",
    ...options,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(
      `webui:dev 子进程退出（${signal ?? code}），正在停止另一个进程…`,
    );
    signalChildProcesses([...children], "SIGTERM");
    process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`webui:dev 启动失败：${error.message}`);
    signalChildProcesses([...children], "SIGTERM");
    process.exitCode = 1;
  });
  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  signalChildProcesses([...children], signal);
}

installProcessSignalHandlers({
  SIGINT: () => shutdown("SIGINT"),
  SIGTERM: () => shutdown("SIGTERM"),
});

start(process.execPath, [join(packageDir, "bin", "codexc.mjs"), "webui"]);
start("npm", ["run", "dev"], { cwd: join(packageDir, "webui") });
