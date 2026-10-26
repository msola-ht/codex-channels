import * as clackPrompts from "@clack/prompts";
import { createHash } from "node:crypto";
import {
  loadModelBase, prepareModelBaseUpdate, applyModelBaseUpdate,
} from "./model-base-management.mjs";
import { withCliProgress } from "./cli-operation-progress.mjs";

export const modelBaseCommandUsage = `用法：codexc model-base [status [--json]|update [--preview [--json]]]

  status             查看当前公共底座模型、CLI 版本和来源
  update             获取候选，显示字段前后差异，长内容可展开，终端确认后保存
  update --preview   只获取并对比，不保存底座；--json 输出完整差异

使用当前 Codex 环境的 codex debug models，取输出的第一个模型；可能联网或更新 CLI 缓存，
不保证获取远端最新目录。保存到 Gateway 数据目录，保留旧快照备份，不修改安装包文件。
已有账户模型须另行使用“对比并更新模型模板”；不会自动重启服务。`;

export async function runModelBaseCommand(args = [], {
  environment = process.env, input = process.stdin, output = process.stdout, prompts = clackPrompts,
} = {}) {
  if (args.includes("-h") || args.includes("--help")) {
    if (!(args.length === 1 || (args.length === 2 && ["status", "update"].includes(args[0]) && ["-h", "--help"].includes(args[1])))) throw new Error(modelBaseCommandUsage);
    output.write(`${modelBaseCommandUsage}\n`);
    return;
  }
  const [action = "status", ...flags] = args;
  const json = flags.includes("--json");
  const previewOnly = flags.includes("--preview");
  if (!["status", "update"].includes(action) || new Set(flags).size !== flags.length
    || flags.some(flag => !["--json", "--preview"].includes(flag))
    || (action === "status" && previewOnly) || (action === "update" && json && !previewOnly)) {
    throw new Error(modelBaseCommandUsage);
  }
  if (action === "update" && !previewOnly && (!input.isTTY || !output.isTTY)) {
    throw new Error("保存公共底座需要交互终端查看差异并确认；非交互对比请用 codexc model-base update --preview --json");
  }
  const current = await loadModelBase(environment);
  if (action === "status") {
    output.write(json ? `${JSON.stringify(current, null, 2)}\n`
      : `公共底座：${JSON.stringify(current.model)}\nCLI：${JSON.stringify(current.cliVersion)}\n来源：${current.source === "saved" ? "本地保存" : "项目初始快照"}\n来源命令：${JSON.stringify(current.command)}\n修订：${current.revision}\n`);
    return current;
  }
  {
    const preview = await withCliProgress("获取并校验公共底座候选", ({ signal }) =>
      prepareModelBaseUpdate({ revision: current.revision }, environment, { signal }),
    { output: json ? null : output, delayMs: 150 });
    if (json) output.write(`${JSON.stringify(preview, null, 2)}\n`);
    else {
      output.write(`公共底座：${JSON.stringify(preview.before.model)} → ${JSON.stringify(preview.after.model)}\n`);
      output.write(`CLI：${JSON.stringify(preview.before.cliVersion)} → ${JSON.stringify(preview.after.cliVersion)}\n`);
      for (const change of preview.changes) {
        output.write(`\n${JSON.stringify(change.field)}\n  更新前：${display(change.before)}\n  更新后：${display(change.after)}\n`);
      }
      const longChanges = preview.changes.filter(change => [change.before, change.after].some(value => value.present && JSON.stringify(value.value).length > 800));
      if (longChanges.length) {
        if (previewOnly) output.write("\n长内容已显示开头、长度和摘要；完整前后值请使用 --preview --json。\n");
        else {
          const expand = await prompts.confirm({ message: "是否展开长内容的完整前后值？", initialValue: false });
          if (prompts.isCancel(expand)) return { action: "back" };
          if (expand) for (const change of longChanges) {
            output.write(`\n${JSON.stringify(change.field)}\n  更新前：${display(change.before, true)}\n  更新后：${display(change.after, true)}\n`);
          }
        }
      }
      output.write(preview.changed ? "\n保存将更新公共模板；已有账户模型与服务不变。\n" : "内容无变化，无需保存。\n");
    }
    if (previewOnly || !preview.changed) return { action: "back" };
    if (await prompts.confirm({ message: "确认按上述差异更新公共底座？", initialValue: false }) !== true) {
      output.write("已取消，公共底座未保存。\n");
      return { action: "back" };
    }
    let result;
    let interrupted;
    try {
      await withCliProgress("保存公共底座", async ({ signal }) => {
        result = await applyModelBaseUpdate({ revision: preview.revision, candidateToken: preview.candidateToken }, environment, { signal });
        return result;
      }, { output, delayMs: 150 });
    } catch (error) {
      // A stop arriving during lock release cannot erase an already committed save.
      if (result?.status !== "updated") throw error;
      interrupted = error;
    }
    output.write(result.consistency !== "confirmed"
      ? "底座保存结果需核对，请先读取当前底座与备份，勿自动重试。\n"
      : result.status === "unchanged" ? "公共底座无变化。\n" : `公共底座已保存并回读：${JSON.stringify(result.model)}。\n`);
    if (result.backupPath) output.write(`备份：${JSON.stringify(result.backupPath)}\n`);
    if (interrupted) throw interrupted;
    if (result.consistency !== "confirmed") throw new Error("公共底座保存结果未确认");
    return { action: "back" };
  }
}

function display(value, full = false) {
  if (!value.present) return "（字段不存在）";
  const text = JSON.stringify(value.value, null, 2);
  if (full || text.length <= 800) return text;
  return `${JSON.stringify(text.slice(0, 300))}…（完整 JSON ${text.length} 字符，SHA-256 ${createHash("sha256").update(text).digest("hex")}）`;
}
