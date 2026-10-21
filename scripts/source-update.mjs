import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { gatewayOwnerIsActive } from "../runtime/gateway-owner.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { resolveExecutableInvocation, resolveOptionalExecutable } from "../runtime/executable.mjs";
import { packageDir } from "./package-path.mjs";
import { locateUserConfig, userDataDir } from "./runtime-config.mjs";
import {
  currentNpmGlobalPrefix,
  hasManagedSourceMarker,
  inferNpmGlobalPrefix,
  readInstalledSourceMetadata,
  readManagedNpmPrefixes,
  recordManagedSourceMetadata,
} from "./source-install-metadata.mjs";
import { createPrompter } from "./terminal-prompter.mjs";
import { serviceControlDefinitions, serviceDefinitionPath } from "./service-selection.mjs";
import { inspectManagedServiceStatusAsync } from "./service-status.mjs";
import { withPrivateFileLock } from "../runtime/private-file-lock.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import { serviceDefinitions } from "../runtime/service-targets.mjs";
import { registerChildProcessGroup, terminateChildProcess } from "../runtime/process-lifecycle.mjs";
import { withCliProgress, writeCliSection } from "./cli-operation-progress.mjs";
import { installCliLifecycleCancellation } from "./cli-lifecycle-command.mjs";
import { supervisedCliInvocation } from "./cli-command-worker.mjs";
import { formatCliMessage } from "../runtime/cli-presentation.mjs";
import { isGatewayVersionCompatible } from "./gateway-version-policy.mjs";
import { buildSourceCheckout } from "./source-build.mjs";

export { isGatewayVersionCompatible } from "./gateway-version-policy.mjs";

const officialRepository = "https://github.com/msola-ht/codex-channels.git";
const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-fix[1-9]\d*|-rc\.[1-9]\d*)?$/u;
const stableVersionPattern = /^\d+\.\d+\.\d+$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const codexVersionMismatchRemediations = new WeakMap();

