import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32" && process.env.npm_config_ignore_scripts !== "true") {
  const result = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", fileURLToPath(new URL("./build-windows-native.ps1", import.meta.url)),
  ], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
