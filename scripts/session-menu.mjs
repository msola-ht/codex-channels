import * as clackPrompts from "@clack/prompts";

export async function runSessionMenu({
  prompts = clackPrompts,
  runCleanup,
} = {}) {
  if (typeof runCleanup !== "function") {
    throw new Error("会话清理菜单缺少执行入口");
  }
  prompts.intro("Codex Connect Sessions");
  const action = await prompts.select({
    message: "选择会话操作",
    showInstructions: false,
    options: [
      {
        value: "cleanup",
        label: "清理旧会话",
        hint: "按 Turn 轮数预览并交互确认归档",
      },
      { value: "cancel", label: "取消" },
    ],
  });
  if (prompts.isCancel(action) || action === "cancel") {
    prompts.cancel("已取消");
    return;
  }
  if (action !== "cleanup") throw new Error(`未知会话操作：${String(action)}`);

  const maxTurns = await prompts.text({
    message: "最多保留多少轮（超过此数不清理）",
    placeholder: "3",
    initialValue: "3",
    validate: (value) => {
      if (!/^\d+$/u.test(value.trim())) return "请输入 0 到 10000 的整数";
      const number = Number(value.trim());
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
    message: "连续空闲多少天（可留空）",
    placeholder: "不限制",
    validate: (value) => {
      if (!value.trim()) return undefined;
      if (!/^\d+$/u.test(value.trim())) return "请输入正整数，或直接回车跳过";
      const number = Number(value.trim());
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
  return runCleanup(args);
}
