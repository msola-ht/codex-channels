import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));

export interface ServiceRestartRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function restartAppServerService(
  options: ServiceRestartRunnerOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? 180_000;
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
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("codexc service restart app-server 超时"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim() || stdout.trim();
      reject(new Error(
        `codexc service restart app-server 失败：exit=${code ?? "?"}`
        + (detail ? ` ${detail}` : ""),
      ));
    });
  });
}
