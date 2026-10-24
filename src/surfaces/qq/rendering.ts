import type { OutputEvent } from "../../conversation-core/index.js";
import type { ConversationCommandName, ConversationCommandResult } from "../../application/index.js";
import { conversationCommandDescriptions, conversationSessionEntryHelpLines } from "../conversation-command-help.js";
import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { createTurnCompletedPresentation, renderPlainLifecyclePresentation, renderStructuredLifecyclePresentation } from "../lifecycle-presentation.js";
import { operationMetadata, operationStatus, operationTitle, redactOperationDetail } from "../operation-presentation.js";
import { toStructuredMarkdownList } from "../markdown-list.js";
import type { QqMessageBody } from "./protocol.js";
import { renderQqContent, type QqContentBlock } from "./content.js";
import { formatCodexProviderLabel, formatDisplayedProvider } from "../provider-format.js";

const MAX_RESULT_BYTES = 12_000;
const MAX_MESSAGE_BYTES = 3_000;
const MAX_MESSAGE_COUNT = 4;

const qqCommandGroups = [
  { title: "状态与运行：", commands: ["status", "stop", "permissions", "diff"] },
  { title: "工作区与会话：", commands: ["workspace", "sessions", "resume", "new", "archived", "archive", "unarchive", "pin", "unpin", "rename", "fork"] },
  { title: "模型与用量：", commands: ["model", "effort", "fast", "usage", "limits", "metrics"] },
] satisfies { title: string; commands: ConversationCommandName[] }[];
export const qqCommandNames: readonly ConversationCommandName[] = qqCommandGroups.flatMap(group => group.commands);

export const qqHelp = [
  "QQ 单聊", "", ...conversationSessionEntryHelpLines, "",
  ...qqCommandGroups.flatMap(group => [group.title,
    ...group.commands.map(name => `/${name}：${conversationCommandDescriptions[name]}`), ""]),
  "快捷命令：/h → /help，/work → /workspace，/r → /resume。",
  "会话参数：/archived [页码] [filter all|pinned] [provider 名称] [search 搜索词]；/unarchive <序号|名称|Session ID>；/rename <名称>。",
  "指标参数：/metrics session；/metrics <global|providers|models|errors> [24h|7d|30d|90d|all]。",
  "QQ 的 /limits 仅查询，额度操作请在原生客户端处理。",
  "直接发送文字开始对话；回复按 QQ 格式呈现，代码和不支持的结构保留为完整文本。",
  "审批按当前请求显示一次、会话或持久规则选项；临时权限仅本次 Turn，终端输入只批准一次或中止。普通问题按提示回应。",
  "MCP 工具审批按提示提供一次、会话或始终批准；仅原用户、原请求和有效回复窗口内生效。",
  "普通 MCP 表单按提示填写 JSON；异步/敏感问题及 MCP URL 交互暂不支持，流式、附件、计划任务仍未开放。",
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

/** Diff is source data: leading +, -, # and indentation must not become panel syntax. */
export function renderQqCommandResult(result: ConversationCommandResult): QqRenderedMessage | null {
  if (result.kind === "outcome" && result.outcome.type === "thread.renamed") {
    const title = "会话已重命名";
    const value = `名称：${result.outcome.name}`;
    const text = `${title}\n${value}`;
    validateText(text);
    return { text, blocks: [{ text: title, markdown: `## ${title}` }, { text: value }] };
  }
  if (result.kind === "permissions") {
    // Profile descriptions can contain newlines. Keep their structure outside the panel parser.
    const title = "权限查询说明";
    const values = [
      "权限由 Codex App Server 管理；本次仅查询可用的 Permission Profiles。",
      result.workspace
        ? `当前 Workspace：${result.workspace.name}（${result.workspace.id}）`
        : "当前 Workspace：未能从当前会话读取。",
      "可选择的 Permission Profiles（可选择不代表当前正在使用）：",
      ...result.profiles.map(profile =>
        `- ${profile.id} · ${profile.allowed ? "可选择" : "不可选择（受策略禁止）"}${profile.description ? ` · ${profile.description}` : ""}`),
    ].join("\n");
    const text = `${title}\n${values}`;
    validateText(text);
    return { text, blocks: [{ text: title, markdown: `## ${title}` }, { text: values }] };
  }
  const text = renderConversationCommandResult(result);
  if (text === null) return null;
  if (result.kind === "artifacts") {
    validateText(text);
    return { text, blocks: [{ text }] };
  }
  if (result.kind === "sessions" || result.kind === "metrics") {
    const values: string[] = [];
    mapQqQueryFields(result, value => { values.push(value); return value; });
    let markerId = 0;
    let prefix = `QQ_LITERAL_${markerId}_`;
    while (text.includes(prefix) || values.some(value => value.includes(prefix))) prefix = `QQ_LITERAL_${++markerId}_`;
    const literals = new Map<string, string>();
    const protectedResult = mapQqQueryFields(result, value => {
      const token = `${prefix}${literals.size}_END`;
      literals.set(token, value);
      return token;
    });
    const protectedText = renderConversationCommandResult(protectedResult)!;
    const tokenPattern = new RegExp(`${prefix}\\d+_END`, "gu");
    const blocks = renderQqContent(toStructuredMarkdownList(protectedText), true).map(block => {
      const restored = block.text.replace(tokenPattern, token => literals.get(token)!);
      // Restore once, after structural parsing. A block containing data stays literal.
      return restored === block.text ? block : { text: restored };
    });
    const restoredText = blocks.map(block => block.text).join("\n");
    validateText(restoredText);
    return { text: restoredText, blocks };
  }
  return renderQqPanel(text);
}

/** Only fields consumed by these query formatters; names/previews keep the shared list normalization. */
function mapQqQueryFields(
  result: Extract<ConversationCommandResult, { kind: "sessions" | "metrics" }>,
  field: (value: string) => string,
): Extract<ConversationCommandResult, { kind: "sessions" | "metrics" }> {
  if (result.kind === "sessions") {
    return { ...result, view: { ...result.view,
      searchTerm: result.view.searchTerm === null ? null : field(result.view.searchTerm),
      provider: result.view.provider === null ? null : field(result.view.provider),
    }, sessions: result.sessions.map(session => ({ ...session,
      ...(session.model ? { model: field(session.model) } : {}),
      ...(session.modelProvider ? { modelProvider: field(formatDisplayedProvider(session.modelProvider)) } : {}),
    })) };
  }
  const summary = result.summary;
  if (!summary) return result;
  const compactField = <T extends { compact?: { model: string | null } | null }>(entry: T): T => ({ ...entry,
    ...(entry.compact ? { compact: { ...entry.compact,
      model: entry.compact.model === null ? null : field(entry.compact.model),
    } } : {}),
  });
  if (!("view" in summary)) {
    return { ...result, summary: { ...summary,
      latestTurn: summary.latestTurn ? compactField(summary.latestTurn) : null,
      threadAggregate: summary.threadAggregate ? compactField(summary.threadAggregate) : null,
    } };
  }
  if (summary.view === "errors") {
    return { ...result, summary: { ...summary, groups: summary.groups.map(group => ({ ...group,
      provider: field(formatCodexProviderLabel(group.provider)),
      model: group.model === null ? null : field(group.model),
    })) } };
  }
  return { ...result, summary: { ...summary,
    aggregate: summary.aggregate ? compactField(summary.aggregate) : null,
    groups: summary.groups.map(group => ({ ...group,
      provider: group.provider === null ? null : field(formatCodexProviderLabel(group.provider)),
      model: group.model === null ? null : field(group.model),
      aggregate: compactField(group.aggregate),
    })),
  } };
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
