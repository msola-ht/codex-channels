import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { resolveExecutableInvocation } from "../runtime/executable.mjs";

const packageName = "@hegenai/codexc";

export function inferNpmGlobalPrefix(packageDirectory) {
  const scopeDirectory = dirname(packageDirectory);
  const nodeModulesDirectory = dirname(scopeDirectory);
  const libraryDirectory = dirname(nodeModulesDirectory);
  const prefix = dirname(libraryDirectory);
  if (
    packageDirectory !== join(scopeDirectory, "codexc")
    || scopeDirectory !== join(nodeModulesDirectory, "@hegenai")
    || nodeModulesDirectory !== join(libraryDirectory, "node_modules")
    || libraryDirectory !== join(prefix, "lib")
  ) {
    return undefined;
  }
  const manifest = join(packageDirectory, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(manifest, "utf8"));
    return metadata.name === packageName && isAbsolute(prefix) ? prefix : undefined;
  } catch {
    return undefined;
  }
}

export function readManagedNpmPrefixes(checkout, environment = process.env) {
  const result = spawnSync(
    "git",
    ["config", "--local", "--get-all", "codex-connect.npm-prefix"],
    { cwd: checkout, env: environment, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`无法读取源码 npm 全局目录：${result.stderr || result.stdout}`);
  }
  return result.status === 0
    ? result.stdout.split("\n").map((entry) => entry.trim()).filter(isSafePrefix)
    : [];
}

export function recordManagedSourceMetadata(
  checkout,
  prefixes,
  environment = process.env,
) {
  runGitConfig(checkout, ["codex-connect.managed-source", "true"], environment);
  const recorded = new Set(readManagedNpmPrefixes(checkout, environment));
  for (const prefix of prefixes) {
    if (!prefix || !isSafePrefix(prefix) || recorded.has(prefix)) continue;
    runGitConfig(
      checkout,
      ["--add", "codex-connect.npm-prefix", prefix],
      environment,
    );
    recorded.add(prefix);
  }
}

export function currentNpmGlobalPrefix(environment = process.env) {
  const invocation = resolveExecutableInvocation(
    "npm",
    ["prefix", "--global"],
    environment,
  );
  const result = spawnSync(invocation.file, invocation.args, {
    env: environment,
    encoding: "utf8",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  const prefix = result.stdout.trim();
  if (result.status !== 0 || !isSafePrefix(prefix)) {
    throw new Error(`无法解析 npm 全局目录：${result.stderr || result.stdout}`);
  }
  return prefix;
}

function isSafePrefix(prefix) {
  return isAbsolute(prefix) && dirname(prefix) !== prefix;
}

function runGitConfig(checkout, args, environment) {
  const result = spawnSync("git", ["config", "--local", ...args], {
    cwd: checkout,
    env: environment,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`无法记录受管源码安装：${result.stderr || result.stdout}`);
  }
}
