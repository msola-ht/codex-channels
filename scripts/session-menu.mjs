import * as clackPrompts from "@clack/prompts";
import { maintenanceServiceRunning, runMaintenanceServices } from "./maintenance-services.mjs";

export async function runSessionCleanupMenu({ prompts = clackPrompts, runCleanup,
  gatewayRunning = () => maintenanceServiceRunning("gateway"), runService, services = {},
}) {

  const maxTurns = await prompts.text({
    message: "主会话最多几轮（超过则跳过整组）",
    placeholder: "3",
    initialValue: "3",
    validate: (value) => {
      const input = (value ?? "").trim();
      if (!/^\d+$/u.test(input)) return "请输入 0 到 10000 的整数";
      const number = Number(input);
      return Number.isSafeInteger(number) && number <= 10_000
        ? undefined
        : "请输入 0 到 10000 的整数";
    },
  });
  if (prompts.isCancel(maxTurns)) {
    prompts.cancel("已取消");
    return;
  }

  const idleDays = await prompts.text({
    message: "至少空闲几天（留空不限制）",
    placeholder: "不限制",
    validate: (value) => {
      const input = (value ?? "").trim();
      if (!input) return undefined;
      if (!/^\d+$/u.test(input)) return "请输入正整数，或直接回车跳过";
      const number = Number(input);
      return Number.isSafeInteger(number) && number >= 1 && number <= 36_500
        ? undefined
        : "请输入 1 到 36500 的整数";
    },
  });
  if (prompts.isCancel(idleDays)) {
    prompts.cancel("已取消");
    return;
  }

  const args = [maxTurns.trim()];
  if (idleDays.trim()) args.push("--idle-days", idleDays.trim());
  // The cleanup command performs the candidate preview and its own final
  // confirmation in the terminal.
  args.push("--confirm");
  return runMaintenanceServices({ prompts, targets: ["gateway"], isRunning: gatewayRunning, ...services,
    ...(runService ? { runService: action => runService(action) } : {}), run: options => runCleanup(args, options) });
}
