import type { OperationUpdate } from "../../conversation-core/index.js";
import { formatElapsedDuration } from "../elapsed-duration.js";
import {
  compactOperationDetail,
  operationStatus,
  operationTitle,
  redactOperationDetail,
} from "../operation-presentation.js";
import type { OperationUpdateDisplay } from "../types.js";
import {
  operationSummaryRows,
  type OperationUpdateSummary,
} from "../operation-update-buffer.js";

export function formatFeishuOperation(
  record: OperationUpdate,
  display: Exclude<OperationUpdateDisplay, "hidden"> = "full",
): string {
  const exitCode = record.exitCode === undefined
    ? ""
    : ` · exit ${record.exitCode}`;
  const lines = [
    `**${operationTitle(record)} · ${operationStatus(record.status)}**${exitCode}`,
  ];
  if (record.detail) {
    if (display === "compact") {
      return withOperationDurationFooter(
        `${lines[0]} · \`${inlineOperationDetail(compactOperationDetail(record.detail))}\``,
        record.durationMs,
      );
    }
    const detail = safeOperationDetail(record.detail);
    if (record.kind === "command") {
      lines.push("```shell", detail, "```");
    } else {
      lines.push(`具体内容：\`${inlineOperationDetail(detail)}\``);
    }
  }
  return withOperationDurationFooter(lines.join("\n"), record.durationMs);
}

export function formatFeishuOperationSummary(
  summary: OperationUpdateSummary,
  display: Exclude<OperationUpdateDisplay, "hidden"> = "full",
): string {
  if (summary.records.length === 1) {
    return formatFeishuOperation(summary.records[0]!, display);
  }
  const markdown = [
    "**工具查询 · 已完成**",
    ...operationSummaryRows(summary).map((row) => `- ${row}`),
  ].join("\n");
  return withOperationDurationFooter(markdown, summary.totalDurationMs);
}

function withOperationDurationFooter(
  markdown: string,
  durationMs: number | undefined,
): string {
  return durationMs === undefined || durationMs <= 0
    ? markdown
    : `${markdown}\n\n---\n**耗时：** ${formatElapsedDuration(durationMs)}`;
}

function inlineOperationDetail(value: string): string {
  return value
    .replaceAll("`", "ˋ")
    .replaceAll("\n", " ");
}

function safeOperationDetail(value: string): string {
  return redactOperationDetail(value)
    .replaceAll("```", "``\u200B`");
}
