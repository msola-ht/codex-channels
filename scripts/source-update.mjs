import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { gatewayOwnerIsActive } from "../runtime/gateway-owner.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { packageDir } from "./package-path.mjs";
import { userDataDir } from "./runtime-config.mjs";

const officialRepository = "https://github.com/msola-ht/codex-channels.git";
const stableVersionPattern = /^\d+\.\d+\.\d+$/u;
const commitPattern = /^[0-9a-f]{40}$/u;

export function managedSourceCheckout(environment = process.env, projectDir = packageDir) {
  const expected = join(userDataDir(environment), "codex-channels");
  if (!existsSync(expected) || !existsSync(join(expected, ".git"))) return undefined;
  return realpathSync(expected) === realpathSync(projectDir) ? expected : undefined;
}

export async function updateManagedSourceInstallation(
  environment = process.env,
  options = {},
) {
  if (
    environment.CODEX_CONNECT_SERVICE_ROLE === "app-server"
    || environment.CODEX_CONNECT_SERVICE_ROLE === "gateway"
  ) {
    throw new Error("不能在运行中的 Codex 服务内执行更新；请在本机终端运行 codexc update");
  }
  const checkout = options.projectDir ?? managedSourceCheckout(environment);
  if (!checkout) return { changed: false, managed: false };
  const repository = options.repository ?? officialRepository;
  assertManagedRepository(checkout, repository, environment, options.captureCommand);
  const remoteCommit = resolveMainCommit(
    repository,
    checkout,
    environment,
    options.captureCommand,
  );
  const currentCommit = capture(
    "git",
    ["rev-parse", "HEAD"],
    checkout,
    environment,
    options.captureCommand,
  ).trim();
  const currentVersion = packageVersion(checkout);
  const writeMessage = options.writeMessage ?? writeCliMessage;
  writeMessage(
    "note",
    `Git 源码检查：当前 ${currentCommit.slice(0, 12)} · main ${remoteCommit.slice(0, 12)}`,
  );
  const installRoot = resolve(checkout, "..");
  if (currentCommit === remoteCommit) {
    migrateManagedSourceLauncher(installRoot, environment, writeMessage);
    return { changed: false, commit: currentCommit, managed: true, version: currentVersion };
  }

  const stagingRoot = mkdtempSync(join(installRoot, ".codex-channels-update."));
  const stagedCheckout = join(stagingRoot, "codex-channels");
  let switched = false;
  let servicesStopped = false;
  let backupPath;
  const renamePath = options.renamePath ?? renameSync;
  try {
    writeMessage("note", "正在克隆 Git main 候选源码。");
    runQuiet(
      "git",
      [
        "clone",
        "--quiet",
        "--branch",
        "main",
        "--single-branch",
        repository,
        stagedCheckout,
      ],
      installRoot,
      environment,
      options.runCommand,
    );
    const targetVersion = packageVersion(stagedCheckout);
    if (compareVersions(targetVersion, currentVersion) < 0) {
      throw new Error(`拒绝降级源码安装：当前 ${currentVersion}，main 为 ${targetVersion}`);
    }
    assertCodexVersion(targetVersion, environment, options.captureCommand);
    const targetCommit = capture(
      "git",
      ["rev-parse", "HEAD"],
      stagedCheckout,
      environment,
      options.captureCommand,
    ).trim();
    assertFastForward(stagedCheckout, currentCommit, targetCommit, environment);
    writeMessage("note", "正在构建并预检候选源码；详细日志仅在失败时显示。");
    await (options.buildCheckout ?? buildCheckout)(stagedCheckout, environment, options);
    const inspection = await (options.inspectStaged ?? inspectStagedInstallation)(
      stagedCheckout,
      environment,
    );
    writeMessage("note", "候选源码已通过校验，准备切换。");
    if (inspection.services.installed) {
      await (options.stopServices ?? stopCoreServices)(checkout, environment, options);
      servicesStopped = true;
    }

    backupPath = `${checkout}.pre-update-${Date.now()}`;
    renamePath(checkout, backupPath);
    try {
      renamePath(stagedCheckout, checkout);
      switched = true;
    } catch (error) {
      try {
        renamePath(backupPath, checkout);
        backupPath = undefined;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `候选源码切换失败，且旧源码未能恢复；旧源码仍位于 ${backupPath}`,
          { cause: restoreError },
        );
      }
      throw error;
    }

    await (options.runLocalUpdate ?? runLocalUpdate)(checkout, environment, options);
    migrateManagedSourceLauncher(installRoot, environment, writeMessage);
    rmSync(backupPath, { recursive: true, force: true });
    backupPath = undefined;
    return {
      changed: true,
      commit: targetCommit,
      managed: true,
      previousVersion: currentVersion,
      version: targetVersion,
    };
  } catch (error) {
    if (switched && backupPath) {
      throw new Error(
        `main 源码已切换，但本地更新未完成；旧源码保留在 ${backupPath}。${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (servicesStopped) {
      try {
        await (options.startServices ?? startCoreServices)(checkout, environment, options);
        servicesStopped = false;
      } catch (startError) {
        throw new AggregateError(
          [error, startError],
          "源码更新失败，且原核心服务未能恢复运行",
          { cause: startError },
        );
      }
    }
    throw error;
  } finally {
    if (existsSync(stagingRoot)) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
}

function migrateManagedSourceLauncher(installRoot, environment, writeMessage) {
  const legacyDirectory = join(installRoot, "bin");
  const legacyLauncher = join(legacyDirectory, "codexc");
  if (!existsSync(legacyLauncher)) return;
  const hiddenDirectory = join(installRoot, ".bin");
  const hiddenLauncher = join(hiddenDirectory, "codexc");
  const launcherStat = lstatSync(legacyLauncher);
  const launcherContent = launcherStat.isFile() && !launcherStat.isSymbolicLink()
    ? readFileSync(legacyLauncher, "utf8")
    : "";
  if (!launcherContent.includes('"$CODEX_CONNECT_HOME/codex-channels/bin/codexc.mjs"')) {
    throw new Error(`旧命令入口不属于受管源码安装，拒绝迁移：${legacyLauncher}`);
  }
  if (existsSync(hiddenLauncher)) {
    throw new Error(`隐藏命令入口已存在，拒绝覆盖：${hiddenLauncher}`);
  }

  mkdirSync(hiddenDirectory, { recursive: true, mode: 0o700 });
  chmodSync(hiddenDirectory, 0o700);
  const temporaryLauncher = `${hiddenLauncher}.tmp.${process.pid}`;
  try {
    writeFileSync(temporaryLauncher, launcherContent, { mode: launcherStat.mode & 0o777 });
    chmodSync(temporaryLauncher, launcherStat.mode & 0o777);
    renameSync(temporaryLauncher, hiddenLauncher);
  } finally {
    rmSync(temporaryLauncher, { force: true });
  }
  updateManagedShellPaths(environment);
  rmSync(legacyLauncher);
  if (readdirSync(legacyDirectory).length === 0) rmdirSync(legacyDirectory);
  writeMessage("note", `源码命令入口已迁移到隐藏目录：${hiddenLauncher}`);
  writeMessage(
    "note",
    '当前终端请执行：export PATH="$HOME/.codex-connect/.bin:$PATH"',
  );
}

function updateManagedShellPaths(environment) {
  const home = environment.HOME;
  if (!home) return;
  const oldLine = 'export PATH="$HOME/.codex-connect/bin:$PATH"';
  const newLine = 'export PATH="$HOME/.codex-connect/.bin:$PATH"';
  for (const profileName of [".zshrc", ".bashrc", ".profile"]) {
    const profile = join(home, profileName);
    if (!existsSync(profile)) continue;
    const content = readFileSync(profile, "utf8");
    if (!content.includes(oldLine)) continue;
    writeFileSync(profile, content.replaceAll(oldLine, newLine));
  }
}

function assertFastForward(checkout, currentCommit, targetCommit, environment) {
  const object = spawnSync(
    "git",
    ["cat-file", "-e", `${currentCommit}^{commit}`],
    { cwd: checkout, env: environment, encoding: "utf8" },
  );
  if (object.error) throw object.error;
  if (object.status !== 0) {
    throw new Error("当前源码包含官方 main 之外的提交，拒绝自动覆盖");
  }
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", currentCommit, targetCommit],
    { cwd: checkout, env: environment, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return;
  if (result.status === 1) {
    throw new Error("当前源码包含官方 main 之外的提交，拒绝自动覆盖");
  }
  throw new Error(`无法校验 main 提交关系：${result.stderr || result.stdout}`);
}

function resolveMainCommit(repository, checkout, environment, captureCommand) {
  const output = capture(
    "git",
    ["ls-remote", repository, "refs/heads/main"],
    checkout,
    environment,
    captureCommand,
  ).trim();
  const [commit, reference, ...extra] = output.split(/\s+/u);
  if (
    !commitPattern.test(commit ?? "")
    || reference !== "refs/heads/main"
    || extra.length > 0
  ) {
    throw new Error("无法解析官方 main 分支的唯一 commit");
  }
  return commit;
}

function assertManagedRepository(checkout, repository, environment, captureCommand) {
  const dirty = capture(
    "git",
    ["status", "--porcelain"],
    checkout,
    environment,
    captureCommand,
  ).trim();
  if (dirty) {
    throw new Error(`源码仓库存在未提交修改，拒绝自动更新：${checkout}`);
  }
  const origin = capture(
    "git",
    ["remote", "get-url", "origin"],
    checkout,
    environment,
    captureCommand,
  ).trim();
  if (origin !== repository) {
    throw new Error(`源码仓库 origin 不是官方地址，拒绝自动更新：${origin || "(缺失)"}`);
  }
}

function assertCodexVersion(expected, environment, captureCommand) {
  const executable = environment.CODEX_BINARY?.trim() || "codex";
  const output = capture(
    executable,
    ["--version"],
    process.cwd(),
    environment,
    captureCommand,
  ).trim();
  const actual = output.split(/\s+/u).at(-1)?.replace(/^v/u, "") ?? "";
  if (actual !== expected) {
    throw new Error(`Codex CLI 版本不匹配：需要 ${expected}，当前 ${actual || "未知"}`);
  }
}

async function buildCheckout(checkout, environment, options) {
  for (const [cwd, args] of [
    [checkout, ["ci", "--no-audit", "--no-fund"]],
    [checkout, ["run", "build"]],
    [checkout, ["run", "check"]],
    [join(checkout, "webui"), ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
    [join(checkout, "webui"), ["run", "build"]],
  ]) {
    runQuiet("npm", args, cwd, environment, options.runCommand);
  }
  if (
    !existsSync(join(checkout, "dist", "main.js"))
    || !existsSync(join(checkout, "webui", "dist", "index.html"))
  ) {
    throw new Error("候选源码构建结果不完整");
  }
}

function runQuiet(command, args, cwd, environment, implementation) {
  if (implementation) {
    implementation(command, args, { cwd, environment, quiet: true });
    return;
  }
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  throw new Error(`${command} 执行失败：exit=${result.status ?? 1}`);
}

async function inspectStagedInstallation(checkout, environment) {
  const moduleUrl = `${pathToFileURL(join(checkout, "scripts", "local-update.mjs")).href}?staged`;
  const staged = await import(moduleUrl);
  const config = staged.inspectGatewayConfiguration(environment);
  staged.inspectDatabaseUpdates(environment);
  const services = staged.inspectCoreServiceInstallation(environment);
  if (!services.installed && await gatewayOwnerIsActive(config.configPath)) {
    throw new Error(
      "核心后台服务未安装，但检测到前台 Gateway 正在运行；请先按 Ctrl-C 结束后再更新",
    );
  }
  return { config, services };
}

async function stopCoreServices(checkout, environment, options) {
  run(
    process.execPath,
    [join(checkout, "bin", "codexc.mjs"), "service", "stop", "all"],
    checkout,
    environment,
    options.runCommand,
  );
}

async function startCoreServices(checkout, environment, options) {
  run(
    process.execPath,
    [join(checkout, "bin", "codexc.mjs"), "service", "start", "all"],
    checkout,
    environment,
    options.runCommand,
  );
}

async function runLocalUpdate(checkout, environment, options) {
  run(
    process.execPath,
    [join(checkout, "scripts", "local-update.mjs")],
    checkout,
    environment,
    options.runCommand,
  );
}

function packageVersion(checkout) {
  const metadata = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  if (!stableVersionPattern.test(metadata.version ?? "")) {
    throw new Error("源码 package.json 缺少正式版本号");
  }
  return metadata.version;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function capture(command, args, cwd, environment, implementation, options = {}) {
  if (implementation) {
    return implementation(command, args, { cwd, environment, ...options });
  }
  const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.allowFailure) return "";
    throw new Error(`${command} 执行失败：${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function run(command, args, cwd, environment, implementation) {
  if (implementation) {
    implementation(command, args, { cwd, environment });
    return;
  }
  const result = spawnSync(command, args, { cwd, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败：exit=${result.status ?? 1}`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const checkout = managedSourceCheckout();
  if (!checkout) {
    await runLocalUpdate(packageDir, process.env, {});
    return;
  }
  const result = await updateManagedSourceInstallation(process.env, { projectDir: checkout });
  if (!result.changed) {
    writeCliMessage(
      "note",
      `Git 源码已是 main 最新提交 ${result.commit.slice(0, 12)}（版本 ${result.version}），跳过依赖安装与构建；继续检查本地配置和数据库。`,
    );
    await runLocalUpdate(checkout, process.env, {});
    return;
  }
  writeCliMessage(
    "success",
    `Git main 源码已更新到 ${result.commit.slice(0, 12)}（版本 ${result.version}），本地更新与服务恢复已完成。`,
  );
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    writeCliMessage("failure", errorMessage(error));
    process.exitCode = 1;
  }
}