export function managedSourceCheckout(environment = process.env, projectDir = packageDir) {
  const expected = join(userDataDir(environment), "codex-channels");
  const source = inferNpmGlobalPrefix(projectDir) ? readInstalledSourceMetadata(projectDir) : undefined;
  const checkoutExists = existsSync(expected);
  const canonicalCheckout = checkoutExists ? realpathSync(expected) : resolve(expected);
  if (source?.managed && !sameInstallationPath(source.checkout, canonicalCheckout)) {
    throw new Error("当前 npm 全局包的受管源码来源与用户目录不一致，拒绝更新；请核对安装来源和 CODEX_CONNECT_HOME");
  }
  if (!checkoutExists) {
    if (source?.managed) throw new Error("当前 npm 全局包的受管源码目录不存在，拒绝更新；请恢复源码目录或重新安装程序");
    return undefined;
  }
  if (!existsSync(join(expected, ".git"))) {
    if (source?.managed) throw new Error("当前 npm 全局包的受管源码目录不是 Git 仓库，拒绝更新");
    return undefined;
  }
  if (sameInstallationPath(canonicalCheckout, realpathSync(projectDir))) return expected;
  if (!source?.managed) return undefined;
  if (!hasManagedSourceMarker(expected, environment)) {
    throw new Error("当前 npm 全局包的源码来源缺少受管标记，拒绝更新");
  }
  return expected;
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
  const checkoutIdentity = sourceCheckoutIdentity(checkout);
  readManagedNpmPrefixes(checkout, environment);
  const npmPrefix = assertSourceUpdateInstallation(checkout, environment, options);
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
    checkoutIdentity,
    currentCommit,
    currentVersion,
    npmPrefix,
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
    const complete = async () => {
      const result = await operation();
      completedStages.push(stage);
      return result;
    };
    const result = stage === "prepare-codex-cli" || stage === "update-installation"
      ? await complete()
      : await runUpdateStage(options, stage, complete);
    return result;
  };
  let plan;
  try {
    plan = await runStage(
      "inspect",
      () => inspectSourceUpdatePlan(environment, options),
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
    if (!options.runStage) writeMessageSafely(writeMessage, "note", "正在克隆 Git main 候选源码。");
    await runStage("clone-candidate", async () => {
      stagingRoot = mkdtempSync(join(installRoot, ".codex-channels-update."));
      stagedCheckout = join(stagingRoot, "codex-channels");
      await runQuiet(
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
        options.getCommandSignal?.(),
      );
    });
    const candidate = await runStage("validate-candidate", async () => {
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
      const targetCommit = (await captureAsync(
        "git",
        ["rev-parse", "HEAD"],
        stagedCheckout,
        environment,
        options.captureCommand,
        options.getCommandSignal?.(),
      )).trim();
      if (targetCommit !== remoteCommit) {
        throw new Error("官方 main 在预检后发生变化，请重新运行 codexc update");
      }
      await assertFastForward(stagedCheckout, currentCommit, targetCommit, environment, options.getCommandSignal?.());
      if (!options.confirmCodexCliInstall) {
        await assertCodexVersionAsync(targetCodexVersion, environment, options.captureCommand, options.getCommandSignal?.());
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
    if (!options.runStage) writeMessageSafely(writeMessage, "note", "正在核对候选版本的 Codex 公开合同。");
    await runStage(
      "validate-codex-contract",
      async () => {
        await (options.validateCodexContract ?? validateCodexContract)(
          stagedCheckout,
          preparedCodex.validationEnvironment,
          options,
        );
        if (await inspectSourceInstallation(checkout, environment, options) !== plan.npmPrefix) {
          throw new Error("npm 全局目录在候选构建期间发生变化，拒绝更新；请重新运行 codexc update");
        }
        recordManagedSourceMetadata(stagedCheckout, [...readManagedNpmPrefixes(checkout, environment), plan.npmPrefix], environment);
        assertSourceCheckoutUnchanged(plan, repository, environment, options);
      },
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
    if (!options.runStage) writeMessageSafely(writeMessage, "note", "候选源码已通过校验，准备切换。");
    const proposedBackupPath = `${checkout}.pre-update-${Date.now()}`;
    await runStage("switch-source", () => {
      assertSourceCheckoutUnchanged(plan, repository, environment, options);
      if (existsSync(proposedBackupPath)) throw new Error("旧源码备份路径已存在，拒绝覆盖");
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
      // Editors may still hold descriptors into the renamed tree. No snapshot
      // can prove that deleting it is safe after the final check.
      writeMessageSafely(writeMessage, "note", `旧源码已保留：${backupPath}。确认没有待保留修改且旧目录已无人使用后，可手动清理；更新不会自动删除旧源码副本。`);
    });
    return {
      changed: true,
      commit: candidate.targetCommit,
      managed: true,
      previousVersion: currentVersion,
      version: candidate.targetVersion,
      backupPath,
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
        await runUpdateStage(options, "restore-services", () =>
          (options.startServices ?? startCoreServices)(checkout, environment, options, servicesBeforeUpdate), true);
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
  const pending = [error];
  const seen = new Set();
  const messages = new Set();
  const remediations = new Set();
  while (pending.length > 0 && seen.size < 12) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const message = errorMessage(current);
    if (!messages.has(message)) {
      writeMessage("failure", current === error ? message : `关联原因：${message}`);
      messages.add(message);
    }
    for (const remediation of getCodexVersionMismatchRemediation(current)) {
      if (!remediations.has(remediation)) writeMessage("remediation", remediation);
      remediations.add(remediation);
    }
    if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 12));
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
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
  await (options.installGlobalPackage ?? installGlobalPackage)(checkout, environment, options);

  writeMessageSafely(
    writeMessage,
    "note",
    "源码命令已刷新到 npm 全局安装。",
  );
}

async function installGlobalPackage(checkout, environment, options) {
  await runQuiet(
    process.execPath,
    [join(checkout, "scripts", "install-global-source.mjs"), "--prepared"],
    checkout,
    environment,
    options.runCommand,
  );
}

function assertSourceUpdateInstallation(checkout, environment, options, prefix = currentNpmGlobalPrefix(environment)) {
  const canonicalPrefix = existsSync(prefix) ? realpathSync(prefix) : resolve(prefix);
  const activePrefix = inferNpmGlobalPrefix(packageDir);
  if (activePrefix && !sameInstallationPath(activePrefix, canonicalPrefix)) {
    throw new Error("当前 codexc 所属 npm 全局目录与当前 npm prefix 不一致；请切回原 Node.js/npm 环境后运行 codexc update。更新不会自动重装后台服务");
  }
  const globalPackage = join(canonicalPrefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@hegenai", "codexc");
  const cliEntries = [join(realpathSync(checkout), "bin", "codexc.mjs"), join(globalPackage, "bin", "codexc.mjs")];
  const platform = { linux: "systemd", darwin: "launchd", win32: "windows" }[process.platform];
  if (!platform) throw new Error("codexc update 当前支持 macOS launchd、Linux systemd 与 Windows 计划任务");
  const definitionsDirectory = platform === "windows" ? join(locateUserConfig(environment).dataDir, "services") : undefined;
  for (const definition of serviceDefinitions) {
    const path = serviceDefinitionPath(platform, definition, environment, definitionsDirectory);
    const command = definition.target === "app-server" ? "service-app-server"
      : definition.target === "model-relay" ? "service-model-relay" : definition.target;
    let matches;
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("服务定义不是普通文件");
      if (platform === "systemd") {
        const starts = readFileSync(path, "utf8").split(/\r?\n/u).filter(line => /^\s*ExecStart\s*=/u.test(line));
        const nodeArgument = starts.length === 1 ? /^ExecStart=("(?:\\.|[^"\\])*") /u.exec(starts[0])?.[1] : undefined;
        matches = nodeArgument !== undefined && cliEntries.some(entry =>
          starts[0] === `ExecStart=${nodeArgument} --disable-warning=ExperimentalWarning ${systemdArgument(entry)} ${command}`);
      } else {
        const value = platform === "launchd"
          ? JSON.parse(capture("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", path], checkout, environment, options.captureCommand))
          : JSON.parse(readPrivateFileSync(path, 1024 * 1024));
        const args = platform === "launchd" ? value : value.arguments;
        matches = Array.isArray(args) && args.length === 3 + Number(platform === "launchd")
          && args[Number(platform === "launchd")] === "--disable-warning=ExperimentalWarning"
          && args[args.length - 1] === command
          && cliEntries.some(entry => sameInstallationPath(args[args.length - 2], entry));
        if (platform === "windows" && matches) {
          const projectDir = dirname(dirname(args[args.length - 2]));
          matches = value.version === 1 && value.target === definition.target
            && sameInstallationPath(value.launcherPath, join(projectDir, "scripts", "windows-service-launcher.ps1"))
            && sameInstallationPath(value.serviceHost, join(projectDir, "scripts", "windows-service-host.mjs"));
        }
      }
    } catch {
      throw new Error(`${definition.displayName} 服务定义无法安全读取或解析，拒绝更新；请检查定义权限与格式，按源码安装文档运行 codexc install 重建服务定义。尚未停止服务或替换程序`);
    }
    if (!matches) {
      throw new Error(`${definition.displayName} 服务定义使用的程序路径不在本次更新范围内，拒绝更新；请切回原 Node.js/npm 环境，或按源码安装文档手动安装程序并运行 codexc install 重建服务定义。尚未停止服务或替换程序`);
    }
  }
  return prefix;
}

function sameInstallationPath(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !isAbsolute(left) || !isAbsolute(right)) return false;
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function systemdArgument(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

async function assertFastForward(checkout, currentCommit, targetCommit, environment, signal) {
  const object = await executeUpdateCommand("git", ["cat-file", "-e", `${currentCommit}^{commit}`], checkout, environment, signal);
  if (object.status !== 0) {
    throw new Error("当前源码包含官方 main 之外的提交，拒绝自动覆盖");
  }
  const result = await executeUpdateCommand("git", ["merge-base", "--is-ancestor", currentCommit, targetCommit], checkout, environment, signal);
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

function sourceCheckoutIdentity(checkout) {
  const stat = lstatSync(checkout);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("受管源码目录类型已变化，拒绝更新");
  return { path: realpathSync(checkout), dev: stat.dev, ino: stat.ino };
}

function assertSourceCheckoutUnchanged(plan, repository, environment, options) {
  if (JSON.stringify(sourceCheckoutIdentity(plan.checkout)) !== JSON.stringify(plan.checkoutIdentity)) {
    throw new Error("受管源码目录身份在预检后发生变化，拒绝切换");
  }
  assertManagedRepository(plan.checkout, repository, environment, options.captureCommand);
  const head = capture("git", ["rev-parse", "HEAD"], plan.checkout, environment, options.captureCommand).trim();
  if (head !== plan.currentCommit) throw new Error("受管源码 HEAD 在预检后发生变化，拒绝切换");
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
  const actual = await installedCodexVersionAsync(environment, options.captureCommand, expected, options.getCommandSignal?.());
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
    binary = await runUpdateStage(options, "prepare-codex-cli", () =>
      (options.installCodexCliForValidation ?? installCodexCliForValidation)(
        expected, checkout, environment, options,
      ));
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw codexValidationInstallFailureError(expected, error);
  }
  const validationEnvironment = { ...environment, CODEX_BINARY: binary };
  const installed = await installedCodexVersionAsync(
    validationEnvironment,
    options.captureCommand,
    expected,
    options.getCommandSignal?.(),
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
  const installed = await installedCodexVersionAsync(environment, options.captureCommand, expected);
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

async function installedCodexVersionAsync(environment, captureCommand, expected, signal) {
  if (captureCommand) return installedCodexVersion(environment, captureCommand, expected);
  const executable = environment.CODEX_BINARY?.trim() || "codex";
  if (!resolveOptionalExecutable(executable, environment)) {
    return installedCodexVersion(environment, undefined, expected);
  }
  try {
    const output = await captureAsync(executable, ["--version"], process.cwd(), environment, undefined, signal);
    return installedCodexVersion(environment, () => output, expected);
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    return installedCodexVersion(environment, () => { throw cause; }, expected);
  }
}

async function assertCodexVersionAsync(expected, environment, captureCommand, signal) {
  const actual = await installedCodexVersionAsync(environment, captureCommand, expected, signal);
  if (actual !== expected) throw codexVersionMismatchError(expected, actual);
}

export async function validateCodexContract(checkout, environment, options) {
  await captureAsync(
    process.execPath,
    [
      join(checkout, "scripts", "codex-public-cli-contract.mjs"),
      "--check-user-settings",
    ],
    checkout,
    environment,
    options.captureCommand,
    options.getCommandSignal?.(),
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

async function installCodexCliForValidation(
  version, checkout, environment, options,
  prefix = join(resolve(checkout, ".."), "codex-cli-contract"),
) {
  await runQuiet(
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
    options.getCommandSignal?.(),
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

async function installCodexCli(version, checkout, environment, options) {
  await runQuiet(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "-g", "--include=optional", `@openai/codex@${version}`],
    checkout,
    environment,
    options.runCommand,
  );
}

export async function buildCheckout(checkout, environment, options) {
  await buildSourceCheckout(checkout, {
    readIgnoreScripts: () => captureAsync("npm", ["config", "get", "ignore-scripts"], checkout, environment, options.captureCommand, options.getCommandSignal?.()),
    runStage: (_label, args, cwd) => runQuiet("npm", args, cwd, environment, options.runCommand, options.getCommandSignal?.()),
  });
}

async function runQuiet(command, args, cwd, environment, implementation, signal) {
  signal?.throwIfAborted();
  if (implementation) {
    await implementation(command, args, { cwd, environment, quiet: true });
    return;
  }
  const result = await executeUpdateCommand(command, args, cwd, environment, signal);
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

async function disableCandidateDaemonAutoStart(checkout, environment, options) {
  await runQuiet(process.execPath, [
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
    await runCheckoutService(checkout, "stop", target, environment, options);
  }
}

async function inspectUpdateServices(environment) {
  const services = (await inspectManagedServiceStatusAsync({ environment, target: "all" })).services;
  for (const service of services) {
    if (!service.running && !["inactive", "inactive/dead", "not-found", "missing", "not-loaded", "stopped", "disabled", "ready"].includes(service.state)) {
      throw new Error(`无法确认更新前 ${service.target} 运行状态；未停止服务`);
    }
  }
  return services;
}

async function startCoreServices(checkout, environment, options, services) {
  // A failed CLI/package switch must not restart services against an unverified installation.
  await assertCodexVersionAsync(codexVersion(checkout), environment, options.captureCommand);
  await (options.inspectStaged ?? inspectStagedInstallation)(checkout, environment);
  const platform = process.platform === "linux" ? "systemd" : process.platform === "darwin" ? "launchd" : "windows";
  // 恢复范围沿用同一份启动选择：关闭的 WebUI 与未启用的 Relay 不再被重新拉起。
  const restartable = new Set(
    serviceControlDefinitions(platform, "all", "start", environment).map(service => service.target),
  );
  const targets = ["app-server", "gateway", "model-relay", "webui"].filter(target =>
    services.find(service => service.target === target)?.running
    && restartable.has(target));
  for (const target of targets) await runCheckoutService(checkout, "start", target, environment, options);
}

async function runCheckoutService(checkout, action, target, environment, options) {
  // Load both the command and its target mapping from the active checkout in a fresh process.
  // The updater itself can still be running code loaded before the source switch.
  await runQuiet(process.execPath, [
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

async function captureAsync(command, args, cwd, environment, implementation, signal) {
  if (implementation) return implementation(command, args, { cwd, environment });
  const result = await executeUpdateCommand(command, args, cwd, environment, signal);
  if (result.truncated) throw new Error(`${command} 输出超过限制，拒绝解析不完整结果`);
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败：${result.stderr || result.stdout || `exit=${result.status ?? 1}`}`);
  }
  return result.stdout;
}

async function executeUpdateCommand(command, args, cwd, environment, signal) {
  signal?.throwIfAborted();
  const supervised = signal !== undefined && process.platform !== "win32";
  const resolved = resolveExecutableInvocation(command, args, environment);
  const invocation = supervised ? supervisedCliInvocation(resolved) : resolved;
  let cleanup;
  let cleanupError;
  let abort;
  try {
    const result = await new Promise((resolveResult, reject) => {
    // Only disposable preparation commands receive a cancellation signal.
    // A supervisor retains the Unix group until descendants release their pipes.
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (supervised) registerChildProcessGroup(child);
    abort = () => {
      cleanup ??= terminateChildProcess(child).catch(error => {
        cleanupError = error;
        child.unref();
      }).finally(() => {
        // A failed termination cannot depend on a future close event from the
        // process that did not stop. Release local pipes and report uncertainty.
        child.stdout.destroy();
        child.stderr.destroy();
        finish(child.exitCode, child.signalCode);
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const limit = 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdoutBytes += Buffer.byteLength(chunk);
      stdoutTruncated ||= stdoutBytes > limit;
      stdout = (stdout + chunk).slice(-limit);
    });
    child.stderr.on("data", chunk => {
      stderrBytes += Buffer.byteLength(chunk);
      stderrTruncated ||= stderrBytes > limit;
      stderr = (stderr + chunk).slice(-limit);
    });
    child.once("error", reject);
    const finish = (status, signal) => resolveResult({
      status, signal,
      stdout: `${stdoutTruncated ? "[日志超长，仅保留末尾内容]\n" : ""}${stdout}`,
      stderr: `${stderrTruncated ? "[日志超长，仅保留末尾内容]\n" : ""}${stderr}`,
      truncated: stdoutTruncated || stderrTruncated,
    });
    child.once("close", finish);
    });
    await cleanup;
    if (cleanupError) {
      const diagnostic = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      throw Object.assign(new Error(`更新命令子进程终止未获确认${diagnostic ? `\n命令输出：\n${diagnostic}` : ""}`, { cause: cleanupError }), {
        exitCode: signal?.reason?.exitCode ?? 1,
      });
    }
    if (signal?.aborted) {
      const diagnostic = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      if (diagnostic) {
        throw Object.assign(new Error(`${signal.reason.message}\n命令结束状态：${result.signal ? `signal=${result.signal}` : `exit=${result.status ?? 1}`}\n命令输出：\n${diagnostic}`, { cause: signal.reason }), {
          name: "AbortError", exitCode: signal.reason.exitCode,
        });
      }
      throw signal.reason;
    }
    return result;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    await cleanup;
  }
}

async function inspectSourceUpdatePlan(environment, options) {
  if (options.captureCommand) return inspectManagedSourceUpdatePlan(environment, options);
  const output = await captureAsync(process.execPath, [
    "--input-type=module", "--eval",
    "try { const source = await import(process.argv[1]); "
      + "process.stdout.write(JSON.stringify(source.inspectManagedSourceUpdatePlan(process.env, JSON.parse(process.argv[2])))); "
      + "} catch (error) { process.stderr.write(error.message); process.exitCode = 1; }",
    import.meta.url,
    JSON.stringify({ projectDir: options.projectDir, repository: options.repository }),
  ], options.projectDir ?? packageDir, environment, undefined, options.getCommandSignal?.());
  return JSON.parse(output);
}

async function inspectSourceInstallation(checkout, environment, options) {
  const prefix = (await captureAsync("npm", ["prefix", "--global"], checkout, environment, undefined, options.getCommandSignal?.())).trim();
  if (!isAbsolute(prefix) || dirname(prefix) === prefix) throw new Error("无法解析 npm 全局目录");
  return assertSourceUpdateInstallation(checkout, environment, options, prefix);
}

function runUpdateStage(options, stage, operation, recovery = false) {
  return options.runStage ? options.runStage(stage, operation, { recovery }) : operation();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function updateInstalledPackage(environment = process.env, options = {}) {
  assertSourceUpdateCaller(environment);
  const checkout = options.projectDir ?? packageDir;
  const expected = codexVersion(checkout);
  const writeMessage = options.writeMessage ?? writeCliMessage;
  if (!options.runStage) writeMessageSafely(writeMessage, "note", "正在检查配套 Codex CLI、当前配置和数据库结构。");
  const inspection = await runUpdateStage(options, "inspect-candidate", () =>
    (options.inspectStaged ?? inspectStagedInstallation)(checkout, environment));
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
    await runUpdateStage(options, "validate-codex-contract", () =>
      (options.validateCodexContract ?? validateCodexContract)(checkout, prepared.validationEnvironment, options));
    if (prepared.installRequired && inspection.services.installed) {
      servicesBeforeUpdate = await (options.inspectServices ?? inspectUpdateServices)(environment);
      servicesStopped = true;
      await runUpdateStage(options, "stop-services", () =>
        (options.stopServices ?? stopCoreServices)(checkout, environment, options, servicesBeforeUpdate));
    }
    await runUpdateStage(options, "install-codex-cli", () =>
      installPreparedCodexVersion(prepared, expected, checkout, environment, writeMessage, options));
    await runUpdateStage(options, "configure-codex-daemon", () =>
      disableCandidateDaemonAutoStart(checkout, environment, options));
    if (servicesStopped) {
      await runUpdateStage(options, "restore-services", () =>
        (options.startServices ?? startCoreServices)(checkout, environment, options, servicesBeforeUpdate));
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
        await runUpdateStage(options, "restore-services", () =>
          (options.startServices ?? startCoreServices)(checkout, environment, options, servicesBeforeUpdate), true);
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
  const controller = new AbortController();
  const cancel = signal => controller.abort(Object.assign(new Error("程序更新已取消"), {
    name: "AbortError", exitCode: signal === "SIGINT" ? 130 : 143,
  }));
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  // Keep handling cancellation while recovery is running between progress stages.
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const cleanupCancellation = installCliLifecycleCancellation(cancel);
  let activeProgress;
  let currentSection;
  let switching = false;
  const completedCliStages = new Set();
  const finishCancellation = () => {
    if (!controller.signal.aborted) return;
    const work = result?.changed ? "源码与全局命令已更新" : "配套 CLI 与安装状态检查已完成";
    const services = completedCliStages.has("restore-services")
      ? "服务已按更新前运行状态恢复"
      : "本次未停止后台服务";
    throw Object.assign(new Error(`已收到取消请求；${work}，${services}，更新已安全收尾。`), {
      name: "AbortError", exitCode: controller.signal.reason.exitCode,
    });
  };
  const stages = {
    inspect: ["检查", "检查受管源码与更新目标"],
    "clone-candidate": ["准备更新", "克隆 main 候选源码"],
    "validate-candidate": ["准备更新", "校验候选源码版本与提交关系"],
    "build-candidate": ["准备更新", "构建并检查候选源码"],
    "inspect-candidate": ["检查", "检查当前配置、数据库与服务安装状态"],
    "prepare-codex-cli": ["准备更新", "准备配套 Codex CLI 候选环境"],
    "validate-codex-contract": ["准备更新", "校验 Codex CLI 公开合同"],
    "stop-services": ["切换安装", "按原运行状态停止后台服务"],
    "install-codex-cli": ["切换安装", "同步配套 Codex CLI"],
    "switch-source": ["切换安装", "切换候选源码"],
    "refresh-command": ["切换安装", "刷新 npm 全局命令"],
    "configure-codex-daemon": ["切换安装", "配置 Codex daemon 自动启动偏好"],
    "restore-services": ["恢复服务", "按原运行状态恢复后台服务"],
    cleanup: ["完成", "清理本次更新临时文件"],
  };
  try {
    const options = {
      getCommandSignal: () => switching ? undefined : controller.signal,
      runStage: async (stage, operation, { recovery }) => {
        if (!recovery && !switching) controller.signal.throwIfAborted();
        if (["stop-services", "install-codex-cli", "switch-source"].includes(stage)) switching = true;
        const [category, label] = stages[stage];
        const section = stage === "inspect-candidate" && currentSection === "准备更新" ? currentSection : category;
        if (section !== currentSection) {
          writeCliSection(recovery ? "失败收尾 · 恢复服务" : section);
          currentSection = section;
        }
        let settled = false;
        let value;
        try {
          return await withCliProgress(label, async progress => {
            activeProgress = progress;
            value = await operation();
            settled = true;
            completedCliStages.add(stage);
            if (!recovery && !switching) controller.signal.throwIfAborted();
            return value;
          });
        } catch (error) {
          if ((recovery || switching) && settled && controller.signal.aborted) return value;
          throw error;
        } finally {
          activeProgress = undefined;
        }
      },
      writeMessage: (kind, message) => {
        if (activeProgress && kind === "note") activeProgress.message(message);
        else if (activeProgress) activeProgress.log(formatCliMessage(kind, message), {
          stream: kind === "failure" ? "stderr" : "stdout",
        });
        else writeCliMessage(kind, message);
      },
      runCommand: async (command, args, { cwd, environment }) => {
        const child = await executeUpdateCommand(command, args, cwd, environment, switching ? undefined : controller.signal);
        if (child.status === 0) return;
        const log = (text, stream) => activeProgress
          ? activeProgress.log(text, { stream })
          : process[stream].write(text);
        if (child.stdout) log(child.stdout, "stdout");
        if (child.stderr) log(child.stderr, "stderr");
        throw new Error(`${command} 执行失败：${child.signal ? `signal=${child.signal}` : `exit=${child.status ?? 1}`}`);
      },
      ...(prompter
        ? {
            confirmCodexCliInstall: ({ currentVersion, requiredVersion }) =>
              prompter.confirm(
                `Codex CLI 版本不匹配（需要 ${requiredVersion}，当前 ${currentVersion ?? "未知"}），是否现在安装？`,
                true,
                { signal: controller.signal },
              ),
          }
        : {}),
    };
    if (!checkout) {
      await updateInstalledPackage(process.env, options);
      finishCancellation();
      return;
    }
    result = await updateManagedSourceInstallation(process.env, { ...options, projectDir: checkout });
    finishCancellation();
  } finally {
    prompter?.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    cleanupCancellation();
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
    process.exitCode = error?.exitCode ?? 1;
  }
}
