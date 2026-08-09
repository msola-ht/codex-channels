import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { packageDir } from "./package-path.mjs";

const sourceConfig = join(packageDir, "tsconfig.build.json");
const webuiDir = join(packageDir, "webui");
if (!existsSync(sourceConfig)) {
  throw new Error("install:global 只能在 codexc 源码仓库中运行");
}

const prepared = run(process.execPath, [
  join(packageDir, "scripts", "prepare-package.mjs"),
]);
const webuiBuilt = prepared === 0 ? buildWebui() : 1;
if (prepared === 0 && webuiBuilt === 0) {
  process.exitCode = run("npm", [
    "install",
    "--global",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    packageDir,
  ]);
} else {
  process.exitCode = prepared === 0 ? webuiBuilt : prepared;
}

function buildWebui() {
  const installed = run(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    webuiDir,
  );
  if (installed !== 0) return installed;
  return run("npm", ["run", "build"], webuiDir);
}

function run(command, args, cwd = packageDir) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}
