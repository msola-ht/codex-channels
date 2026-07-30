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

export function formatWeixinOperation(
  record: OperationUpdate,
  display: Exclude<OperationUpdateDisplay, "hidden"> = "full",
): string {
  const heading = [
    operationTitle(record),
    operationStatus(record.status),
    ...(record.exitCode === undefined ? [] : [`exit ${record.exitCode}`]),
  ].join(" · ");
  const duration = record.durationMs === undefined || record.durationMs <= 0
    ? null
    : `耗时：${formatElapsedDuration(record.durationMs)}`;
  if (display === "compact") {
    return [
      heading,
      ...(record.detail
        ? [sanitizeWeixinMarkdownText(compactOperationDetail(record.detail))]
        : []),
      ...(duration ? [duration] : []),
    ].join(" · ");
  }
  return [
    heading,
    ...(record.detail
      ? [
          "具体内容：",
          sanitizeWeixinMarkdownText(redactOperationDetail(record.detail)),
        ]
      : []),
    ...(duration ? [duration] : []),
  ].join("\n\n");
}

export function formatWeixinOperationSummary(
  summary: OperationUpdateSummary,
  display: Exclude<OperationUpdateDisplay, "hidden"> = "full",
): string {
  if (summary.records.length === 1) {
    return formatWeixinOperation(summary.records[0]!, display);
  }
  return [
    "工具查询 · 已完成",
    operationSummaryRows(summary).join("\n"),
    ...(summary.totalDurationMs === undefined
      ? []
      : [`总耗时：${formatElapsedDuration(summary.totalDurationMs)}`]),
  ].join("\n\n");
}

export function sanitizeWeixinMarkdownText(value: string): string {
  return value
    .replaceAll("`", "ˋ")
    .replaceAll("*", "＊")
    .replaceAll("_", "＿")
    .replaceAll("~", "～")
    .replaceAll("#", "＃")
    .replaceAll(">", "＞")
    .replaceAll("[", "［")
    .replaceAll("]", "］");
}
