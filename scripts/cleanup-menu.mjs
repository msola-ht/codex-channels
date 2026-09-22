import * as clackPrompts from "@clack/prompts";

import { isPrunableMetricsProviderId } from "./metrics-command-options.mjs";
import { runMetricsMaintenanceMenu } from "./metrics-menu.mjs";
import { runSessionCleanupMenu } from "./session-menu.mjs";

export const cleanupUsage = `用法：codexc cleanup

交互选择：归档短会话及子会话、删除请求转储、清理旧指标、按 Provider 清理指标或重置指标库。
会话归档需停止 Gateway，保留 App Server；转储删除需停止全部 App Server。
旧指标清理会备份并停止后启动 Gateway；Provider 清理按原状态恢复 Gateway；重置指标库需先停止 Gateway。
非交互终端只显示帮助。直接命令仍为 sessions cleanup、traffic cleanup、metrics cleanup|prune|reset。`;

export async function runCleanupMenu({
  prompts = clackPrompts,
  runSessionCleanup,
  runTrafficCleanup,
  runDatabaseCommand,
  readStorage,
}) {
  prompts.intro("Codex Connect Cleanup");
  while (true) {
    const action = await prompts.select({
      message: "选择清理项目",
      showInstructions: false,
      options: [
        { value: "sessions", label: "归档短会话及子会话", hint: "按主会话轮数和空闲天数筛选；需停止 Gateway，保留 App Server" },
        { value: "traffic", label: "删除请求与响应转储", hint: "预览后永久删除全部转储；需停止全部 App Server" },
        { value: "cleanup", label: "清理旧指标", hint: "按保留天数和行数备份清理；会停止后启动 Gateway" },
        { value: "prune", label: "清理指定 Provider 的指标", hint: "保留备份；输入精确 Provider ID，按原状态恢复 Gateway" },
        { value: "reset", label: "重置整个指标库", hint: "备份并重建；需停止 Gateway" },
        { value: "cancel", label: "退出" },
      ],
    });
    if (prompts.isCancel(action) || action === "cancel") {
      prompts.cancel("已退出清理菜单");
      return;
    }
    if (action === "sessions") {
      await runSessionCleanupMenu({ prompts, runCleanup: runSessionCleanup });
    } else if (action === "cleanup" || action === "reset") {
      await runMetricsMaintenanceMenu(action, { prompts, readStorage, runDatabaseCommand });
    } else if (action === "traffic") {
      await runTrafficCleanup([]);
      const confirmed = await prompts.confirm({
        message: "确认永久删除当前配置目录中的全部请求与响应转储？执行前需停止全部 App Server。",
        initialValue: false,
      });
      if (!prompts.isCancel(confirmed) && confirmed === true) await runTrafficCleanup(["--confirm"]);
    } else if (action === "prune") {
      const provider = await prompts.text({
        message: "需要清理指标的精确 Provider ID（区分大小写）",
        placeholder: "例如 openai 或 ds-account",
        validate: (value) => isPrunableMetricsProviderId(String(value).trim()) ? undefined : "请输入合法的 Provider ID",
      });
      if (prompts.isCancel(provider)) continue;
      const id = String(provider).trim();
      const confirmed = await prompts.confirm({
        message: `确认备份并清理 Provider ${id} 的请求指标？Gateway 将按原运行状态恢复。`,
        initialValue: false,
      });
      if (!prompts.isCancel(confirmed) && confirmed === true) await runDatabaseCommand(["prune", id]);
    } else {
      throw new Error(`未知清理项目：${String(action)}`);
    }
  }
}
