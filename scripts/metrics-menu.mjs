import * as clackPrompts from "@clack/prompts";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { requireUserConfig } from "./runtime-config.mjs";

export async function runMetricsMenu({
  prompts = clackPrompts,
  readStorage = defaultReadStorage,
  readThreads = defaultReadThreads,
  runDatabaseCommand,
  runMetricsCommand,
}) {
  prompts.intro("Codex Connect Metrics");
  const action = await prompts.select({
    message: "选择指标操作",
    showInstructions: false,
    options: [
      {
        value: "run",
        label: "本次运行导出",
        hint: "指定 Thread 输出最近运行与累计汇总（写入 output 目录）",
      },
      {
        value: "turns",
        label: "会话明细导出",
        hint: "选择会话后导出每次对话汇总（写入 output 目录）",
      },
      {
        value: "report",
        label: "聚合汇报",
        hint: "按时间范围与分组输出汇报（写入 output 目录）",
      },
      {
        value: "export",
        label: "明细导出",
        hint: "导出脱敏请求记录（写入 output 目录）",
      },
      {
        value: "status",
        label: "数据库状态",
        hint: "查看指标库路径、Schema 与记录数",
      },
      {
        value: "cleanup",
        label: "清理旧指标",
        hint: "按自定天数和最大行数备份清理",
      },
      {
        value: "reset",
        label: "重置指标库",
        hint: "备份并重建（需 Gateway 停止）",
      },
      {
        value: "normalize-currency",
        label: "统一费用币种",
        hint: "备份并清除历史非 USD 费用（保留其他指标）",
      },
      { value: "cancel", label: "取消" },
    ],
  });
  if (prompts.isCancel(action) || action === "cancel") {
    prompts.cancel("已取消");
    return;
  }
  if (action === "status") {
    runDatabaseCommand(["status"]);
    return;
  }
  if (action === "reset") {
    const confirmed = await prompts.confirm({
      message: "重置会先备份现有指标库，确认继续？",
      initialValue: false,
    });
    if (prompts.isCancel(confirmed) || confirmed !== true) {
      prompts.cancel("已取消");
      return;
    }
    runDatabaseCommand(["reset"]);
    return;
  }
  if (action === "normalize-currency") {
    const confirmed = await prompts.confirm({
      message: "将备份并清除历史非 USD 费用字段，确认继续？",
      initialValue: false,
    });
    if (prompts.isCancel(confirmed) || confirmed !== true) {
      prompts.cancel("已取消");
      return;
    }
    runDatabaseCommand(["normalize-currency"]);
    return;
  }
  if (action === "cleanup") {
    const storage = readStorage();
    const keepDays = await prompts.text({
      message: "保留最近多少天",
      initialValue: String(storage.retention_days ?? 365),
      validate: positiveIntegerPrompt,
    });
    if (prompts.isCancel(keepDays)) {
      prompts.cancel("已取消");
      return;
    }
    const maxRows = await prompts.text({
      message: "最多保留多少行",
      initialValue: String(storage.max_rows ?? 1_000_000),
      validate: positiveIntegerPrompt,
    });
    if (prompts.isCancel(maxRows)) {
      prompts.cancel("已取消");
      return;
    }
    const vacuum = await prompts.confirm({
      message: "清理后立即压缩 SQLite 文件？",
      initialValue: false,
    });
    if (prompts.isCancel(vacuum)) {
      prompts.cancel("已取消");
      return;
    }
    runDatabaseCommand([
      "cleanup-restart",
      "--keep-days",
      String(keepDays),
      "--max-rows",
      String(maxRows),
      ...(vacuum ? ["--vacuum"] : []),
    ]);
    return;
  }
  if (action === "run") {
    const threadId = await prompts.text({
      message: "Thread ID",
      placeholder: "例如：019fcb00-c0e1-7222-995d-a9e9f8f35443",
      validate: (value) => String(value ?? "").trim() ? undefined : "Thread ID 不能为空",
    });
    if (prompts.isCancel(threadId)) {
      prompts.cancel("已取消");
      return;
    }
    const format = await selectExportFormat(prompts);
    if (prompts.isCancel(format)) {
      prompts.cancel("已取消");
      return;
    }
    runMetricsCommand(["run", String(threadId).trim(), "--format", String(format)]);
    return;
  }
  if (action === "turns") {
    let threads;
    try {
      threads = await readThreads();
    } catch (error) {
      writeCliMessage("failure", error instanceof Error ? error.message : String(error));
      return;
    }
    if (threads.length === 0) {
      writeCliMessage("note", "指标库中暂无可导出的会话记录。");
      return;
    }
    const selected = await prompts.select({
      message: "选择会话",
      showInstructions: false,
      options: threads.map((thread) => ({
        value: thread.threadId,
        label: `${thread.threadId.slice(0, 12)}… · ${thread.turnCount} 次对话 · ${thread.requestCount} 次请求`,
        hint: new Date(thread.lastRecordedAtMs).toISOString(),
      })),
    });
    if (prompts.isCancel(selected)) {
      prompts.cancel("已取消");
      return;
    }
    const format = await selectExportFormat(prompts);
    if (prompts.isCancel(format)) {
      prompts.cancel("已取消");
      return;
    }
    runMetricsCommand(["turns", String(selected), "--format", String(format)]);
    return;
  }
  if (action === "report") {
    const range = await selectMetricsRange(prompts);
    if (prompts.isCancel(range)) {
      prompts.cancel("已取消");
      return;
    }
    const group = await prompts.select({
      message: "分组方式",
      showInstructions: false,
      options: [
        { value: "global", label: "全局汇总" },
        { value: "providers", label: "按提供商" },
        { value: "models", label: "按模型" },
      ],
    });
    if (prompts.isCancel(group)) {
      prompts.cancel("已取消");
      return;
    }
    const format = await selectExportFormat(prompts);
    if (prompts.isCancel(format)) {
      prompts.cancel("已取消");
      return;
    }
    runMetricsCommand([
      "report",
      "--range",
      String(range),
      "--group",
      String(group),
      "--format",
      String(format),
    ]);
    return;
  }
  if (action === "export") {
    const range = await selectMetricsRange(prompts);
    if (prompts.isCancel(range)) {
      prompts.cancel("已取消");
      return;
    }
    const format = await selectExportFormat(prompts);
    if (prompts.isCancel(format)) {
      prompts.cancel("已取消");
      return;
    }
    const threadId = await prompts.text({
      message: "Thread ID（留空导出全部）",
      initialValue: "",
    });
    if (prompts.isCancel(threadId)) {
      prompts.cancel("已取消");
      return;
    }
    const trimmedThreadId = String(threadId).trim();
    runMetricsCommand([
      "export",
      "--range",
      String(range),
      "--format",
      String(format),
      ...(trimmedThreadId ? ["--thread", trimmedThreadId] : []),
    ]);
    return;
  }
  throw new Error(`未知指标操作：${String(action)}`);
}

