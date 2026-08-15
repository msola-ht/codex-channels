import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codexc-source-install-"));
  try {
    const tarballPath = packSource(temporaryDirectory);
    process.exitCode = run("npm", [
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
} else {
  process.exitCode = prepared === 0 ? webuiBuilt : prepared;
}

function packSource(destination) {
  const result = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    {
      cwd: packageDir,
      encoding: "utf8",
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `源码打包失败：exit=${result.status ?? 1}\n${result.stderr || result.stdout}`,
    );
  }
  const report = JSON.parse(result.stdout);
  const packageReport = Array.isArray(report) ? report[0] : Object.values(report)[0];
  if (!packageReport?.filename) {
    throw new Error("npm pack 未返回 tarball 文件名");
  }
  return resolve(destination, packageReport.filename);
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
