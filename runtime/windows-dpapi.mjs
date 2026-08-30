import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExecutableInvocation } from "./executable.mjs";

const maximumDpapiResponseBytes = 1_048_576;

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
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Windows DPAPI 操作失败");
  }
  let response;
  try {
    response = JSON.parse(result.stdout.trim());
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
