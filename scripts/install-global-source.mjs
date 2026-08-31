import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { packageDir } from "./package-path.mjs";

const sourceConfig = join(packageDir, "tsconfig.build.json");
const webuiDir = join(packageDir, "webui");
if (!existsSync(sourceConfig)) {
  throw new Error("install:global 只能在 codexc 源码仓库中运行");
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--prepared")) {
  throw new Error("用法：install-global-source.mjs [--prepared]");
}
const alreadyPrepared = args.includes("--prepared");
const prepared = alreadyPrepared
  ? assertPreparedBuild()
  : run(process.execPath, [join(packageDir, "scripts", "prepare-package.mjs")]);
const webuiBuilt = prepared === 0 && !alreadyPrepared ? buildWebui() : prepared;
if (prepared === 0 && webuiBuilt === 0) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codexc-source-install-"));
  try {
    const tarballPath = packSource(temporaryDirectory);
    process.exitCode = runQuiet("npm", [
      "install",
      "--global",
      "--ignore-scripts",
      "--loglevel=error",
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

function assertPreparedBuild() {
  if (
    !existsSync(join(packageDir, "dist", "main.js"))
    || !existsSync(join(webuiDir, "dist", "index.html"))
  ) {
    throw new Error("预构建源码缺少 Gateway 或 WebUI 构建结果");
  }
  return 0;
}

function packSource(destination) {
  const invocation = resolveExecutableInvocation("npm", [
    "pack",
    "--ignore-scripts",
    "--loglevel=error",
    "--json",
    "--pack-destination",
    destination,
  ]);
  const result = spawnSync(
    invocation.file,
    invocation.args,
    {
      cwd: packageDir,
      encoding: "utf8",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
  const invocation = resolveExecutableInvocation(command, args);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function runQuiet(command, args, cwd = packageDir) {
  const invocation = resolveExecutableInvocation(command, args);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    encoding: "utf8",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result.status ?? 1;
}
