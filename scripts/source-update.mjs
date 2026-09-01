import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parse } from "smol-toml";

import { codexHomePath } from "../runtime/codex-home.mjs";
import { gatewayOwnerIsActive } from "../runtime/gateway-owner.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { packageDir } from "./package-path.mjs";
import { userDataDir } from "./runtime-config.mjs";
import {
  currentNpmGlobalPrefix,
  inferNpmGlobalPrefix,
  recordManagedSourceMetadata,
} from "./source-install-metadata.mjs";
import { removeLegacySourceShellPaths } from "./source-shell-path.mjs";
import { createPrompter } from "./terminal-prompter.mjs";

const officialRepository = "https://github.com/msola-ht/codex-channels.git";
const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-fix[1-9]\d*|-rc\.[1-9]\d*)?$/u;
const stableVersionPattern = /^\d+\.\d+\.\d+$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const codexVersionMismatchRemediations = new WeakMap();

export function managedSourceCheckout(environment = process.env, projectDir = packageDir) {
  const expected = join(userDataDir(environment), "codex-channels");
  if (!existsSync(expected) || !existsSync(join(expected, ".git"))) return undefined;
  if (realpathSync(expected) === realpathSync(projectDir)) return expected;
  return hasManagedSourceMarker(expected, environment) ? expected : undefined;
}

