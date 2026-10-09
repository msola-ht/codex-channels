import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutableInvocation } from "./executable.mjs";

/** An owned Windows process cannot outlive its helper's kernel Job handle. */
export function ownedProcessInvocation(invocation, environment = process.env, socketPath) {
  if (process.platform !== "win32") return invocation;
  return resolveExecutableInvocation("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(dirname(fileURLToPath(import.meta.url)), "windows-owned-process.ps1"),
    "-Invocation", Buffer.from(JSON.stringify({ ...invocation, socketPath }), "utf8").toString("base64"),
  ], environment);
}

export function codexProcessInvocation(command, args, environment = process.env) {
  const socketPath = args[0] === "app-server" && args[1] === "proxy" && args[2] === "--sock" ? args[3] : undefined;
  return ownedProcessInvocation(resolveExecutableInvocation(command, args, environment), environment, socketPath);
}
