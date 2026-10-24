import type { OutputEvent } from "../../conversation-core/index.js";
import { createTurnCompletedPresentation, renderPlainLifecyclePresentation, renderStructuredLifecyclePresentation } from "../lifecycle-presentation.js";
import { operationMetadata, operationStatus, operationTitle, redactOperationDetail } from "../operation-presentation.js";
import { toStructuredMarkdownList } from "../markdown-list.js";
import type { QqMessageBody } from "./protocol.js";
import { renderQqContent, type QqContentBlock } from "./content.js";

const MAX_RESULT_BYTES = 12_000;
const MAX_MESSAGE_BYTES = 3_000;
const MAX_MESSAGE_COUNT = 4;

export const qqHelp = [
  "QQ 单聊", "", "状态与运行：", "/status：查看状态", "/stop：停止当前任务", "",
  "工作区与会话：", "/workspace：查看或切换工作区", "/sessions：查看会话", "/resume：恢复会话", "/new：新建会话", "",
  "模型与用量：", "/model：查看或选择模型", "/effort：查看或调整思考等级", "/fast：查看或调整速度档位",
  "/usage：查询用量", "/limits：查询限额", "",
  "直接发送文字开始对话；回复按 QQ 格式呈现，代码和不支持的结构保留为完整文本。",
  "审批、问题、流式、附件、计划任务暂不支持；审批请求安全拒绝，请在原生客户端处理。",
].join("\n");

export interface QqRenderedMessage {
  /** Complete readable content; the persistent event retains the original source. */
  text: string;
  blocks: QqContentBlock[];
}

function validateText(text: string): void {
  if (!text.trim() || Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES
    || Buffer.from(text, "utf8").toString("utf8") !== text) {
    throw new Error("QQ 完整结果为空、包含无效 Unicode 或超过文本预算，保留待核对");
  }
}

/** Prefer line/word boundaries; never truncate, and never reserve before planning the full result. */
function plainChunks(text: string, preferBoundaries = true): QqMessageBody[] {
  const messages: QqMessageBody[] = [];
  let remaining = text;
  while (remaining) {
    let end = 0;
    let bytes = 0;
    let line = 0;
    let word = 0;
    for (const character of remaining) {
      bytes += Buffer.byteLength(character, "utf8");
      if (bytes > MAX_MESSAGE_BYTES) break;
      end += character.length;
      if (character === "\n") line = end;
      if (/\s/u.test(character)) word = end;
    }
    if (preferBoundaries && end < remaining.length) {
      if (line > end / 2) end = line;
      else if (word > end / 2) end = word;
    }
    messages.push({ kind: "text", content: remaining.slice(0, end) });
    remaining = remaining.slice(end);
  }
  return messages;
}

/** Plan against this grant's current budget. Adjacent blocks share messages; blocks are not sends. */
export function planQqMessage(result: QqRenderedMessage, maximum = MAX_MESSAGE_COUNT, literalOnly = false): QqMessageBody[] {
  validateText(result.text);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_MESSAGE_COUNT) throw new Error("QQ 回复额度不足以发送完整结果");
  const messages: QqMessageBody[] = [];
  const append = (message: QqMessageBody): void => {
    const previous = messages.at(-1);
    if (previous?.kind === message.kind && Buffer.byteLength(previous.content + message.content, "utf8") <= MAX_MESSAGE_BYTES) {
      previous.content += message.content;
    } else messages.push(message);
  };
  if (!literalOnly && maximum > 1) {
    for (const [index, block] of result.blocks.entries()) {
      const separator = index === 0 ? "" : "\n";
      const candidate = separator + (block.markdown ?? block.text);
      if (block.markdown !== undefined && Buffer.byteLength(candidate, "utf8") <= MAX_MESSAGE_BYTES) {
        append({ kind: "markdown", content: candidate });
      } else for (const chunk of plainChunks(separator + block.text)) append(chunk);
    }
  }
  // Mixed formats must never crowd out a complete, smaller literal delivery.
  let plain = plainChunks(result.text);
  if (plain.length > maximum) plain = plainChunks(result.text, false);
  const planned = messages.length > 0 && messages.length <= maximum && messages.every(message => message.content.trim())
    && !(messages.length === maximum && plain.length < maximum)
    ? messages : plain;
  if (planned.length > maximum || planned.some(message => !message.content.trim())) {
    throw new Error("QQ 当前额度无法发送完整结果，保留待核对");
  }
  return planned;
}

/** Shared command output is already a panel, never model-authored Markdown. */
export function renderQqPanel(text: string): QqRenderedMessage {
  validateText(text);
  const blocks = renderQqContent(toStructuredMarkdownList(text), true);
  return { text: blocks.map(block => block.text).join("\n"), blocks };
}

export function renderQqOutput(event: OutputEvent): QqRenderedMessage {
  if (event.type === "text.completed") {
    validateText(event.text);
    const blocks = renderQqContent(event.text);
    return { text: blocks.map(block => block.text).join("\n"), blocks };
  }
  if (event.type === "operation.updated") {
    return renderQqPanel([
      `${operationTitle(event.operation)} · ${operationStatus(event.operation.status)}`,
      ...operationMetadata(event.operation),
      ...(event.operation.detail ? [redactOperationDetail(event.operation.detail)] : []),
    ].join("\n"));
  }
  if (event.type === "turn.completed") {
    const presentation = createTurnCompletedPresentation(event);
    const suffix = event.missingFinalResponse ? "\n\nQQ 当前未开放 /compact，请在原生客户端执行。" : "";
    return {
      text: renderPlainLifecyclePresentation(presentation) + suffix,
      blocks: renderQqContent(renderStructuredLifecyclePresentation(presentation, false) + suffix, true),
    };
  }
  throw new Error("QQ 尚不支持此类结果");
}
