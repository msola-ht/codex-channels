import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { packageDir } from "./package-path.mjs";
import { locateUserConfig } from "./runtime-config.mjs";
import { inferNpmGlobalPrefix } from "./source-install-metadata.mjs";
import { parseBackgroundUpdateArgs } from "./background-update-options.mjs";
import {
  updateRoot, createUpdateDirectory, writeUpdateJob, readUpdateJob,
  readUpdateReceipt, writeUpdateReceipt, listUpdateJobIds, readActiveUpdate,
  reserveUpdate, releaseUpdate, withUpdateLock, snapshotLocalSource, copyUpdateRunner,
} from "./background-update-state.mjs";

function systemd(args, environment) {
  const result = spawnSync(args[0], args.slice(1), {
    env: environment, encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576,
  });
  if (result.error || result.status !== 0) throw new Error(`后台更新的 ${args[0]} 操作失败`);
  return result.stdout.trim();
}

export function backgroundUpdateEnvironment(environment, nodeBinary, configPath) {
  const selected = {};
  for (const key of ["HOME", "CODEX_HOME", "CODEX_BINARY", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "CODEX_CONNECT_HOME"]) {
    if (environment[key]) selected[key] = environment[key];
  }
  selected.CODEX_CONNECT_CONFIG_FILE = configPath;
  selected.PATH = `${dirname(nodeBinary)}:/usr/local/bin:/usr/bin:/bin`;
  return selected;
}

export function backgroundUnitArguments(job, jobDirectory, recover = false) {
  const unit = `${job.unitName}${recover ? "-rescue" : ""}`;
  // systemd expands specifiers in property values, even without a shell.
  const log = join(jobDirectory, "deployment.log").replaceAll("%", "%%");
  const command = [job.nodeBinary, join(jobDirectory, "runner/scripts/background-update-worker.mjs"),
    dirname(jobDirectory), job.id, ...(recover ? ["--recover"] : [])]
    .map(value => value.replaceAll("$", () => "$$"));
  return [
    "systemd-run", "--user", "--quiet", `--unit=${unit}`,
    `--on-active=${recover ? "46min" : "10s"}`,
    "--timer-property=AccuracySec=1s", "--property=Type=oneshot",
    ...(recover ? [] : [`--property=OnFailure=${job.unitName}-rescue.service`]),
    `--property=TimeoutStartSec=${recover ? "15min" : "45min"}`,
    "--property=TimeoutStopSec=15s",
    "--property=KillMode=control-group", "--property=UMask=0077",
    `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`,
    ...Object.entries(job.environment).map(([key, value]) => `--setenv=${key}=${value}`),
    "--", ...command,
  ];
}

