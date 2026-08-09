import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const children = new Set();
let shuttingDown = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    ...options,
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(
      `webui:dev 子进程退出（${signal ?? code}），正在停止另一个进程…`,
    );
    for (const other of children) {
      if (other.exitCode === null) other.kill("SIGTERM");
    }
    process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`webui:dev 启动失败：${error.message}`);
    for (const other of children) {
      if (other.exitCode === null) other.kill("SIGTERM");
    }
    process.exitCode = 1;
  });
  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start(process.execPath, [join(packageDir, "bin", "codexc.mjs"), "webui"]);
start("npm", ["run", "dev"], { cwd: join(packageDir, "webui") });
