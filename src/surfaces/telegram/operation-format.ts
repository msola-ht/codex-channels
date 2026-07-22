import type { OperationUpdate } from "../../conversation-core/index.js";

export interface OperationLogView {
  order: readonly string[];
  records: ReadonlyMap<string, OperationUpdate>;
  omittedCount: number;
}

interface OperationGroup {
  record: OperationUpdate;
  count: number;
}

export function formatOperationLog(state: OperationLogView): string {
  const records = state.order
    .map((itemId) => state.records.get(itemId))
    .filter((record): record is OperationUpdate => record !== undefined);
  let visible = records.slice(-20);
  let omitted = state.omittedCount + records.length - visible.length;
  let text = renderOperationRecords(visible, omitted);
  while (Array.from(text).length > 3_900 && visible.length > 1) {
    visible = visible.slice(1);
    omitted += 1;
    text = renderOperationRecords(visible, omitted);
  }
  return text;
}

function renderOperationRecords(records: OperationUpdate[], omitted: number): string {
  const lines = ["<b>操作过程</b>"];
  if (omitted > 0) {
    lines.push("", `<i>已省略较早的 ${omitted} 项操作</i>`);
  }
  for (const { record, count } of groupOperations(records)) {
    const countLabel = count > 1 ? ` (×${count})` : "";
    lines.push("", `${operationIcon(record)} <b>${operationTitle(record)}${countLabel}</b>`);
    if (record.detail) {
      const detail = escapeTelegramHtml(
        record.detail.replaceAll("[REDACTED]", "[已隐藏]"),
      );
      lines.push(record.kind === "command"
        ? `<pre><code class="language-shell">${detail}</code></pre>`
        : `<blockquote>${detail}</blockquote>`);
    }
  }
  return lines.join("\n");
}

function groupOperations(records: OperationUpdate[]): OperationGroup[] {
  const groups: OperationGroup[] = [];
  for (const record of records) {
    const previous = groups.at(-1);
    if (previous && operationGroupKey(previous.record) === operationGroupKey(record)) {
      previous.count += 1;
      previous.record = record;
    } else {
      groups.push({ record, count: 1 });
    }
  }
  return groups;
}

function operationGroupKey(record: OperationUpdate): string {
  return JSON.stringify([
    record.kind,
    record.action ?? null,
    record.detail ?? null,
    record.status,
  ]);
}

function operationIcon(record: OperationUpdate): string {
  const icon = ({
    command: "💻",
    fileChange: "🔧",
    mcpTool: "🔌",
    dynamicTool: "🧰",
    subagent: "🤖",
    webSearch: "🌐",
    imageView: "🖼️",
    imageGeneration: "🎨",
    sleep: "⏳",
    plan: "📋",
    contextCompaction: "🗜️",
    reviewMode: "🔍",
  } as const)[record.kind];
  const statusIcon = ({
    running: "⏳",
    completed: "",
    failed: "❌",
    declined: "🚫",
  } as const)[record.status];
  return statusIcon ? `${icon} ${statusIcon}` : icon;
}

function operationTitle(record: OperationUpdate): string {
  switch (record.kind) {
    case "command":
      return "运行命令";
    case "fileChange":
      return "修改文件";
    case "mcpTool":
      return "调用 MCP 工具";
    case "dynamicTool":
      return "调用工具";
    case "subagent":
      return ({
        spawnAgent: "启动子代理",
        sendInput: "向子代理发送任务",
        resumeAgent: "恢复子代理",
        wait: "等待子代理",
        closeAgent: "关闭子代理",
        started: "子代理已启动",
        interacted: "子代理正在交互",
        interrupted: "子代理已中断",
      } as Record<string, string>)[record.action ?? ""] ?? "子代理活动";
    case "webSearch":
      return "搜索网页";
    case "imageView":
      return "查看图片";
    case "imageGeneration":
      return "生成图片";
    case "sleep":
      return "等待";
    case "plan":
      return "更新计划";
    case "contextCompaction":
      return "压缩上下文";
    case "reviewMode":
      return record.action === "exited" ? "退出审查模式" : "进入审查模式";
  }
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
