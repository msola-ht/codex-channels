import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { resolveExecutableInvocation } from "../runtime/executable.mjs";
import { ReportedChildExitError } from "../runtime/process-lifecycle.mjs";
import { withCliProgress, writeCliSection } from "./cli-operation-progress.mjs";
import { installCliLifecycleCancellation } from "./cli-lifecycle-command.mjs";
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
  // Finish the destructive action already in progress before honoring cancellation.
  const controller = new AbortController();
  const cancel = (signal) => controller.abort(new ReportedChildExitError(
    signal === "SIGINT" ? 130 : 143,
    "卸载已取消，当前操作已收尾；尚未处理的程序与用户数据已保留。",
  ));
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const cleanupCancellation = installCliLifecycleCancellation(cancel);
  try {
    writeCliSection("卸载准备");
    const targets = await withCliProgress("确认卸载身份与删除范围", async () => {
      controller.signal.throwIfAborted();
      return inspectInstallation(environment, options);
    });
    const { projectDir, checkout, expectedCheckout, packages } = targets;
    controller.signal.throwIfAborted();
    // The child owns service progress. Keep our cancellation handler installed
    // while it settles instead of letting the parent exit ahead of its work.
    await (options.uninstallServices ?? uninstallServices)(projectDir, environment);
    controller.signal.throwIfAborted();
    for (const installed of packages.values()) assertUnchangedPackage(installed);
    writeCliSection("删除程序");
    await withCliProgress("卸载全局命令与受管源码", async (progress) => {
      // Load presentation before deleting this package: no new script, worker or
      // optional dependency may need to be loaded after the current npm removal.
      const installations = [...packages.values()].sort((left, right) =>
        Number(left.directory === projectDir) - Number(right.directory === projectDir));
      for (const installed of installations) {
        controller.signal.throwIfAborted();
        progress.signal.throwIfAborted();
        assertUnchangedPackage(installed);
        const message = `卸载 npm 全局命令：${installed.prefix}`;
        progress.message(message);
        if (!progress.interactive) progress.log(`[进行中] ${message}`);
        if (options.uninstallGlobalPackage) {
          await options.uninstallGlobalPackage([installed.prefix], environment);
        } else {
          await uninstallGlobalPackage(installed.prefix, environment, progress);
        }
      }
      controller.signal.throwIfAborted();
      progress.signal.throwIfAborted();
      if (checkout) {
        const current = inspectManagedCheckout(expectedCheckout, checkout.directory, environment);
        assertSameDirectory(checkout, current);
        const message = `删除受管源码：${checkout.directory}`;
        progress.message(message);
        if (!progress.interactive) progress.log(`[进行中] ${message}`);
        await rm(checkout.directory, { recursive: true });
      }
      controller.signal.throwIfAborted();
    });
    return { checkout: checkout?.directory, prefixes: [...packages.values()].map((entry) => entry.prefix) };
  } catch (error) {
    if (controller.signal.aborted && error !== controller.signal.reason) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ReportedChildExitError(
        controller.signal.reason.exitCode,
        `${controller.signal.reason.message}\n当前操作结果：${detail}`,
      );
    }
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    cleanupCancellation();
  }
}

function inspectInstallation(environment, options) {
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

  return { projectDir, expectedCheckout, checkout, packages };
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

async function uninstallGlobalPackage(prefix, environment, progress) {
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
  const result = await runUninstallCommand(
    invocation.file,
    invocation.args,
    {
      env: environment,
      cwd: prefix,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    },
    progress,
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm 全局命令卸载失败：${prefix} · exit=${result.status ?? 1}`);
  }
  if (existsSync(join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@hegenai", "codexc"))) {
    throw new Error(`npm 全局包仍然存在，源码已保留：${prefix}`);
  }
}

async function uninstallServices(projectDir, environment) {
  const result = await runUninstallCommand(
    process.execPath,
    [join(projectDir, "bin", "codexc.mjs"), "uninstall", "--services"],
    { cwd: projectDir, env: environment },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`后台服务卸载失败：exit=${result.status ?? 1}`);
  }
}

function runUninstallCommand(command, args, options, progress) {
  return new Promise((resolveClose) => {
    const child = spawn(command, args, {
      ...options,
      stdio: progress ? ["ignore", "pipe", "pipe"] : "inherit",
      // Terminal interrupts must not cut npm off halfway through self-removal.
      // Keep awaiting close; only the next destructive action is cancelled.
      detached: progress !== undefined,
      windowsHide: true,
    });
    let failure;
    if (progress) {
      for (const stream of ["stdout", "stderr"]) {
        child[stream].setEncoding("utf8");
        child[stream].on("data", (chunk) => {
          progress.log(chunk, { stream });
          if (process[stream].writableNeedDrain) {
            child[stream].pause();
            process[stream].once("drain", () => child[stream].resume());
          }
        });
      }
    }
    child.once("error", (error) => { failure = error; });
    child.once("close", (status, signal) => resolveClose({
      status,
      error: failure ?? (signal ? new Error(`卸载子命令被信号终止：${signal}`) : undefined),
    }));
  });
}

async function main() {
  const result = await uninstallInstallation();
  writeCliMessage("success", result.checkout
    ? `受管 Git 源码与对应 npm 全局命令已删除：${result.checkout}`
    : "当前 npm 全局命令已卸载，源码工作树已保留。");
  writeCliSection("保留用户数据");
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
    process.exitCode = error?.exitCode ?? 1;
  }
}
