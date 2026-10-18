import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInstallationCommand } from "./installation-command.mjs";

/** Shared stages only; callers retain command cancellation and installation ownership. */
export async function buildSourceCheckout(checkout, { readIgnoreScripts, runStage }) {
  const ignoreScripts = (await readIgnoreScripts()).trim();
  if (ignoreScripts !== "true" && ignoreScripts !== "false") {
    throw new Error("无法确认 npm ignore-scripts 设置，拒绝构建源码");
  }
  const webui = join(checkout, "webui");
  for (const [label, cwd, args] of [
    ["安装 Gateway 依赖", checkout, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
    ...(ignoreScripts === "false" ? [["安装 Git hooks", checkout, ["run", "hooks:install"]]] : []),
    ["构建 Gateway", checkout, ["run", "build"]],
    ["检查 Gateway", checkout, ["run", "check"]],
    ["安装 WebUI 依赖", webui, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]],
    ["构建 WebUI", webui, ["run", "build"]],
  ]) {
    await runStage(label, args, cwd);
  }
  if ([join(checkout, "dist", "main.js"), join(webui, "dist", "index.html")]
    .some(path => !existsSync(path) || !statSync(path).isFile())) {
    throw new Error("源码构建结果不完整");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [npm = "npm", ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("用法：source-build.mjs [npm 可执行文件]");
  try {
    await buildSourceCheckout(process.cwd(), {
      readIgnoreScripts: async () => (await runInstallationCommand("读取 npm 构建设置", npm, ["config", "get", "ignore-scripts"], { captureStdout: true })).stdout,
      runStage: (label, args, cwd) => runInstallationCommand(label, npm, args, { cwd }),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "源码构建失败");
    process.exitCode = error?.exitCode ?? 1;
  }
}
