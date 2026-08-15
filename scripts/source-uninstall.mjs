import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { packageDir } from "./package-path.mjs";
import { userDataDir } from "./runtime-config.mjs";

export async function uninstallManagedSourceInstallation(
  environment = process.env,
  options = {},
) {
  const projectDir = options.projectDir ?? packageDir;
  const installRoot = userDataDir(environment);
  const checkout = join(installRoot, "codex-channels");
  const launcher = join(installRoot, ".bin", "codexc");
  const legacyLauncher = join(installRoot, "bin", "codexc");
  const launchers = [launcher, legacyLauncher];
  assertManagedSourceInstallation(checkout, launchers, projectDir);

  await (options.uninstallServices ?? uninstallServices)(checkout, environment);
  for (const commandEntry of launchers) {
    if (existsSync(commandEntry)) rmSync(commandEntry);
  }
  rmSync(checkout, { recursive: true });
  for (const launcherDirectory of new Set(launchers.map((entry) => dirname(entry)))) {
    if (existsSync(launcherDirectory) && readdirSync(launcherDirectory).length === 0) {
      rmdirSync(launcherDirectory);
    }
  }
  return { checkout, launcher };
}

function assertManagedSourceInstallation(checkout, launchers, projectDir) {
  if (!existsSync(checkout) || !existsSync(join(checkout, ".git"))) {
    throw new Error(
      "当前不是受管 Git 源码安装；npm 全局版请先运行 codexc service uninstall，再执行 npm uninstall -g @hegenai/codexc",
    );
  }
  if (lstatSync(checkout).isSymbolicLink() || realpathSync(checkout) !== realpathSync(projectDir)) {
    throw new Error(`源码目录与当前 codexc 不一致，拒绝删除：${checkout}`);
  }
  for (const launcher of launchers) {
    if (!existsSync(launcher)) continue;
    const stat = lstatSync(launcher);
    const content = stat.isFile() && !stat.isSymbolicLink()
      ? readFileSync(launcher, "utf8")
      : "";
    if (
      !content.includes('"$CODEX_CONNECT_HOME/codex-channels/bin/codexc.mjs"')
      && !content.includes(`${checkout}/bin/codexc.mjs`)
    ) {
      throw new Error(`命令入口不属于当前源码安装，拒绝删除：${launcher}`);
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
  writeCliMessage("success", `Git 源码与命令入口已删除：${result.checkout}`);
  writeCliMessage("note", "用户配置、数据库、凭据、日志与 Shell 配置均已保留。");
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