export async function submitBackgroundUpdate(sourceDirectory, environment = process.env, options = {}) {
  if ((options.platform ?? process.platform) !== "linux") throw new Error("后台本机部署仅支持 Linux/systemd 用户服务");
  const run = options.systemd ?? systemd;
  const installedDirectory = realpathSync(options.packageDirectory ?? packageDir);
  const npmPrefix = inferNpmGlobalPrefix(installedDirectory);
  if (!npmPrefix) throw new Error("请先从源码全局安装新版 codexc，再运行后台本机部署");
  const { configPath } = locateUserConfig(environment);
  const managerEnvironment = run(["systemctl", "--user", "show-environment"], environment);
  if (/^CODEX_CONNECT_SERVICE_ROLE=/mu.test(managerEnvironment)) {
    throw new Error("systemd 用户管理器含服务角色标记，不能安全创建独立更新任务");
  }
  const root = updateRoot(environment);
  return withUpdateLock(root, async () => {
    if (readActiveUpdate(root)) throw new Error("已有后台更新任务，请先查看 codexc update status");
    const id = randomUUID();
    const jobDirectory = createUpdateDirectory(root, id);
    const identity = snapshotLocalSource(sourceDirectory, join(jobDirectory, "source"));
    copyUpdateRunner(installedDirectory, join(jobDirectory, "runner"));
    const nodeBinary = realpathSync(options.nodeBinary ?? process.execPath);
    const job = {
      formatVersion: 1, id, createdAt: new Date().toISOString(),
      originalSourceDirectory: identity.sourcePath, sourceCommit: identity.sourceCommit,
      snapshotSha256: identity.snapshotSha256, installedDirectory, npmPrefix, nodeBinary,
      environment: backgroundUpdateEnvironment(environment, nodeBinary, configPath),
      unitName: `codexc-update-${id}`,
    };
    writeUpdateJob(root, job);
    writeFileSync(join(jobDirectory, "deployment.log"), "", { mode: 0o600, flag: "wx" });
    const receipt = { formatVersion: 1, id, updatedAt: new Date().toISOString(), status: "queued", stage: "queued" };
    writeUpdateReceipt(root, id, receipt);
    reserveUpdate(root, id);
    try {
      // Rescue must exist before the deployment can become runnable.
      run(backgroundUnitArguments(job, jobDirectory, true), environment);
      run(backgroundUnitArguments(job, jobDirectory), environment);
    } catch (error) {
      // A timed-out D-Bus call may already have created the main unit. Do not
      // release its reservation until systemd has confirmed it is stopped.
      let stopped = false;
      try {
        run(["systemctl", "--user", "stop", `${job.unitName}.timer`, `${job.unitName}.service`], environment);
        stopped = true;
      } catch { /* Rescue retains ownership when cancellation cannot be proved. */ }
      writeUpdateReceipt(root, id, {
        ...receipt, updatedAt: new Date().toISOString(),
        status: stopped ? "failed" : "recovery-required", stage: "submission-failed",
        error: "后台任务提交失败；请查看任务日志和 systemd 状态",
      });
      if (stopped) releaseUpdate(root, id);
      throw error;
    }
    return { ...receipt, jobDirectory };
  });
}

export function inspectBackgroundUpdate(taskId, environment = process.env, options = {}) {
  const root = updateRoot(environment);
  if (!existsSync(root)) throw new Error("尚无后台更新任务");
  const id = taskId ?? listUpdateJobIds(root).map((entry) => readUpdateJob(root, entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
  if (!id) throw new Error("尚无后台更新任务");
  const job = readUpdateJob(root, id);
  const receipt = readUpdateReceipt(root, id);
  let serviceState = "unknown";
  if (receipt.status === "queued" || receipt.status === "running" || receipt.status === "recovery-required") {
    try {
      serviceState = (options.systemd ?? systemd)([
        "systemctl", "--user", "show", `${job.unitName}.service`,
        "--property=ActiveState,SubState,Result", "--no-pager",
      ], environment);
    } catch { /* Receipt remains authoritative; unavailable systemd is explicit. */ }
  }
  return { ...receipt, jobDirectory: join(root, id), sourceDirectory: job.originalSourceDirectory, serviceState };
}

export async function runBackgroundUpdateCommand(args, environment = process.env) {
  const parsed = parseBackgroundUpdateArgs(args);
  if (parsed.kind === "submit") {
    const result = await submitBackgroundUpdate(parsed.sourceDirectory, environment);
    console.log(`后台部署已提交：${result.id}\n回执与日志：${result.jobDirectory}\n查询：codexc update status ${result.id}\n提交不代表部署完成；服务切换时当前会话可能短暂断开。`);
    return;
  }
  if (parsed.kind !== "status") throw new Error("后台更新命令参数无效");
  const result = inspectBackgroundUpdate(parsed.taskId, environment);
  if (parsed.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`任务：${result.id}\n状态：${result.status}\n阶段：${result.stage}\n更新时间：${result.updatedAt}\n回执与日志：${result.jobDirectory}${result.error ? `\n说明：${result.error}` : ""}${result.serviceState !== "unknown" ? `\nsystemd：${result.serviceState}` : ""}`);
}
