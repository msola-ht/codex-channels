import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { packageDir } from "./package-path.mjs";
import { userDataDir } from "./runtime-config.mjs";
import {
  inferNpmGlobalPrefix,
  readManagedNpmPrefixes,
} from "./source-install-metadata.mjs";

export async function uninstallManagedSourceInstallation(
  environment = process.env,
  options = {},
) {
  const projectDir = options.projectDir ?? packageDir;
  const installRoot = userDataDir(environment);
  const checkout = join(installRoot, "codex-channels");
  assertManagedSourceInstallation(checkout, projectDir, environment);
  const npmPrefixes = new Set(readManagedNpmPrefixes(checkout, environment));
  const activePrefix = inferNpmGlobalPrefix(projectDir);
  if (activePrefix) npmPrefixes.add(activePrefix);

  await (options.uninstallServices ?? uninstallServices)(checkout, environment);
  await (options.uninstallGlobalPackage ?? uninstallGlobalPackage)(
    [...npmPrefixes],
    environment,
  );
  rmSync(checkout, { recursive: true });
  return { checkout };
}

function assertManagedSourceInstallation(checkout, projectDir, environment) {
  if (!existsSync(checkout) || !existsSync(join(checkout, ".git"))) {
    throw new Error(
      "当前不是受管 Git 源码安装；npm 全局版请先运行 codexc service uninstall，再执行 npm uninstall -g @hegenai/codexc",
    );
  }
  if (lstatSync(checkout).isSymbolicLink()) {
    throw new Error(`源码目录与当前 codexc 不一致，拒绝删除：${checkout}`);
  }
  const runsFromCheckout = realpathSync(checkout) === realpathSync(projectDir);
  if (
    !runsFromCheckout
    && !hasManagedSourceMarker(checkout, environment)
  ) {
    throw new Error(`源码目录与当前 codexc 不一致，拒绝删除：${checkout}`);
  }
}

function hasManagedSourceMarker(checkout, environment) {
  const result = spawnSync(
    "git",
    ["config", "--local", "--get", "codex-connect.managed-source"],
    { cwd: checkout, env: environment, encoding: "utf8" },
  );
  return !result.error && result.status === 0 && result.stdout.trim() === "true";
}

function uninstallGlobalPackage(prefixes, environment) {
  for (const prefix of prefixes) {
    const packageDirectory = [
      join(prefix, "node_modules", "@hegenai", "codexc"),
      join(prefix, "lib", "node_modules", "@hegenai", "codexc"),
    ].find((candidate) => inferNpmGlobalPrefix(candidate) === prefix);
    if (packageDirectory === undefined) continue;
    const invocation = resolveExecutableInvocation(
      "npm",
      [
        "uninstall",
        "--global",
        "--prefix",
        prefix,
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
        stdio: "inherit",
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`npm 全局命令卸载失败：${prefix} · exit=${result.status ?? 1}`);
    }
  }
}

function uninstallServices(checkout, environment) {
  const result = spawnSync(
    process.execPath,
    [join(checkout, "bin", "codexc.mjs"), "service", "uninstall"],
    { cwd: checkout, env: environment, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`后台服务卸载失败：exit=${result.status ?? 1}`);
  }
}

async function main() {
  const result = await uninstallManagedSourceInstallation();
  writeCliMessage("success", `Git 源码与 npm 全局命令已删除：${result.checkout}`);
  writeCliMessage("note", "用户配置、数据库、凭据、日志、输出与 Shell 配置均已保留。");
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