export function inspectManagedSourceUpdatePlan(
  environment = process.env,
  options = {},
) {
  assertSourceUpdateCaller(environment);
  const checkout = options.projectDir ?? managedSourceCheckout(environment);
  if (!checkout) {
    return withSourceUpdateRevision({
      operation: "source-update",
      managed: false,
      steps: ["inspect"],
    });
  }
  const repository = options.repository ?? officialRepository;
  assertManagedRepository(checkout, repository, environment, options.captureCommand);
  const targetCommit = resolveMainCommit(
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
  const updateAvailable = currentCommit !== targetCommit;
  const refreshCommand = !updateAvailable
    && hasManagedSourceLauncher(resolve(checkout, ".."));
  return withSourceUpdateRevision({
    operation: "source-update",
    managed: true,
    checkout,
    currentCommit,
    currentVersion,
    targetCommit,
    updateAvailable,
    refreshCommand,
    steps: [
      "inspect",
      ...(updateAvailable
        ? [
            "clone-candidate",
            "validate-candidate",
            "build-candidate",
            "inspect-candidate",
            "prepare-codex-cli",
            "validate-codex-contract",
            "install-codex-cli",
            "stop-services",
            "switch-source",
            "refresh-command",
            "local-update",
            "cleanup",
          ]
        : [
            "validate-codex-contract",
            ...(refreshCommand ? ["refresh-command"] : []),
          ]),
    ],
  });
}

export async function updateManagedSourceInstallation(
  environment = process.env,
  options = {},
) {
  const completedStages = [];
  let activeStage = "inspect";
  const runStage = async (stage, operation) => {
    activeStage = stage;
    emitSourceUpdateProgress(options, stage, "started", completedStages);
    try {
      const result = await operation();
      completedStages.push(stage);
      emitSourceUpdateProgress(options, stage, "completed", completedStages);
      return result;
    } catch (error) {
      emitSourceUpdateProgress(options, stage, "failed", completedStages);
      throw error;
    }
  };
  let plan;
  try {
    plan = await runStage(
      "inspect",
      () => {
        const current = inspectManagedSourceUpdatePlan(environment, options);
        assertSourceUpdateRevision(options.expectedRevision, current.revision);
        return current;
      },
    );
  } catch (error) {
    throw annotateSourceUpdateFailure(error, {
      stage: activeStage,
      completedStages,
      recovery: { services: "not-needed", source: "unchanged" },
      recommendation: "重新检查源码安装状态后重试更新",
    });
  }
  if (!plan.managed) return { changed: false, managed: false };
  const checkout = plan.checkout;
  const repository = options.repository ?? officialRepository;
  const remoteCommit = plan.targetCommit;
  const currentCommit = plan.currentCommit;
  const currentVersion = plan.currentVersion;
  const writeMessage = options.writeMessage ?? writeCliMessage;
  writeMessageSafely(
    writeMessage,
    "note",
    `Git 源码检查：当前 ${currentCommit.slice(0, 12)} · main ${remoteCommit.slice(0, 12)}`,
  );
  const installRoot = resolve(checkout, "..");
  if (currentCommit === remoteCommit) {
    try {
      writeMessageSafely(writeMessage, "note", "正在核对 Codex 公开合同和用户设置。");
      await runStage(
        "validate-codex-contract",
        () => (options.validateCodexContract ?? validateCodexContract)(
          checkout,
          environment,
          options,
        ),
      );
      writeCodexPlanSettingNotice(writeMessage, environment);
      if (plan.refreshCommand) {
        await runStage(
          "refresh-command",
          () => installManagedSourceCommand(
            checkout,
            installRoot,
            environment,
            writeMessage,
            options,
          ),
        );
      }
    } catch (error) {
      throw annotateSourceUpdateFailure(error, {
        stage: activeStage,
        completedStages,
        recovery: { services: "not-needed", source: "unchanged" },
        recommendation: "按错误提示修复 Codex CLI 合同、用户设置或全局命令后重新运行 codexc update",
      });
    }
    return { changed: false, commit: currentCommit, managed: true, version: currentVersion };
  }

  let stagingRoot;
  let stagedCheckout;
  let switched = false;
  let servicesMayNeedRestore = false;
  let servicesRestored = false;
  let backupPath;
  const renamePath = options.renamePath ?? renameSync;
  try {
    writeMessageSafely(writeMessage, "note", "正在克隆 Git main 候选源码。");
    await runStage("clone-candidate", () => {
      stagingRoot = mkdtempSync(join(installRoot, ".codex-channels-update."));
      stagedCheckout = join(stagingRoot, "codex-channels");
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
    });
    const candidate = await runStage("validate-candidate", () => {
      const targetVersion = packageVersion(stagedCheckout);
      const targetCodexVersion = codexVersion(stagedCheckout);
      if (!isGatewayVersionCompatible(targetVersion, targetCodexVersion)) {
        throw new Error(
          `Gateway 与 Codex CLI 基础版本不匹配：gateway=${targetVersion}，codex=${targetCodexVersion}`,
        );
      }
      if (compareVersions(targetVersion, currentVersion) < 0) {
        throw new Error(`拒绝降级源码安装：当前 ${currentVersion}，main 为 ${targetVersion}`);
      }
      const targetCommit = capture(
        "git",
        ["rev-parse", "HEAD"],
        stagedCheckout,
        environment,
        options.captureCommand,
      ).trim();
      if (targetCommit !== remoteCommit) {
        throw new Error("官方 main 在预检后发生变化，请重新运行 codexc update");
      }
      assertFastForward(stagedCheckout, currentCommit, targetCommit, environment);
      if (!options.confirmCodexCliInstall) {
        assertCodexVersion(targetCodexVersion, environment, options.captureCommand);
      }
      return { targetCodexVersion, targetCommit, targetVersion };
    });
    writeMessageSafely(
      writeMessage,
      "note",
      "正在构建并预检候选源码；详细日志仅在失败时显示。",
    );
    await runStage(
      "build-candidate",
      () => (options.buildCheckout ?? buildCheckout)(stagedCheckout, environment, options),
    );
    const inspection = await runStage(
      "inspect-candidate",
      () => (options.inspectStaged ?? inspectStagedInstallation)(stagedCheckout, environment),
    );
    notifySafely(options.onPrepared, withSourceUpdateRevision({
      ...plan,
      steps: inspection.services.installed
        ? plan.steps
        : plan.steps.filter((stage) => stage !== "stop-services"),
      services: inspection.services,
      requiresServiceInterruption: inspection.services.installed,
      targetVersion: candidate.targetVersion,
    }));
    const preparedCodex = await runStage(
      "prepare-codex-cli",
      () => prepareCodexVersion(
        candidate.targetCodexVersion,
        stagedCheckout,
        environment,
        writeMessage,
        options,
      ),
    );
    writeMessageSafely(writeMessage, "note", "正在核对候选版本的 Codex 公开合同。");
    await runStage(
      "validate-codex-contract",
      () => (options.validateCodexContract ?? validateCodexContract)(
        stagedCheckout,
        preparedCodex.validationEnvironment,
        options,
      ),
    );
    writeCodexPlanSettingNotice(writeMessage, preparedCodex.validationEnvironment);
    await runStage(
      "install-codex-cli",
      () => installPreparedCodexVersion(
        preparedCodex,
        candidate.targetCodexVersion,
        stagedCheckout,
        environment,
        writeMessage,
        options,
      ),
    );
    writeMessageSafely(writeMessage, "note", "候选源码已通过校验，准备切换。");
    if (inspection.services.installed) {
      servicesMayNeedRestore = true;
      await runStage(
        "stop-services",
        () => (options.stopServices ?? stopCoreServices)(checkout, environment, options),
      );
    }

    const proposedBackupPath = `${checkout}.pre-update-${Date.now()}`;
    await runStage("switch-source", () => {
      renamePath(checkout, proposedBackupPath);
      backupPath = proposedBackupPath;
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
    });

    await runStage(
      "refresh-command",
      () => installManagedSourceCommand(
        checkout,
        installRoot,
        environment,
        writeMessage,
        options,
      ),
    );
    await runStage(
      "local-update",
      () => (options.runLocalUpdate ?? runLocalUpdate)(checkout, environment, options),
    );
    await runStage("cleanup", () => {
      rmSync(backupPath, { recursive: true, force: true });
      backupPath = undefined;
    });
    return {
      changed: true,
      commit: candidate.targetCommit,
      managed: true,
      previousVersion: currentVersion,
      version: candidate.targetVersion,
    };
  } catch (error) {
    let updateError = error;
    if (switched && backupPath) {
      updateError = new Error(
        `main 源码已切换，但本地更新未完成；旧源码保留在 ${backupPath}。${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (servicesMayNeedRestore) {
      try {
        await (options.startServices ?? startCoreServices)(checkout, environment, options);
        servicesRestored = true;
      } catch (startError) {
        const combinedError = new AggregateError(
          [updateError, startError],
          switched
            ? "源码已切换但本地更新失败，且核心服务未能恢复运行"
            : "源码更新失败，且原核心服务未能恢复运行",
          { cause: startError },
        );
        throw annotateSourceUpdateFailure(combinedError, {
          stage: activeStage,
          completedStages,
          recovery: {
            services: "failed",
            source: sourceRecoveryStatus(switched, backupPath),
            ...(backupPath ? { backupPath } : {}),
          },
          recommendation: switched
            ? "检查保留的旧源码并手动恢复核心服务"
            : "修复核心服务后运行 codexc service start all",
        });
      }
    }
    throw annotateSourceUpdateFailure(updateError, {
      stage: activeStage,
      completedStages,
      recovery: {
        services: servicesMayNeedRestore
          ? servicesRestored ? "restored" : "unknown"
          : "not-needed",
        source: sourceRecoveryStatus(switched, backupPath),
        ...(backupPath ? { backupPath } : {}),
      },
      recommendation: switched
        ? "检查保留的旧源码后重新运行 codexc update"
        : "修复失败原因后重新运行 codexc update",
    });
  } finally {
    if (stagingRoot && existsSync(stagingRoot)) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
}

export function getSourceUpdateFailure(error) {
  return error instanceof Error && error.sourceUpdateFailure
    ? error.sourceUpdateFailure
    : undefined;
}

export function getCodexVersionMismatchRemediation(error) {
  return error instanceof Error
    ? [...(codexVersionMismatchRemediations.get(error) ?? [])]
    : [];
}

export function writeSourceUpdateFailure(error, writeMessage = writeCliMessage) {
  writeMessage("failure", errorMessage(error));
  for (const remediation of getCodexVersionMismatchRemediation(error)) {
    writeMessage("remediation", remediation);
  }
}

function assertSourceUpdateCaller(environment) {
  if (
    environment.CODEX_CONNECT_SERVICE_ROLE === "app-server"
    || environment.CODEX_CONNECT_SERVICE_ROLE === "gateway"
  ) {
    throw new Error("不能在运行中的 Codex 服务内执行更新；请在本机终端运行 codexc update");
  }
}

function withSourceUpdateRevision(plan) {
  const document = { ...plan };
  Reflect.deleteProperty(document, "revision");
  return {
    ...document,
    revision: createHash("sha256")
      .update(JSON.stringify(document))
      .digest("hex"),
  };
}

function assertSourceUpdateRevision(expected, current) {
  if (expected === undefined) return;
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/u.test(expected)) {
    throw new Error("源码更新计划修订值无效");
  }
  if (expected !== current) {
    throw new Error("源码更新预检状态已变化，请重新生成更新计划");
  }
}

function emitSourceUpdateProgress(options, stage, status, completedStages) {
  notifySafely(options.onProgress, {
    operation: "source-update",
    stage,
    status,
    completedStages: [...completedStages],
  });
}

function notifySafely(observer, value) {
  if (!observer) return;
  try {
    observer(value);
  } catch {
    // 观察者不属于更新事务，不能改变更新结果。
  }
}

function writeMessageSafely(writeMessage, kind, message) {
  try {
    writeMessage(kind, message);
  } catch {
    // 命令行展示失败不能改变源码更新事务。
  }
}

function sourceRecoveryStatus(switched, backupPath) {
  if (switched) return backupPath ? "switched-backup-retained" : "switched";
  return backupPath ? "restore-failed" : "unchanged";
}

function annotateSourceUpdateFailure(error, details) {
  const target = error instanceof Error ? error : new Error(String(error));
  if (!target.sourceUpdateFailure) {
    Object.defineProperty(target, "sourceUpdateFailure", {
      configurable: false,
      enumerable: true,
      value: {
        operation: "source-update",
        code: "source-update-failed",
        stage: details.stage,
        completedStages: [...details.completedStages],
        recovery: details.recovery,
        recommendation: details.recommendation,
      },
      writable: false,
    });
  }
  return target;
}

function hasManagedSourceLauncher(installRoot) {
  return [join(installRoot, "bin", "codexc"), join(installRoot, ".bin", "codexc")]
    .some((launcher) => existsSync(launcher));
}

async function installManagedSourceCommand(
  checkout,
  installRoot,
  environment,
  writeMessage,
  options,
) {
  const legacyDirectory = join(installRoot, "bin");
  const legacyLauncher = join(legacyDirectory, "codexc");
  const hiddenDirectory = join(installRoot, ".bin");
  const hiddenLauncher = join(hiddenDirectory, "codexc");
  for (const launcher of [legacyLauncher, hiddenLauncher]) {
    if (!existsSync(launcher)) continue;
    const launcherStat = lstatSync(launcher);
    const launcherContent = launcherStat.isFile() && !launcherStat.isSymbolicLink()
      ? readFileSync(launcher, "utf8")
      : "";
    if (!launcherContent.includes('"$CODEX_CONNECT_HOME/codex-channels/bin/codexc.mjs"')) {
      throw new Error(`旧命令入口不属于受管源码安装，拒绝迁移：${launcher}`);
    }
  }

  markManagedSourceCheckout(checkout, environment);
  await (options.installGlobalPackage ?? installGlobalPackage)(checkout, environment, options);

  for (const launcher of [legacyLauncher, hiddenLauncher]) {
    if (!existsSync(launcher)) continue;
    rmSync(launcher);
  }
  for (const directory of [legacyDirectory, hiddenDirectory]) {
    if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
  }
  removeLegacySourceShellPaths(environment);
  writeMessageSafely(
    writeMessage,
    "note",
    "源码命令已刷新到 npm 全局安装，并清理旧 PATH 入口。",
  );
}

function installGlobalPackage(checkout, environment, options) {
  runQuiet(
    process.execPath,
    [join(checkout, "scripts", "install-global-source.mjs"), "--prepared"],
    checkout,
    environment,
    options.runCommand,
  );
}

function markManagedSourceCheckout(checkout, environment) {
  recordManagedSourceMetadata(
    checkout,
    [currentNpmGlobalPrefix(environment), inferNpmGlobalPrefix(packageDir)],
    environment,
  );
}

function hasManagedSourceMarker(checkout, environment) {
  const result = spawnSync(
    "git",
    ["config", "--local", "--get", "codex-connect.managed-source"],
    { cwd: checkout, env: environment, encoding: "utf8" },
  );
  return !result.error && result.status === 0 && result.stdout.trim() === "true";
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
    throw new Error(`源码仓库 origin 不是官方地址，拒绝自动更新：${origin ? "已配置其他地址" : "缺失"}`);
  }
}

async function prepareCodexVersion(expected, checkout, environment, writeMessage, options) {
  const actual = installedCodexVersion(environment, options.captureCommand);
  if (actual === expected) {
    return { installRequired: false, validationEnvironment: environment };
  }
  const failure = codexVersionMismatchError(expected, actual);
  if (!options.confirmCodexCliInstall) throw failure;
  const confirmed = await options.confirmCodexCliInstall({
    currentVersion: actual || undefined,
    requiredVersion: expected,
  });
  if (!confirmed) throw failure;
  writeMessageSafely(
    writeMessage,
    "note",
    `正在准备 @openai/codex@${expected} 临时候选环境。`,
  );
  let binary;
  try {
    binary = await (
      options.installCodexCliForValidation ?? installCodexCliForValidation
    )(
      expected,
      checkout,
      environment,
      options,
    );
  } catch (error) {
    throw codexValidationInstallFailureError(expected, error);
  }
  const validationEnvironment = { ...environment, CODEX_BINARY: binary };
  const installed = installedCodexVersion(
    validationEnvironment,
    options.captureCommand,
  );
  if (installed !== expected) {
    throw codexVersionMismatchError(expected, installed);
  }
  return { installRequired: true, validationEnvironment };
}

async function installPreparedCodexVersion(
  prepared,
  expected,
  checkout,
  environment,
  writeMessage,
  options,
) {
  if (!prepared.installRequired) return;
  writeMessageSafely(
    writeMessage,
    "note",
    `候选合同已通过，正在全局安装 @openai/codex@${expected}。`,
  );
  try {
    await (options.installCodexCli ?? installCodexCli)(
      expected,
      checkout,
      environment,
      options,
    );
  } catch (error) {
    throw codexInstallFailureError(expected, error);
  }
  const installed = installedCodexVersion(environment, options.captureCommand);
  if (installed !== expected) {
    throw codexVersionMismatchError(expected, installed);
  }
  writeMessageSafely(
    writeMessage,
    "success",
    `Codex CLI ${expected} 已安装，继续源码更新。`,
  );
}

function assertCodexVersion(expected, environment, captureCommand) {
  const actual = installedCodexVersion(environment, captureCommand);
  if (actual !== expected) throw codexVersionMismatchError(expected, actual);
}

function validateCodexContract(checkout, environment, options) {
  capture(
    process.execPath,
    [
      join(checkout, "scripts", "codex-public-cli-contract.mjs"),
      "--check-user-settings",
    ],
    checkout,
    environment,
    options.captureCommand,
  );
}

function writeCodexPlanSettingNotice(writeMessage, environment) {
  const status = readCodexPlanSetting(environment);
  if (status.error) {
    writeMessageSafely(writeMessage, "note", `Codex 计划清单工具：无法读取（${status.error}）`);
    return;
  }
  writeMessageSafely(
    writeMessage,
    "note",
    `Codex 计划清单工具：${status.enabled ? "开启" : "关闭（默认）"}`
      + "；可在 codexc setup → Codex 新会话默认值中修改",
  );
}

function readCodexPlanSetting(environment) {
  const path = join(codexHomePath(environment), "config.toml");
  if (!existsSync(path)) return { enabled: false };
  try {
    const document = parse(readFileSync(path, "utf8"));
    const tools = document?.tools;
    const updatePlan = tools && typeof tools === "object" && !Array.isArray(tools)
      ? tools.update_plan
      : undefined;
    const enabled = updatePlan
      && typeof updatePlan === "object"
      && !Array.isArray(updatePlan)
      && updatePlan.enabled === true;
    return { enabled };
  } catch {
    return { enabled: false, error: "Codex 用户配置无法解析" };
  }
}

function installedCodexVersion(environment, captureCommand) {
  const executable = environment.CODEX_BINARY?.trim() || "codex";
  const output = capture(
    executable,
    ["--version"],
    process.cwd(),
    environment,
    captureCommand,
  ).trim();
  return output.split(/\s+/u).at(-1)?.replace(/^v/u, "") ?? "";
}

function codexVersionMismatchError(expected, actual) {
  const error = new Error(
    `Codex CLI 版本不匹配：需要 ${expected}，当前 ${actual || "未知"}`,
  );
  codexVersionMismatchRemediations.set(error, [
    `npm install -g @openai/codex@${expected}`,
    "安装完成后重新运行 codexc update",
  ]);
  return error;
}

function codexInstallFailureError(expected, cause) {
  const error = new Error(
    `Codex CLI ${expected} 安装失败：${errorMessage(cause)}`,
    { cause },
  );
  codexVersionMismatchRemediations.set(error, [
    `npm install -g @openai/codex@${expected}`,
    "安装完成后重新运行 codexc update",
  ]);
  return error;
}

function codexValidationInstallFailureError(expected, cause) {
  return new Error(
    `Codex CLI ${expected} 临时候选环境准备失败：${errorMessage(cause)}`,
    { cause },
  );
}

function installCodexCliForValidation(version, checkout, environment, options) {
  const prefix = join(resolve(checkout, ".."), "codex-cli-contract");
  run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      `@openai/codex@${version}`,
    ],
    checkout,
    environment,
    options.runCommand,
  );
  const binary = join(
    prefix,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  if (!existsSync(binary)) {
    throw new Error(`临时候选 Codex CLI 缺少可执行文件：${binary}`);
  }
  return binary;
}

function installCodexCli(version, checkout, environment, options) {
  run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "-g", `@openai/codex@${version}`],
    checkout,
    environment,
    options.runCommand,
  );
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
  const invocation = resolveExecutableInvocation(command, args, environment);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
  if (!releaseVersionPattern.test(metadata.version ?? "")) {
    throw new Error("源码 package.json 缺少正式版本、rc 预发行版或 fix 修复版本号");
  }
  return metadata.version;
}

function codexVersion(checkout) {
  const metadata = JSON.parse(
    readFileSync(join(checkout, "src", "codex-protocol", "version.json"), "utf8"),
  );
  const value = typeof metadata.codexCli === "string"
    ? metadata.codexCli.replace(/^codex-cli /u, "")
    : "";
  if (!stableVersionPattern.test(value)) {
    throw new Error("源码协议元数据缺少正式 Codex CLI 版本");
  }
  return value;
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 5; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function versionParts(value) {
  const [stable, suffix] = value.split("-", 2);
  const stage = suffix?.startsWith("rc.") ? 0 : suffix?.startsWith("fix") ? 2 : 1;
  const sequence = suffix?.startsWith("rc.")
    ? Number(suffix.slice(3))
    : suffix?.startsWith("fix") ? Number(suffix.slice(3)) : 0;
  return [...stable.split(".").map(Number), stage, sequence];
}

function isGatewayVersionCompatible(gatewayVersion, expectedCodexVersion) {
  return gatewayVersion === expectedCodexVersion
    || new RegExp(
      `^${escapeRegExp(expectedCodexVersion)}-(?:fix[1-9]\\d*|rc\\.[1-9]\\d*)$`,
      "u",
    )
      .test(gatewayVersion);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function capture(command, args, cwd, environment, implementation, options = {}) {
  if (implementation) {
    return implementation(command, args, { cwd, environment, ...options });
  }
  const invocation = resolveExecutableInvocation(command, args, environment);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    env: environment,
    encoding: "utf8",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
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
  const invocation = resolveExecutableInvocation(command, args, environment);
  const result = spawnSync(invocation.file, invocation.args, {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
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
    validateCodexContract(packageDir, process.env, {});
    await runLocalUpdate(packageDir, process.env, {});
    return;
  }
  const prompter = process.stdin.isTTY && process.stdout.isTTY
    ? createPrompter(process.stdin, process.stdout)
    : undefined;
  let result;
  try {
    result = await updateManagedSourceInstallation(process.env, {
      projectDir: checkout,
      ...(prompter
        ? {
            confirmCodexCliInstall: ({ currentVersion, requiredVersion }) =>
              prompter.confirm(
                `Codex CLI 版本不匹配（需要 ${requiredVersion}，当前 ${currentVersion ?? "未知"}），是否现在安装？`,
                true,
              ),
          }
        : {}),
    });
  } finally {
    prompter?.close();
  }
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
    writeSourceUpdateFailure(error);
    process.exitCode = 1;
  }
}
