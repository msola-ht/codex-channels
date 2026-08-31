import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { installGitHooks } from "./install-git-hooks.mjs";
import { packageDir } from "./package-path.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";

const sourceConfig = join(packageDir, "tsconfig.build.json");
const builtEntry = join(packageDir, "dist", "main.js");

if (existsSync(sourceConfig)) {
  if (ensureSourceDependencies()) {
    installGitHooks(packageDir);
    process.exitCode = runNpm(["run", "build"]);
  }
} else if (!existsSync(builtEntry)) {
  throw new Error("npm 包缺少已构建的 Gateway 入口");
}

function ensureSourceDependencies() {
  const invocation = resolveExecutableInvocation("npm", [
    "ls",
    "--include=dev",
    "--depth=0",
    "--silent",
    "--global=false",
  ]);
  const inspected = spawnSync(
    invocation.file,
    invocation.args,
    {
      cwd: packageDir,
      stdio: "ignore",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    },
  );
  if (inspected.error) {
    throw inspected.error;
  }
  if (inspected.status === 0) {
    return true;
  }
  const status = runNpm([
    "ci",
    "--ignore-scripts",
    "--include=dev",
    "--no-audit",
    "--no-fund",
    "--global=false",
  ]);
  if (status !== 0) {
    process.exitCode = status;
    return false;
  }
  return true;
}

function runNpm(args) {
  const invocation = resolveExecutableInvocation("npm", args);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: packageDir,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}
