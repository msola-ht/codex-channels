import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExecutableInvocation } from "./executable.mjs";

const maximumDpapiResponseBytes = 1_048_576;
const activeDpapiChildren = new Set();

export function protectForCurrentWindowsUser(value, environment = process.env, options = {}) {
  return invokeDpapiAsync("protect", value, environment, options);
}

export function unprotectForCurrentWindowsUser(value, environment = process.env, options = {}) {
  return invokeDpapiAsync("unprotect", value, environment, options);
}

async function invokeDpapiAsync(operation, value, environment, { signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform !== "win32") throw new Error("DPAPI 凭据保护只支持 Windows");
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > maximumDpapiResponseBytes) throw new Error("DPAPI 输入无效");
  if (activeDpapiChildren.size >= 4) throw new Error("Windows DPAPI 请求繁忙");
  let invocation;
  try {
    invocation = resolveExecutableInvocation("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(dirname(fileURLToPath(import.meta.url)), "windows-dpapi.ps1")], environment);
  } catch { throw new Error("Windows 凭据保护需要 PowerShell 7（pwsh）"); }
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.file, invocation.args, {
      stdio: ["pipe", "pipe", "ignore"], env: environment, windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    activeDpapiChildren.add(child);
    let failure;
    let bytes = 0;
    const chunks = [];
    const stop = reason => {
      failure ??= new Error(reason);
      child.kill();
    };
    const abort = () => stop("Windows DPAPI 操作已取消；未确认操作结果");
    const timer = setTimeout(() => stop("Windows DPAPI 操作超过 5 秒，已终止；未确认操作结果"), 5_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => { failure ??= new Error("Windows DPAPI 操作无法启动"); });
    child.stdin.on("error", () => stop("Windows DPAPI 输入失败"));
    child.stdout.on("error", () => stop("Windows DPAPI 输出失败"));
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maximumDpapiResponseBytes) { stop("Windows DPAPI 返回超过上限"); return; }
      chunks.push(chunk);
    });
    child.once("close", code => {
      activeDpapiChildren.delete(child);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) { reject(failure ?? new Error("Windows DPAPI 操作失败")); return; }
      try {
        signal?.throwIfAborted();
        resolve(parseDpapiResponse(Buffer.concat(chunks, bytes).toString("utf8")));
      } catch (error) { reject(error); }
    });
    if (signal?.aborted) abort();
    else child.stdin.end(JSON.stringify({ operation, data: value.toString("base64") }));
  });
}

export function protectForCurrentWindowsUserSync(value, environment = process.env) {
  return invokeDpapi("protect", value, environment);
}

export function unprotectForCurrentWindowsUserSync(value, environment = process.env) {
  return invokeDpapi("unprotect", value, environment);
}

function invokeDpapi(operation, value, environment) {
  if (process.platform !== "win32") {
    throw new Error("DPAPI 凭据保护只支持 Windows");
  }
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new Error("DPAPI 输入无效");
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), "windows-dpapi.ps1");
  let invocation;
  try {
    invocation = resolveExecutableInvocation(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
      ],
      environment,
    );
  } catch {
    throw new Error("Windows 凭据保护需要 PowerShell 7（pwsh）");
  }
  const result = spawnSync(invocation.file, invocation.args, {
    input: JSON.stringify({ operation, data: value.toString("base64") }),
    encoding: "utf8",
    maxBuffer: maximumDpapiResponseBytes,
    timeout: 5_000,
    env: environment,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error || result.status !== 0) {
    if (result.error?.code === "ETIMEDOUT") {
      throw new Error("Windows DPAPI 操作超过 5 秒，已终止；未确认操作结果");
    }
    throw new Error("Windows DPAPI 操作失败");
  }
  return parseDpapiResponse(result.stdout);
}

function parseDpapiResponse(content) {
  let response;
  try {
    response = JSON.parse(content.trim());
  } catch {
    throw new Error("Windows DPAPI 返回无效");
  }
  if (response?.ok !== true || typeof response.data !== "string") {
    throw new Error("Windows DPAPI 返回无效");
  }
  const output = Buffer.from(response.data, "base64");
  if (output.length === 0 || output.toString("base64") !== response.data) {
    throw new Error("Windows DPAPI 返回无效");
  }
  return output;
}
