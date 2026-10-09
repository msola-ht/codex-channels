import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveExecutableInvocation } from "../runtime/executable.mjs";

const packageName = "@hegenai/codexc";
const sourceMetadataFile = "codexc-source-install.json";

export function inferNpmGlobalPrefix(packageDirectory) {
  const scopeDirectory = dirname(packageDirectory);
  const nodeModulesDirectory = dirname(scopeDirectory);
  const libraryDirectory = dirname(nodeModulesDirectory);
  if (process.platform !== "win32" && basename(libraryDirectory) !== "lib") return undefined;
  const prefix = process.platform === "win32" ? libraryDirectory : dirname(libraryDirectory);
  if (packageDirectory !== join(scopeDirectory, "codexc")
    || scopeDirectory !== join(nodeModulesDirectory, "@hegenai")
    || nodeModulesDirectory !== join(libraryDirectory, "node_modules")) {
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

export function readInstalledSourceMetadata(packageDirectory) {
  const path = join(packageDirectory, sourceMetadataFile);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`源码安装来源记录不是普通文件：${path}`);
  }
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`无法读取源码安装来源记录：${path}`);
  }
  if (metadata?.version !== 1
    || typeof metadata.checkout !== "string"
    || !isAbsolute(metadata.checkout)
    || typeof metadata.managed !== "boolean") {
    throw new Error(`源码安装来源记录不受支持：${path}`);
  }
  return { version: 1, checkout: metadata.checkout, managed: metadata.managed };
}

export function hasManagedSourceMarker(checkout, environment = process.env) {
  const result = spawnSync("git", ["config", "--local", "--get", "codex-connect.managed-source"], {
    cwd: checkout, env: sourceGitEnvironment(environment), encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`无法读取受管源码标记：${checkout}`);
  }
  return result.status === 0 && result.stdout.trim() === "true";
}

export function recordInstalledSourceMetadata(checkout, prefix, environment = process.env) {
  const packageDirectory = join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@hegenai", "codexc");
  if (inferNpmGlobalPrefix(packageDirectory) !== prefix
    || lstatSync(packageDirectory).isSymbolicLink()) {
    throw new Error(`无法确认已安装的 npm 全局包：${packageDirectory}`);
  }
  const source = realpathSync(checkout);
  const managed = existsSync(join(source, ".git")) && hasManagedSourceMarker(source, environment);
  const path = join(packageDirectory, sourceMetadataFile);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`源码安装来源记录不是普通文件：${path}`);
  }
  writeFileSync(path, `${JSON.stringify({ version: 1, checkout: source, managed }, null, 2)}\n`, { mode: 0o600 });
  if (managed) recordManagedSourceMetadata(source, [prefix], environment);
}

export function readManagedNpmPrefixes(checkout, environment = process.env) {
  const result = spawnSync(
    "git",
    ["config", "--local", "--get-all", "codex-connect.npm-prefix"],
    { cwd: checkout, env: sourceGitEnvironment(environment), encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`无法读取源码 npm 全局目录：${result.stderr || result.stdout}`);
  }
  if (result.status === 1) return [];
  const prefixes = result.stdout.trimEnd().split("\n").map((entry) => entry.trim());
  if (prefixes.some((entry) => !isSafePrefix(entry))) {
    throw new Error(`受管源码 npm 全局目录记录无效：${checkout}`);
  }
  return prefixes;
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
    env: sourceGitEnvironment(environment),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`无法记录受管源码安装：${result.stderr || result.stdout}`);
  }
}

function sourceGitEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^GIT_/iu.test(key)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, checkout, prefix, ...extra] = process.argv.slice(2);
  if (command !== "record" || !checkout || !prefix || extra.length) {
    throw new Error("用法：source-install-metadata.mjs record <checkout> <npm-prefix>");
  }
  recordInstalledSourceMetadata(checkout, prefix);
}
