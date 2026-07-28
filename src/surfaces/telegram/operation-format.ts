import type { OperationUpdate } from "../../conversation-core/index.js";
import {
  compactOperationDetail,
  operationMetadata,
  operationStatus,
  operationTitle,
  redactOperationDetail,
} from "../operation-presentation.js";
import type { OperationUpdateDisplay } from "../types.js";
import {
  operationSummaryRows,
  type OperationUpdateSummary,
} from "../operation-update-buffer.js";

export interface OperationLogView {
  order: readonly string[];
  records: ReadonlyMap<string, OperationUpdate>;
  omittedCount: number;
}

interface OperationGroup {
  record: OperationUpdate;
  count: number;
}

export function formatOperationLog(
  state: OperationLogView,
  display: Exclude<OperationUpdateDisplay, "hidden"> = "full",
): string {
  const records = state.order
    .map((itemId) => state.records.get(itemId))
    .filter((record): record is OperationUpdate => record !== undefined);
  let visible = records.slice(-20);
  let omitted = state.omittedCount + records.length - visible.length;
  let text = renderOperationRecords(visible, omitted, display);
  while (Array.from(text).length > 3_900 && visible.length > 1) {
    visible = visible.slice(1);
    omitted += 1;
    text = renderOperationRecords(visible, omitted, display);
  }
  return text;
}

export function formatTelegramOperationSummary(
  summary: OperationUpdateSummary,
  display: Exclude<OperationUpdateDisplay, "hidden"> = "full",
): string {
  if (summary.records.length === 1) {
    const record = summary.records[0]!;
    return formatOperationLog({
      order: [record.itemId],
      records: new Map([[record.itemId, record]]),
      omittedCount: 0,
    }, display);
  }
  const duration = summary.totalDurationMs === undefined
    ? ""
    : ` · ${summary.totalDurationMs} ms`;
  return [
    "<b>操作过程</b>",
    "",
    `<b>工具查询 · 已完成</b>${duration}`,
    ...operationSummaryRows(summary).map((row) => `• ${row}`),
  ].join("\n");
}

function renderOperationRecords(
  records: OperationUpdate[],
  omitted: number,
  display: Exclude<OperationUpdateDisplay, "hidden">,
): string {
  const lines = ["<b>操作过程</b>"];
  if (omitted > 0) {
    lines.push("", `<i>已省略较早的 ${omitted} 项操作</i>`);
  }
  for (const { record, count } of groupOperations(records)) {
    const countLabel = count > 1 ? ` (×${count})` : "";
    const metadata = operationMetadata(record);
    const heading =
      `${operationIcon(record)} <b>${operationTitle(record)}${countLabel} · ${operationStatus(record.status)}</b>`
      + (metadata.length > 0 ? ` · ${metadata.join(" · ")}` : "");
    if (display === "compact") {
      const detail = record.detail ? compactOperationDetail(record.detail) : null;
      lines.push(
        "",
        heading + (detail ? ` · <code>${escapeTelegramHtml(detail)}</code>` : ""),
      );
      continue;
    }
    lines.push("", heading);
    if (record.detail) {
      const detail = escapeTelegramHtml(redactOperationDetail(record.detail));
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

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
