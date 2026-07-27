import type { OperationUpdate } from "../../conversation-core/index.js";
import {
  compactOperationDetail,
  operationMetadata,
  operationStatus,
  operationTitle,
  redactOperationDetail,
} from "../operation-presentation.js";
import type { OperationUpdateDisplay } from "../types.js";

export function formatFeishuOperation(
  record: OperationUpdate,
  display: Exclude<OperationUpdateDisplay, "hidden"> = "full",
): string {
  const metadata = operationMetadata(record);
  const lines = [
    `**${operationTitle(record)} · ${operationStatus(record.status)}**${metadata.length > 0 ? ` · ${metadata.join(" · ")}` : ""}`,
  ];
  if (record.detail) {
    if (display === "compact") {
      return `${lines[0]} · \`${inlineOperationDetail(compactOperationDetail(record.detail))}\``;
    }
    const detail = safeOperationDetail(record.detail);
    if (record.kind === "command") {
      lines.push("```shell", detail, "```");
    } else {
      lines.push(`具体内容：\`${inlineOperationDetail(detail)}\``);
    }
  }
  return lines.join("\n");
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
