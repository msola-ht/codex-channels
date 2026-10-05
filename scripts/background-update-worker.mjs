import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  readActiveUpdate,
  readUpdateJob,
  readUpdateReceipt,
  releaseUpdate,
  withUpdateLock,
  writeUpdateReceipt,
} from "./background-update-state.mjs";
import { deployLocalSource, recoverLocalSource } from "./local-source-deployment.mjs";

const terminalStatuses = new Set(["succeeded", "failed"]);
const failedMessage = "本机源码后台部署失败；请查看任务阶段、日志和部署回执。";
const recoveryMessage = "本机源码后台部署恢复未完成；保留任务预约，需人工核查版本与服务状态。";

/** Check the real process identity before allowing any deployment or recovery. */
export function assertBackgroundUpdateWorkerIdentity(unitName, environment, platform, cgroup, recover = false) {
  if (platform !== "linux") throw new Error("本机源码后台部署 worker 仅支持 Linux/systemd");
  if (environment.CODEX_CONNECT_SERVICE_ROLE) {
    throw new Error("后台部署 worker 不得运行在 Gateway 或 App Server 服务进程环境中");
  }
  const expectedUnit = `${unitName}${recover ? "-rescue" : ""}.service`;
  const matches = cgroup.split("\n").some((line) => {
    const match = /^\d+:[^:]*:(\/.*)$/u.exec(line);
    return match?.[1].split("/").includes(expectedUnit) ?? false;
  });
  if (!matches) throw new Error("后台部署 worker 必须由对应的独立 systemd 用户服务启动");
}

export async function runBackgroundUpdateWorker(root, id, options = {}) {
  return withUpdateLock(root, async () => {
    const job = readUpdateJob(root, id);
    assertBackgroundUpdateWorkerIdentity(
      job.unitName,
      process.env,
      process.platform,
      process.platform === "linux" && !process.env.CODEX_CONNECT_SERVICE_ROLE
        ? readFileSync("/proc/self/cgroup", "utf8") : "",
      options.recover === true,
    );
    const previousReceipt = readUpdateReceipt(root, id);
    if (terminalStatuses.has(previousReceipt.status)) {
      if (readActiveUpdate(root) === id) releaseUpdate(root, id);
      return previousReceipt;
    }
    if (previousReceipt.status === "recovery-required" && !options.recover) {
      throw new Error("后台部署任务需要恢复，拒绝重复部署");
    }
    if (readActiveUpdate(root) !== id) throw new Error("后台部署任务与当前活动预约不匹配");

    let activeStage = options.recover ? "recover-deployment" : "start-worker";
    const persist = (status, stage, extra = {}) => {
      const receipt = {
        formatVersion: 1, id, updatedAt: new Date().toISOString(), status, stage, ...extra,
        ...(extra.result ? { result: publicResult(extra.result) } : {}),
      };
      writeUpdateReceipt(root, id, receipt);
      return receipt;
    };
    const context = {
      jobDirectory: join(root, id),
      sourceDirectory: join(root, id, "source"),
      runnerDirectory: join(root, id, "runner"),
      installedDirectory: job.installedDirectory,
      npmPrefix: job.npmPrefix,
      nodeBinary: job.nodeBinary,
      environment: job.environment,
      onProgress: async (stage, details) => {
        activeStage = stage;
        persist("running", stage);
        console.log(`${new Date().toISOString()} ${stage} ${details.status}`);
      },
    };
    persist("running", activeStage);
    if (!options.recover) {
      try {
        const result = await deployLocalSource(context);
        const receipt = persist("succeeded", "complete", { result });
        releaseUpdate(root, id);
        return receipt;
      } catch (error) {
        const failure = error?.localDeploymentFailure;
        console.error(failure?.summary ?? `本机源码后台部署失败，阶段：${failure?.stage ?? activeStage}`);
        if (failure) {
          const safe = ["not-needed", "restored"].includes(failure.recovery?.status);
          const receipt = persist(safe ? "failed" : "recovery-required", failure.stage, {
            error: failure.summary ?? (safe ? failedMessage : recoveryMessage),
            result: {
              restoredServices: failure.recovery.restoredServices,
              recovery: failure.recovery,
            },
          });
          if (safe) releaseUpdate(root, id);
          return receipt;
        }
        // Receipt failures and interrupted recovery are resolved from the durable journal.
      }
    }

    const failedStage = activeStage;
    try {
      const result = await recoverLocalSource(context);
      if (!["not-needed", "restored"].includes(result.recovery?.status)) {
        return persist("recovery-required", failedStage, { error: recoveryMessage, result });
      }
      const receipt = persist("failed", failedStage, { error: failedMessage, result });
      releaseUpdate(root, id);
      return receipt;
    } catch {
      console.error(`本机源码后台部署恢复失败，阶段：${failedStage}`);
      return persist("recovery-required", failedStage, { error: recoveryMessage });
    }
  });
}

function publicResult(result) {
  if (!result.recovery) return result;
  return {
    ...result,
    recovery: {
      ...result.recovery,
      // Raw subprocess and recovery exceptions never enter the public status receipt.
      errors: result.recovery.errors?.length ? ["服务恢复发生错误；请人工核查部署回执与版本状态。"] : [],
    },
  };
}

async function main(args) {
  if (args.length < 2 || args.length > 3 || (args.length === 3 && args[2] !== "--recover")) {
    throw new Error("用法：background-update-worker.mjs <任务根目录> <任务 UUID> [--recover]");
  }
  const receipt = await runBackgroundUpdateWorker(resolve(args[0]), args[1], { recover: args[2] === "--recover" });
  if (receipt.status !== "succeeded") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch {
    console.error("后台部署 worker 执行失败；请查看对应任务的状态和日志。");
    process.exitCode = 1;
  }
}