function defaultReadStorage() {
  const { configPath } = requireUserConfig();
  const document = readGatewayConfig(configPath);
  return table(table(document.metrics).storage);
}

async function defaultReadThreads() {
  const { readMetricsThreads } = await import("./metrics-database-access.mjs");
  return readMetricsThreads().threads;
}

function selectExportFormat(prompts) {
  return prompts.select({
    message: "导出格式",
    showInstructions: false,
    options: [
      { value: "markdown", label: "Markdown" },
      { value: "json", label: "JSON" },
      { value: "csv", label: "CSV" },
    ],
  });
}

function selectMetricsRange(prompts) {
  return prompts.select({
    message: "时间范围",
    showInstructions: false,
    options: [
      { value: "today", label: "今天" },
      { value: "yesterday", label: "昨天" },
      { value: "this-week", label: "本周" },
      { value: "last-week", label: "上周" },
      { value: "this-month", label: "本月" },
      { value: "last-month", label: "上月" },
      { value: "24h", label: "最近 24 小时" },
      { value: "7d", label: "最近 7 天" },
      { value: "30d", label: "最近 30 天" },
      { value: "90d", label: "最近 90 天" },
      { value: "365d", label: "最近 365 天" },
      { value: "all", label: "全部保留历史" },
    ],
  });
}

function positiveIntegerPrompt(value) {
  const number = Number(String(value ?? "").trim());
  return Number.isSafeInteger(number) && number > 0 ? undefined : "请输入正整数";
}

function table(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
