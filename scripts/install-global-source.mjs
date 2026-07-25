import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { packageDir } from "./package-path.mjs";

const sourceConfig = join(packageDir, "tsconfig.build.json");
if (!existsSync(sourceConfig)) {
  throw new Error("install:global 只能在 codexc 源码仓库中运行");
}

const prepared = run(process.execPath, [
  join(packageDir, "scripts", "prepare-package.mjs"),
]);
if (prepared === 0) {
  process.exitCode = run("npm", [
    "install",
    "--global",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    packageDir,
  ]);
} else {
  process.exitCode = prepared;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}
