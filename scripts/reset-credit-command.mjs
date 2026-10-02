import * as prompts from "@clack/prompts";
import { stripVTControlCharacters } from "node:util";
import { requestGatewayResetCredits } from "../runtime/gateway-account-refresh.mjs";
import { isCommandHelp } from "./cli-help.mjs";
import { locateUserConfig } from "./runtime-config.mjs";

export const resetCreditCommandUsage = `用法：codexc reset-credit <list|use>
  list [--json]    实时查询当前 ChatGPT 账户可用重置券
  use [券ID]       选择并预览一张券，在交互终端明确确认后使用

需要 Gateway 与主 App Server 可用；不依赖 WebUI。
使用操作必须在交互终端确认，默认取消，不支持 --yes 或非交互消费。
连接中断或超时后不会自动重试，请先用 list 核对官方券状态。`;

const outcomes = {
  reset: "用量已重置。",
  nothingToReset: "当前没有需要重置的用量窗口。",
  noCredit: "所选重置券已不可用，请重新查询。",
  alreadyRedeemed: "本次操作此前已成功，未重复消费。",
};
const errors = {
  reset_stale: "账户、券状态或确认已变化，请重新选择并确认。",
  reset_busy: "已有重置操作正在处理，请稍后查询。",
  reset_unavailable: "重置券暂不可用，请检查 Gateway 与 ChatGPT 登录状态。",
  reset_unknown: "结果待确认，请用 codexc reset-credit list 核对官方状态，不要直接重复消费。",
};

export async function runResetCreditCommand(args = [], {
  environment = process.env, input = process.stdin, output = process.stdout,
  prompt = prompts, request = requestGatewayResetCredits,
} = {}) {
  if (isCommandHelp(args, [[], ["list"], ["use"]], resetCreditCommandUsage) || args.length === 0) {
    output.write(`${resetCreditCommandUsage}\n`);
    return;
  }
  const [action, argument] = args;
  const list = action === "list" && (args.length === 1 || (args.length === 2 && argument === "--json"));
  const use = action === "use" && (args.length === 1 || (args.length === 2 && typeof argument === "string"
    && argument.length > 0 && argument.length <= 256 && !argument.startsWith("-") && !/[\0\r\n]/u.test(argument)));
  if (!list && !use) throw new Error(resetCreditCommandUsage);
  if (use && (!input.isTTY || !output.isTTY)) throw new Error("使用重置券需要交互终端确认；查询请用 codexc reset-credit list --json。");
  const { configPath } = locateUserConfig(environment);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const call = async operation => {
    try { return await request(configPath, operation, controller.signal); }
    catch (error) {
      const code = Object.hasOwn(errors, error?.code) ? error.code
        : operation.method === "reset/consume" ? "reset_unknown" : "reset_unavailable";
      throw new Error(errors[code], { cause: error });
    }
  };
  let pendingAttemptId;
  try {
    let creditId = argument;
    if (list || creditId === undefined) {
      const snapshot = await call({ method: "reset/list" });
      controller.signal.throwIfAborted();
      if (list) {
        if (argument === "--json") output.write(`${JSON.stringify(snapshot)}\n`);
        else {
          output.write(`账户：${safeText(snapshot.accountId)}\n可用重置券：${snapshot.availableCount}\n`);
          for (const credit of snapshot.credits) output.write(`${describeCredit(credit)}\n`);
          if (snapshot.credits.length === 0) output.write("暂无可选择的重置券。\n");
        }
        return snapshot;
      }
      if (snapshot.credits.length === 0) { output.write("暂无可选择的重置券。\n"); return; }
      creditId = await prompt.select({ message: "选择重置券", input, output, signal: controller.signal,
        options: snapshot.credits.map(credit => ({ value: credit.id, label: safeText(credit.title ?? credit.id), hint: expiry(credit.expiresAt) })) });
      if (prompt.isCancel(creditId) || controller.signal.aborted) { output.write("已取消，未发起消费。\n"); return; }
    }
    const preview = await call({ method: "reset/preview", creditId });
    pendingAttemptId = preview.attemptId;
    controller.signal.throwIfAborted();
    output.write(`账户：${safeText(preview.accountId)}\n${describeCredit(preview.credit)}\n`);
    const confirmed = await prompt.confirm({ message: "确认使用这张重置券？", initialValue: false, input, output, signal: controller.signal });
    if (confirmed !== true || controller.signal.aborted) { output.write("已取消，未发起消费。\n"); return; }
    const result = await call({ method: "reset/consume", attemptId: preview.attemptId });
    pendingAttemptId = undefined;
    if (!Object.hasOwn(outcomes, result?.outcome)) throw new Error(errors.reset_unknown);
    output.write(`${outcomes[result.outcome]}\n`);
    if (!result.refreshed) output.write("操作结果已确认，但账户额度刷新失败，请稍后查询。\n");
    return result;
  } finally {
    if (pendingAttemptId !== undefined) {
      try {
        // 使用独立截止时间，即使交互已中断也尝试释放预览；不撤销或重试消费。
        await request(configPath, { method: "reset/cancel", attemptId: pendingAttemptId }, globalThis.AbortSignal.timeout(2_000));
      } catch {
        output.write("预览记录清理未确认，将在 5 分钟有效期结束后失效；这不表示消费已撤销。\n");
      }
    }
    controller.abort();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

function safeText(value) {
  // 官方展示文字不得向交互终端注入控制序列。
  // eslint-disable-next-line no-control-regex
  return stripVTControlCharacters(String(value)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}
function expiry(seconds) {
  return seconds === null ? "无到期时间" : `到期：${new Date(seconds * 1000).toISOString()}（UTC）`;
}
function describeCredit(credit) {
  return `券 ID：${safeText(credit.id)}\n名称：${safeText(credit.title ?? "用量重置券")}\n说明：${safeText(credit.description ?? "使用范围以官方执行结果为准")}\n${expiry(credit.expiresAt)}`;
}
