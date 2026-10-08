import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { gatewayOwnerIsActive } from "../runtime/gateway-owner.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { resolveExecutableInvocation, resolveOptionalExecutable } from "../runtime/executable.mjs";
import { packageDir } from "./package-path.mjs";
import { userDataDir } from "./runtime-config.mjs";
import {
  currentNpmGlobalPrefix,
  inferNpmGlobalPrefix,
  recordManagedSourceMetadata,
} from "./source-install-metadata.mjs";
import { createPrompter } from "./terminal-prompter.mjs";
import { serviceControlDefinitions } from "./service-selection.mjs";
import { inspectManagedServiceStatus } from "./service-status.mjs";
import { withPrivateFileLock } from "../runtime/private-file-lock.mjs";

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
    return {
      operation: "source-update",
      managed: false,
      steps: ["inspect"],
    };
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
  return {
    operation: "source-update",
    managed: true,
    checkout,
    currentCommit,
    currentVersion,
    targetCommit,
    updateAvailable,
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
            "stop-services",
            "install-codex-cli",
            "switch-source",
            "refresh-command",
            "configure-codex-daemon",
            "restore-services",
            "cleanup",
          ]
        : ["update-installation"]),
    ],
  };
}

export async function updateManagedSourceInstallation(
  environment = process.env,
  options = {},
) {
  const completedStages = [];
  let activeStage = "inspect";
  const runStage = async (stage, operation) => {
    activeStage = stage;
    const result = await operation();
    completedStages.push(stage);
    return result;
  };
  let plan;
  try {
    plan = await runStage(
      "inspect",
      () => inspectManagedSourceUpdatePlan(environment, options),
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
      await runStage("update-installation", () => updateInstalledPackage(environment, {
        ...options,
        projectDir: checkout,
      }));
    } catch (error) {
      throw annotateSourceUpdateFailure(error, {
        stage: activeStage,
        completedStages,
        recovery: { services: "unknown", source: "unchanged" },
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
  let servicesBeforeUpdate = [];
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
          "-c", "core.longpaths=true",
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
    if (inspection.services.installed) {
      servicesBeforeUpdate = await (options.inspectServices ?? inspectUpdateServices)(environment);
      servicesMayNeedRestore = true;
      await runStage(
        "stop-services",
        () => (options.stopServices ?? stopCoreServices)(checkout, environment, options, servicesBeforeUpdate),
      );
    }
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
        environment,
        writeMessage,
        options,
      ),
    );
    await runStage("configure-codex-daemon", () =>
      disableCandidateDaemonAutoStart(checkout, environment, options));
    if (inspection.services.installed) {
      await runStage("restore-services", () =>
        (options.startServices ?? startCoreServices)(checkout, environment, options, servicesBeforeUpdate));
      servicesMayNeedRestore = false;
    }
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
        `main 源码已切换，但更新未完成；旧源码保留在 ${backupPath}。${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (servicesMayNeedRestore) {
      try {
        if (switched && !completedStages.includes("refresh-command")) {
          throw new Error("全局程序安装未完成，保留服务停止状态；请从保留的源码完成 npm run install:global 后按原状态启动服务", { cause: error });
        }
        await (options.startServices ?? startCoreServices)(checkout, environment, options, servicesBeforeUpdate);
        servicesRestored = true;
      } catch (startError) {
        const combinedError = new AggregateError(
          [updateError, startError],
          switched
            ? "源码已切换但更新失败，且核心服务未能恢复运行"
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
            ? "核对源码与全局程序安装，完成 npm run install:global 后按原运行状态恢复服务"
            : "修复失败原因并核对 CLI 版本后，按原运行状态恢复服务",
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

async function installManagedSourceCommand(
  checkout,
  environment,
  writeMessage,
  options,
) {
  markManagedSourceCheckout(checkout, environment);
  await (options.installGlobalPackage ?? installGlobalPackage)(checkout, environment, options);

  writeMessageSafely(
    writeMessage,
    "note",
    "源码命令已刷新到 npm 全局安装。",
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
  const actual = installedCodexVersion(environment, options.captureCommand, expected);
  if (actual === expected) {
    return { installRequired: false, validationEnvironment: environment };
  }
  const failure = codexVersionMismatchError(expected, actual);
  if (environment.CODEX_BINARY?.trim() && environment.CODEX_BINARY.trim() !== "codex") {
    throw new Error(`CODEX_BINARY 版本不匹配：需要 ${expected}，当前 ${actual || "未知"}；请更新指定二进制后重试`, { cause: failure });
  }
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
    expected,
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
  const installed = installedCodexVersion(environment, options.captureCommand, expected);
  if (installed !== expected) {
    throw codexVersionMismatchError(expected, installed);
  }
  writeMessageSafely(
    writeMessage,
    "success",
    `Codex CLI ${expected} 已安装，继续源码更新。`,
  );
}

export function assertCodexVersion(expected, environment, captureCommand) {
  const actual = installedCodexVersion(environment, captureCommand, expected);
  if (actual !== expected) throw codexVersionMismatchError(expected, actual);
}

export function validateCodexContract(checkout, environment, options) {
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

function installedCodexVersion(environment, captureCommand, expected) {
  const configured = environment.CODEX_BINARY?.trim();
  const executable = configured || "codex";
  if (!captureCommand && !resolveOptionalExecutable(executable, environment)) {
    if (configured && configured !== "codex") throw new Error("CODEX_BINARY 指定的可执行文件不存在，请修正后重新运行 codexc update");
    return "";
  }
  let output;
  try {
    output = capture(executable, ["--version"], process.cwd(), environment, captureCommand).trim();
  } catch (cause) {
    const missingPackage = /Missing optional dependency (@openai\/codex-(?:darwin|linux|win32)-(?:arm64|x64))\b/u.exec(errorMessage(cause))?.[1];
    const error = new Error(missingPackage
      ? `Codex CLI 缺少平台原生依赖 ${missingPackage}，无法执行版本检查；这不是版本号不匹配`
      : "Codex CLI 无法执行版本检查；请检查可执行文件与安装完整性");
    codexVersionMismatchRemediations.set(error, configured && configured !== "codex"
      ? ["CODEX_BINARY 指向的 CLI 由操作者管理，请修复该安装后重新运行 codexc update"]
      : [`npm install -g --include=optional @openai/codex@${expected}`, "确认 codex --version 输出锁定版本后重新运行 codexc update"]);
    throw error;
  }
  return output.split(/\s+/u).at(-1)?.replace(/^v/u, "") ?? "";
}

function codexVersionMismatchError(expected, actual) {
  const error = new Error(
    `Codex CLI 版本不匹配：需要 ${expected}，当前 ${actual || "未知"}`,
  );
  codexVersionMismatchRemediations.set(error, [
    `npm install -g --include=optional @openai/codex@${expected}`,
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
    `npm install -g --include=optional @openai/codex@${expected}`,
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

function installCodexCliForValidation(
  version, checkout, environment, options,
  prefix = join(resolve(checkout, ".."), "codex-cli-contract"),
) {
  run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--no-save",
      "--no-package-lock",
      "--include=optional",
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
    ["install", "-g", "--include=optional", `@openai/codex@${version}`],
    checkout,
    environment,
    options.runCommand,
  );
}

export async function buildCheckout(checkout, environment, options) {
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
  const moduleUrl = `${pathToFileURL(join(checkout, "scripts", "local-installation.mjs")).href}?staged`;
  const staged = await import(moduleUrl);
  const config = staged.inspectGatewayConfiguration(environment);
  staged.inspectDatabases(environment);
  const services = staged.inspectCoreServiceInstallation(environment);
  if (!services.installed && await gatewayOwnerIsActive(config.configPath)) {
    throw new Error(
      "核心后台服务未安装，但检测到前台 Gateway 正在运行；请先按 Ctrl-C 结束后再更新",
    );
  }
  return { config, services };
}

function disableCandidateDaemonAutoStart(checkout, environment, options) {
  run(process.execPath, [
    "--input-type=module",
    "--eval",
    "const candidate = await import(process.argv[1]); await candidate.disableCodexDaemonAutoStart(process.env);",
    pathToFileURL(join(checkout, "scripts", "codex-user-config.mjs")).href,
  ], checkout, environment, options.runCommand);
  writeMessageSafely(options.writeMessage ?? writeCliMessage, "note",
    "已关闭 Codex 原生 daemon 自动启动；现有后台不受影响，项目服务继续由 codexc 管理。");
}

async function stopCoreServices(checkout, environment, options, services) {
  for (const target of ["webui", "model-relay", "gateway", "app-server"]) {
    if (!services.find(service => service.target === target)?.running) continue;
    runCheckoutService(checkout, "stop", target, environment, options);
  }
}

function inspectUpdateServices(environment) {
  const services = inspectManagedServiceStatus({ environment, target: "all" }).services;
  for (const service of services) {
    if (!service.running && !["inactive", "inactive/dead", "not-found", "missing", "not-loaded", "stopped", "disabled", "ready"].includes(service.state)) {
      throw new Error(`无法确认更新前 ${service.target} 运行状态；未停止服务`);
    }
  }
  return services;
}

async function startCoreServices(checkout, environment, options, services) {
  // A failed CLI/package switch must not restart services against an unverified installation.
  assertCodexVersion(codexVersion(checkout), environment, options.captureCommand);
  await (options.inspectStaged ?? inspectStagedInstallation)(checkout, environment);
  const platform = process.platform === "linux" ? "systemd" : process.platform === "darwin" ? "launchd" : "windows";
  const targets = ["app-server", "gateway", "model-relay", "webui"].filter(target =>
    services.find(service => service.target === target)?.running
    && (target !== "model-relay" || serviceControlDefinitions(platform, "all", "start", environment).some(service => service.target === target)));
  for (const target of targets) runCheckoutService(checkout, "start", target, environment, options);
}

function runCheckoutService(checkout, action, target, environment, options) {
  // Load both the command and its target mapping from the active checkout in a fresh process.
  // The updater itself can still be running code loaded before the source switch.
  run(process.execPath, [
    "--input-type=module", "--eval",
    "const { runServiceCommand } = await import(process.argv[1]); "
      + "const { serviceCommandTarget } = await import(process.argv[2]); "
      + "await runServiceCommand([process.argv[3], serviceCommandTarget(process.argv[4])]);",
    pathToFileURL(join(checkout, "scripts", "service-command.mjs")).href,
    pathToFileURL(join(checkout, "runtime", "service-targets.mjs")).href,
    action, target,
  ], checkout, environment, options.runCommand);
}

export function packageVersion(checkout) {
  const metadata = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  if (!releaseVersionPattern.test(metadata.version ?? "")) {
    throw new Error("源码 package.json 缺少正式版本、rc 预发行版或 fix 修复版本号");
  }
  return metadata.version;
}

export function codexVersion(checkout) {
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

export function isGatewayVersionCompatible(gatewayVersion, expectedCodexVersion) {
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

export async function updateInstalledPackage(environment = process.env, options = {}) {
  assertSourceUpdateCaller(environment);
  const checkout = options.projectDir ?? packageDir;
  const expected = codexVersion(checkout);
  const writeMessage = options.writeMessage ?? writeCliMessage;
  writeMessageSafely(writeMessage, "note", "正在检查配套 Codex CLI、当前配置和数据库结构。");
  const inspection = await (options.inspectStaged ?? inspectStagedInstallation)(checkout, environment);
  let temporaryDirectory;
  let servicesStopped = false;
  let servicesBeforeUpdate = [];
  try {
    const prepared = await prepareCodexVersion(expected, checkout, environment, writeMessage, {
      ...options,
      installCodexCliForValidation: options.installCodexCliForValidation
        ?? ((version, directory, validationEnvironment, validationOptions) => {
          temporaryDirectory = mkdtempSync(join(tmpdir(), "codexc-cli-update-"));
          return installCodexCliForValidation(
            version, directory, validationEnvironment, validationOptions, temporaryDirectory,
          );
        }),
    });
    await (options.validateCodexContract ?? validateCodexContract)(
      checkout, prepared.validationEnvironment, options,
    );
    if (prepared.installRequired && inspection.services.installed) {
      servicesBeforeUpdate = await (options.inspectServices ?? inspectUpdateServices)(environment);
      servicesStopped = true;
      await (options.stopServices ?? stopCoreServices)(checkout, environment, options, servicesBeforeUpdate);
    }
    await installPreparedCodexVersion(prepared, expected, checkout, environment, writeMessage, options);
    disableCandidateDaemonAutoStart(checkout, environment, options);
    if (servicesStopped) {
      await (options.startServices ?? startCoreServices)(checkout, environment, options, servicesBeforeUpdate);
      servicesStopped = false;
    }
    writeMessageSafely(
      writeMessage,
      "success",
      prepared.installRequired
        ? `配套 Codex CLI ${expected} 更新已完成。`
        : `检查完成：配套 Codex CLI ${expected} 无需更新，数据库结构有效。`,
    );
  } catch (error) {
    if (servicesStopped) {
      try {
        await (options.startServices ?? startCoreServices)(checkout, environment, options, servicesBeforeUpdate);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "配套 CLI 更新失败，且核心服务恢复失败", { cause: restoreError });
      }
    }
    throw error;
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const checkout = managedSourceCheckout();
  const prompter = process.stdin.isTTY && process.stdout.isTTY
    ? createPrompter(process.stdin, process.stdout)
    : undefined;
  let result;
  try {
    const options = {
      ...(prompter
        ? {
            confirmCodexCliInstall: ({ currentVersion, requiredVersion }) =>
              prompter.confirm(
                `Codex CLI 版本不匹配（需要 ${requiredVersion}，当前 ${currentVersion ?? "未知"}），是否现在安装？`,
                true,
              ),
          }
        : {}),
    };
    if (!checkout) {
      await updateInstalledPackage(process.env, options);
      return;
    }
    result = await updateManagedSourceInstallation(process.env, { ...options, projectDir: checkout });
  } finally {
    prompter?.close();
  }
  if (!result.changed) {
    writeCliMessage(
      "note",
      `Git 源码已是 main 最新提交 ${result.commit.slice(0, 12)}（版本 ${result.version}），配套 CLI 版本与安装状态检查已完成。`,
    );
    return;
  }
  writeCliMessage(
    "success",
    `Git main 源码已更新到 ${result.commit.slice(0, 12)}（版本 ${result.version}），服务恢复已完成。`,
  );
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    assertSourceUpdateCaller(process.env);
    await withPrivateFileLock(join(userDataDir(process.env), ".source-update"), main, { label: "程序更新" });
  } catch (error) {
    writeSourceUpdateFailure(error);
    process.exitCode = 1;
  }
}
