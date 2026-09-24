import * as clackPrompts from "@clack/prompts";

export async function runSessionCleanupMenu({ prompts = clackPrompts, runCleanup }) {

  const maxTurns = await prompts.text({
    message: "归档主会话的最大轮数（超过此数跳过整组）",
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
