import { isCommandHelp } from "./cli-help.mjs";

export const BACKGROUND_UPDATE_USAGE = `用法：codexc update
      codexc update --background --source <目录>
      codexc update status [task-id] [--json]

无参数保留本机终端的交互更新流程。
--background --source 提交本机源码快照的后台部署，仅支持 Linux systemd 用户服务。
提交成功只表示任务已接收；使用 status 查看执行阶段和最终结果。
-h, --help 显示本帮助。`;

export const BACKGROUND_UPDATE_STATUS_USAGE = `用法：codexc update status [task-id] [--json]

只读查看后台部署任务；task-id 为提交返回的 UUID，省略时查看最新任务。
--json 输出结构化状态。查询不初始化用户配置或修改路径权限。
-h, --help 显示本帮助。`;

/** Parse the public update grammar without reading configuration or filesystem state. */
export function parseBackgroundUpdateArgs(args) {
  if (isCommandHelp(args, [[], ["status"]], BACKGROUND_UPDATE_USAGE)) {
    return { kind: "help", topic: args[0] === "status" ? "status" : "update" };
  }
  if (args.length === 0) return { kind: "interactive" };
  if (args[0] === "status") return parseStatus(args.slice(1));

  let background = false;
  let sourceDirectory;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--background") {
      if (background) throw new Error("--background 不得重复");
      background = true;
      continue;
    }
    if (argument === "--source") {
      if (sourceDirectory !== undefined) throw new Error("--source 不得重复");
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-") || value.trim() === "") {
        throw new Error("--source 缺少目录值");
      }
      sourceDirectory = value;
      index += 1;
      continue;
    }
    throw new Error(`未知更新参数：${argument}\n${BACKGROUND_UPDATE_USAGE}`);
  }
  if (!background || sourceDirectory === undefined) {
    throw new Error(`后台部署必须同时指定 --background 和 --source <目录>\n${BACKGROUND_UPDATE_USAGE}`);
  }
  return { kind: "submit", sourceDirectory };
}

function parseStatus(args) {
  let taskId;
  let json = false;
  for (const argument of args) {
    if (argument === "--json" && !json) {
      json = true;
      continue;
    }
    if (taskId === undefined && !json && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(argument)) {
      taskId = argument.toLowerCase();
      continue;
    }
    throw new Error(`无效任务状态参数：${argument}\n${BACKGROUND_UPDATE_STATUS_USAGE}`);
  }
  return { kind: "status", taskId, json };
}
