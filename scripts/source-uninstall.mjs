import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { packageDir } from "./package-path.mjs";
import { userDataDir } from "./runtime-config.mjs";
import {
  hasManagedSourceMarker,
  inferNpmGlobalPrefix,
  readInstalledSourceMetadata,
  readManagedNpmPrefixes,
} from "./source-install-metadata.mjs";

export async function uninstallInstallation(
  environment = process.env,
  options = {},
) {
  const projectDir = realpathSync(options.projectDir ?? packageDir);
  const expectedCheckout = join(userDataDir(environment), "codex-channels");
  const activePrefix = inferNpmGlobalPrefix(projectDir);
  const packages = new Map();
  let checkout;

  if (activePrefix) {
    const activePackage = inspectGlobalPackage(activePrefix);
    if (!activePackage || activePackage.directory !== projectDir) {
      throw new Error("无法确认当前 codexc 的 npm 全局安装身份，拒绝卸载");
    }
    packages.set(activePackage.directory, activePackage);
    if (activePackage.source?.managed) {
      if (existsSync(expectedCheckout)) {
        checkout = inspectManagedCheckout(expectedCheckout, activePackage.source.checkout, environment);
      } else if (resolve(activePackage.source.checkout) !== resolve(expectedCheckout)) {
        throw new Error("受管源码安装来源与当前用户目录不一致，拒绝卸载");
      }
    }
  } else {
    checkout = inspectManagedCheckout(expectedCheckout, projectDir, environment);
  }

  if (checkout) {
    for (const prefix of readManagedNpmPrefixes(checkout.directory, environment)) {
      const candidate = inspectGlobalPackage(prefix);
      if (candidate?.source?.managed && candidate.source.checkout === checkout.directory) {
        packages.set(candidate.directory, candidate);
      }
    }
  }

  // Keep this command available if removing another prefix fails.
  const installations = [...packages.values()].sort((left, right) =>
    Number(left.directory === projectDir) - Number(right.directory === projectDir));
  // Identify every target before stopping services and recheck it before deletion.
  await (options.uninstallServices ?? uninstallServices)(projectDir, environment);
  for (const installed of installations) assertUnchangedPackage(installed);
  for (const installed of installations) {
    assertUnchangedPackage(installed);
    await (options.uninstallGlobalPackage ?? uninstallGlobalPackage)([installed.prefix], environment);
  }
  if (checkout) {
    const current = inspectManagedCheckout(expectedCheckout, checkout.directory, environment);
    assertSameDirectory(checkout, current);
    rmSync(checkout.directory, { recursive: true });
  }
  return { checkout: checkout?.directory, prefixes: [...packages.values()].map((entry) => entry.prefix) };
}

function inspectManagedCheckout(expected, source, environment) {
  const directory = lstatSync(expected, { throwIfNoEntry: false });
  if (!directory?.isDirectory() || directory.isSymbolicLink()
    || realpathSync(expected) !== source
    || !lstatSync(join(expected, ".git"), { throwIfNoEntry: false })?.isDirectory()
    || !hasManagedSourceMarker(expected, environment)) {
    throw new Error(`无法确认当前 codexc 的受管源码身份，拒绝删除：${expected}`);
  }
  return { directory: realpathSync(expected), dev: directory.dev, ino: directory.ino };
}

function inspectGlobalPackage(prefix) {
  const directory = join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@hegenai", "codexc");
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || inferNpmGlobalPrefix(directory) !== prefix) {
    throw new Error(`无法确认 npm 全局包身份，拒绝卸载：${directory}`);
  }
  const canonical = realpathSync(directory);
  const canonicalPrefix = inferNpmGlobalPrefix(canonical);
  if (!canonicalPrefix) throw new Error(`npm 全局包规范路径不受支持：${directory}`);
  return {
    prefix: canonicalPrefix, directory: canonical, dev: stat.dev, ino: stat.ino,
    source: readInstalledSourceMetadata(directory),
  };
}

function assertSameDirectory(expected, current) {
  if (!current || expected.directory !== current.directory
    || expected.dev !== current.dev || expected.ino !== current.ino) {
    throw new Error(`卸载目标已改变，拒绝继续：${expected.directory}`);
  }
}

function assertUnchangedPackage(expected) {
  const current = inspectGlobalPackage(expected.prefix);
  assertSameDirectory(expected, current);
  if (JSON.stringify(expected.source) !== JSON.stringify(current.source)) {
    throw new Error(`npm 全局包来源已改变，拒绝继续：${expected.directory}`);
  }
}

function uninstallGlobalPackage(prefixes, environment) {
  for (const prefix of prefixes) {
    const invocation = resolveExecutableInvocation(
      "npm",
      [
        "uninstall",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@hegenai/codexc",
      ],
      environment,
    );
    const result = spawnSync(
      invocation.file,
      invocation.args,
      {
        env: environment,
        cwd: prefix,
        stdio: "inherit",
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`npm 全局命令卸载失败：${prefix} · exit=${result.status ?? 1}`);
    }
    if (existsSync(join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@hegenai", "codexc"))) {
      throw new Error(`npm 全局包仍然存在，源码已保留：${prefix}`);
    }
  }
}

function uninstallServices(projectDir, environment) {
  const result = spawnSync(
    process.execPath,
    [join(projectDir, "bin", "codexc.mjs"), "uninstall", "--services"],
    { cwd: projectDir, env: environment, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`后台服务卸载失败：exit=${result.status ?? 1}`);
  }
}

async function main() {
  const result = await uninstallInstallation();
  writeCliMessage("success", result.checkout
    ? `受管 Git 源码与对应 npm 全局命令已删除：${result.checkout}`
    : "当前 npm 全局命令已卸载，源码工作树已保留。");
  writeCliMessage("note", "用户配置、数据库、凭据、日志、输出、Codex CLI 与 Shell 配置均已保留。");
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
