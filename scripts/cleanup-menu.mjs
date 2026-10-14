export { cleanupUsage } from "./cli-command-usage.mjs";
import * as clackPrompts from "@clack/prompts";

import { runMaintenanceServices } from "./maintenance-services.mjs";
import { reportMenuError } from "./cli-menu.mjs";
import { isPrunableMetricsProviderId } from "./metrics-command-options.mjs";
import { runMetricsMaintenanceMenu } from "./metrics-menu.mjs";
import { runSessionCleanupMenu } from "./session-menu.mjs";

export async function runCleanupMenu({
  prompts = clackPrompts,
  runSessionCleanup,
  runTrafficCleanup,
  runDatabaseCommand,
  readStorage,
  services = {},
}) {
  prompts.intro("数据清理");
  while (true) {
    const action = await prompts.select({
      message: "清理项目",
      showInstructions: false,
      options: [
        { value: "sessions", label: "归档短会话及子会话", hint: "临停 Gateway，预览并确认归档" },
        { value: "traffic", label: "删除请求与响应转储", hint: "预览后确认删除，临停相关服务" },
        { value: "cleanup", label: "清理旧指标", hint: "按保留天数与记录数备份清理" },
        { value: "prune", label: "清理指定 Provider 的指标", hint: "按精确 Provider ID 备份清理" },
        { value: "reset", label: "重置整个指标库", hint: "备份后重置，临停 Gateway" },
        { value: "cancel", label: "返回", hint: "结束数据清理" },
      ],
    });
    if (prompts.isCancel(action)) {
      prompts.cancel("已取消清理");
      return;
    }
    if (action === "cancel") {
      prompts.outro("已退出清理菜单");
      return;
    }
    if (!["sessions", "cleanup", "reset", "traffic", "prune"].includes(action)) {
      throw new Error(`未知清理项目：${String(action)}`);
    }
    try {
      if (action === "sessions") {
        await runSessionCleanupMenu({ prompts, runCleanup: runSessionCleanup });
      } else if (action === "cleanup" || action === "reset") {
        await runMetricsMaintenanceMenu(action, { prompts, readStorage,
          runDatabaseCommand: values => runMaintenanceServices({ ...services, prompts, targets: ["gateway"],
            run: () => runDatabaseCommand([values[0] === "cleanup-restart" ? "cleanup" : values[0], ...values.slice(1)]) }),
        });
      } else if (action === "traffic") {
        await runTrafficCleanup([]);
        const confirmed = await prompts.confirm({
          message: "确认永久删除当前配置目录中的全部请求与响应转储？执行前将确认临停 Gateway、Relay 和 App Server，结束后按原状态恢复。",
          initialValue: false,
        });
        if (!prompts.isCancel(confirmed) && confirmed === true) await runMaintenanceServices({ ...services, prompts,
          targets: ["gateway", "relay", "app-server"], run: () => runTrafficCleanup(["--confirm"]) });
      } else if (action === "prune") {
        const provider = await prompts.text({
          message: "需要清理指标的精确 Provider ID（区分大小写）",
          placeholder: "例如 openai 或 ds-account",
          validate: (value) => isPrunableMetricsProviderId(String(value ?? "").trim()) ? undefined : "请输入合法的 Provider ID",
        });
        if (prompts.isCancel(provider)) continue;
        const id = String(provider).trim();
        const confirmed = await prompts.confirm({
          message: `确认备份并清理 Provider ${id} 的请求指标？Gateway 将按原运行状态恢复。`,
          initialValue: false,
        });
        if (!prompts.isCancel(confirmed) && confirmed === true) await runDatabaseCommand(["prune", id]);
      }
    } catch (error) {
      reportMenuError(error);
    }
  }
}
