import type { OutputEvent } from "../../conversation-core/index.js";
import type { ConversationCommandName, ConversationCommandResult, HookEntry } from "../../application/index.js";
import { conversationCommandDescriptions, conversationSessionEntryHelpLines } from "../conversation-command-help.js";
import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { createTurnCompletedPresentation, renderPlainLifecyclePresentation, renderStructuredLifecyclePresentation } from "../lifecycle-presentation.js";
import { operationMetadata, operationStatus, operationTitle, redactOperationDetail } from "../operation-presentation.js";
import { toStructuredMarkdownList } from "../markdown-list.js";
import { maximumQqTextFileBytes, type QqMessageBody } from "./protocol.js";
import { renderQqContent, type QqContentBlock } from "./content.js";
import { formatCodexProviderLabel, formatDisplayedProvider } from "../provider-format.js";
import { canReviewConversationHook, formatConversationHooks } from "../conversation-hook-command-format.js";

const MAX_RESULT_BYTES = 12_000;
const MAX_MESSAGE_BYTES = 3_000;
const MAX_MESSAGE_COUNT = 4;

const qqCommandGroups = [
  { title: "状态与运行：", commands: ["status", "stop", "queue", "permissions", "diff", "review", "autoreview", "compact", "revert", "release"] },
  { title: "工作区与会话：", commands: ["workspace", "sessions", "resume", "new", "archived", "archive", "unarchive", "pin", "unpin", "rename", "fork"] },
  { title: "模型与用量：", commands: ["model", "effort", "fast", "plan", "usage", "limits", "metrics"] },
  { title: "扩展与代理：", commands: ["skill", "plugin", "agents", "mcp", "hooks"] },
] satisfies { title: string; commands: ConversationCommandName[] }[];
export const qqCommandNames: readonly ConversationCommandName[] = qqCommandGroups.flatMap(group => group.commands);

export const qqHelp = [
  "QQ 单聊", "", ...conversationSessionEntryHelpLines, "",
  ...qqCommandGroups.flatMap(group => [group.title,
    ...group.commands.map(name => `/${name}：${conversationCommandDescriptions[name]}`), ""]),
  "快捷命令：/h → /help，/work → /workspace，/r → /resume。",
  "命令参数：",
  "/archived：可选页码，以及 filter all 或 filter pinned、provider 名称、search 搜索词。",
  "/unarchive：填写序号、名称或 Session ID；/rename：填写名称。",
  "/metrics：填写 session、global、providers、models 或 errors。",
  "聚合指标时间范围：global、providers、models、errors 后可选填 24h、7d、30d、90d 或 all。",
  "/review：可选 branch 分支、commit SHA 或 custom 说明；不填审查未提交改动。",
  "/plan：不填切换模式，填写需求直接开始规划。/skill、/agents：不填列出，填写名称或序号及任务调用。",
  "/plugin：不填列出，health 查健康，list 后可选页码及 search 搜索词；填写名称、完整 ID 或序号查看详情，再加任务调用。",
  "/autoreview：查询；填写 on 或 off 切换审批方式。/compact：请求压缩，稍后用 /status 核对。",
  "/queue：add 文本、list 页码、update 选择器 文本、delete 选择器、reorder 选择器 位置；start 可带选择器，省略时启动队首条目。",
  "/revert：list 后可填页码；填写选择编号预览，再按返回的 confirm 令牌确认；不恢复文件或外部副作用。",
  "/release：诊断占用；显式 /release force 沿共享约束尝试结束可释放进程，可能影响其他会话。",
  "/mcp：不填列出，health 查健康，reload 请求重载；名称或序号查详情，tools、resources 或 templates 支持分页和 search。",
  "/mcp login 名称或序号：浏览器 OAuth；/mcp resource 名称或序号 URI：只读资源，不执行资源内容。",
  "/hooks：不填或 page 页码列出，选择编号查详情；trust/enable/disable 加编号预览，再按 confirm 令牌确认。",
  "/limits reset：查询重置券，可填页码；use 券ID 预览，按返回的 confirm 或 cancel 令牌操作。",
  "功能说明：",
  "Hook、Revert 和重置券确认预览必须完整放入单条文字；无法完整展示时不发送确认令牌，请在原生客户端操作。",
  "可发送文字、图片或图文；同消息最多四张图片。原生引用仅作上下文，引用附件不下载；命令只读取当前消息。回复按 QQ 格式呈现，代码和不支持的结构保留为完整文本。",
  "语音需平台提供可信 PCM WAV，仅支持单/双声道 8/16 位、单一 fmt/data 块，最长 5 分钟、20 MiB，且模型须支持音频。视频每条限一个 MP4、64 MiB，需配置视频分析 MCP，仅分析画面；音视频可带说明，混合媒体需拆开发送。",
  "审批按当前请求显示一次、会话或持久规则选项；临时权限仅本次 Turn，终端输入只批准一次或中止。普通问题按提示回应。",
  "MCP 工具审批按提示提供一次、会话或始终批准；仅原用户、原请求和有效回复窗口内生效。",
  "支持生成图片回传，受大小、回复窗口和剩余额度限制；普通文件输入、流式和计划任务仍未开放。",
  "Queue 由 App Server 持久保存；QQ 结果只沿本次运行中登记的原 add 来信回复，仍共用原消息五分钟/四次额度。重启、过期或原生客户端加入的条目可执行，但不会借 start 或新来信补发结果。",
  "长回答、长 Diff 和完整命令结果超过文本预算或剩余额度时，以完整 UTF-8 文件交付；文件上限 1000000 字节。",
  "普通 MCP 表单按提示填写 JSON；异步/敏感问题及 MCP URL 交互暂不支持。",
].join("\n");

export interface QqRenderedMessage {
  /** Complete readable content; the persistent event retains the original source. */
  text: string;
  blocks: QqContentBlock[];
  /** Only final answers and shared command results may become complete files. Never a rendered preview. */
  source?: string;
  /** Command panels prefer fewer complete messages over splitting literal fields from headings. */
  compact?: boolean;
  /** A confirmation token must never precede a partial or attached review. */
  singleMessage?: boolean;
}

class QqMessageBudgetError extends Error {}

export class QqConfirmationPreviewError extends Error {
  constructor() {
    super("QQ 无法在单条文字中完整展示确认预览；未发送确认令牌，请在原生客户端操作。");
  }
}

function validateSource(text: string): void {
  if (!text.trim() || Buffer.from(text, "utf8").toString("utf8") !== text) {
    throw new Error("QQ 完整结果为空或包含无效 Unicode，保留待核对");
  }
}

function validateText(text: string): void {
  validateSource(text);
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    throw new QqMessageBudgetError("QQ 完整结果超过文本预算，保留待核对");
  }
}

/** Oversize sources bypass Markdown parsing, whose work remains bounded by the text budget. */
function completeFileCandidate(source: string): QqRenderedMessage | undefined {
  validateSource(source);
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > maximumQqTextFileBytes) throw new Error("QQ 完整结果超过文件预算，保留待核对");
  return bytes > MAX_RESULT_BYTES ? { source, text: source, blocks: [] } : undefined;
}

export type QqDeliveryPlan = { kind: "messages"; messages: QqMessageBody[] } | { kind: "file"; bytes: Buffer };

/** Select complete delivery before any send. Only a planning budget failure permits a file. */
export function planQqDelivery(result: QqRenderedMessage, maximum: number): QqDeliveryPlan {
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > MAX_MESSAGE_COUNT) throw new Error("QQ 回复额度无效");
  if (result.source !== undefined) completeFileCandidate(result.source);
  if (maximum === 0) throw new QqMessageBudgetError("QQ 回复额度不足以发送完整结果");
  if (result.singleMessage) {
    requireSingleReview(result.text);
    return { kind: "messages", messages: [{ kind: "text", content: result.text }] };
  }
  try { return { kind: "messages", messages: planQqMessage(result, maximum) }; }
  catch (error) {
    if (!(error instanceof QqMessageBudgetError) || result.source === undefined || maximum < 1) throw error;
    return { kind: "file", bytes: Buffer.from(result.source, "utf8") };
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
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > MAX_MESSAGE_COUNT) throw new Error("QQ 回复额度无效");
  if (maximum === 0) throw new QqMessageBudgetError("QQ 回复额度不足以发送完整结果");
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
    && !(result.compact && plain.length < messages.length)
    ? messages : plain;
  if (planned.length > maximum || planned.some(message => !message.content.trim())) {
    throw new QqMessageBudgetError("QQ 当前额度无法发送完整结果，保留待核对");
  }
  return planned;
}

/** Shared command output is already a panel, never model-authored Markdown. */
export function renderQqPanel(text: string): QqRenderedMessage {
  validateText(text);
  const blocks = renderQqContent(toStructuredMarkdownList(text), true);
  return { text: blocks.map(block => block.text).join("\n"), blocks };
}

/** Dynamic multiline fields cannot safely be reparsed as the shared panel's structure. */
function hasMultilineField(value: unknown): boolean {
  if (typeof value === "string") return /[\r\n]/u.test(value);
  if (Array.isArray(value)) return value.some(hasMultilineField);
  return value !== null && typeof value === "object" && Object.values(value).some(hasMultilineField);
}

/** Diff is source data: leading +, -, # and indentation must not become panel syntax. */
export function renderQqCommandResult(result: ConversationCommandResult): QqRenderedMessage | null {
  const shared = renderConversationCommandResult(result);
  if (shared === null) return null;
  const source = shared + queueReplyNotice(result);
  if (result.kind === "thread-revert-preview" || result.kind === "hooks" && result.view.confirmation
    || result.kind === "reset-credit" && result.result.type === "preview") {
    try {
      const rendered = renderQqCommandPanel(result, source);
      requireSingleReview(rendered.text);
      return { text: rendered.text, blocks: [{ text: rendered.text }], singleMessage: true };
    } catch (error) {
      if (error instanceof QqMessageBudgetError) throw new QqConfirmationPreviewError();
      throw error;
    }
  }
  const candidate = completeFileCandidate(source);
  if (candidate) return candidate;
  try { return { ...renderQqCommandPanel(result, source), source }; }
  catch (error) {
    if (!(error instanceof QqMessageBudgetError)) throw error;
    return { source, text: source, blocks: [] };
  }
}

function queueReplyNotice(result: ConversationCommandResult): string {
  if (result.kind !== "outcome" || result.outcome.type !== "thread-queue.added" && result.outcome.type !== "thread-queue.started") return "";
  return "\n- QQ 结果只沿本次运行登记的原 add 来信回复，共用原消息五分钟/四次额度；原生条目、重启或过期后没有回复依据，start 和新来信不会刷新额度。";
}

function requireSingleReview(text: string): void {
  validateSource(text);
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
    throw new QqConfirmationPreviewError();
  }
}

/** The live view is checked again with its actual Workspace, Provider and selector before sending. */
export function canReviewQqConversationHook(hook: HookEntry): boolean {
  if (!canReviewConversationHook(hook, () => true)) return false;
  try {
    requireSingleReview(formatConversationHooks({
      workspaceId: "", provider: "", entries: [], warningCount: 0, errorCount: 0,
      page: 1, pageCount: 1, detail: { selector: "0".repeat(16) + ".1", hook },
      confirmation: { token: "0".repeat(32), action: "trust" },
    }));
    return true;
  } catch { return false; }
}

function renderQqCommandPanel(result: ConversationCommandResult, text: string): QqRenderedMessage {
  if (result.kind === "thread-queue" || result.kind === "outcome" && result.outcome.type.startsWith("thread-queue.")) {
    return renderQqFieldPanel(field => renderConversationCommandResult(mapQqQueryFields(result, field))! + queueReplyNotice(result), text);
  }
  if (result.kind === "outcome" && result.outcome.type === "thread.compaction-requested") {
    return renderQqPanel("已请求压缩当前 Codex Session。尚未确认完成，请稍后用 /status 核对。");
  }
  if (result.kind === "mcp" || result.kind === "mcp-health" || result.kind === "mcp-detail"
    || result.kind === "mcp-login" || result.kind === "mcp-resource" || result.kind === "occupancy") {
    return renderQqFieldPanel(field => renderConversationCommandResult(result, undefined, field)!, text, result.kind === "mcp-resource");
  }
  if (result.kind === "hooks") {
    const lines = text.split("\n");
    const heading = lines.shift()!.replace(/^## /u, "");
    const blocks: QqContentBlock[] = [{ text: heading, markdown: `## ${heading}` }];
    if (lines.length) blocks.push({ text: lines.join("\n") });
    const literalText = blocks.map(block => block.text).join("\n");
    validateText(literalText);
    return { text: literalText, blocks, compact: true };
  }
  if (result.kind === "outcome" && result.outcome.type === "thread.renamed") {
    const title = "会话已重命名";
    const value = `名称：${result.outcome.name}`;
    const text = `${title}\n${value}`;
    validateText(text);
    return { text, blocks: [{ text: title, markdown: `## ${title}` }, { text: value }], compact: true };
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
        `• ${profile.id} · ${profile.allowed ? "可选择" : "不可选择（受策略禁止）"}${profile.description ? ` · ${profile.description}` : ""}`),
    ].join("\n");
    const text = `${title}\n${values}`;
    validateText(text);
    return { text, blocks: [{ text: title, markdown: `## ${title}` }, { text: values }], compact: true };
  }
  if (result.kind === "artifacts") {
    validateText(text);
    return { text, blocks: [{ text }] };
  }
  if (result.kind === "sessions" || result.kind === "metrics" || result.kind === "skills"
    || result.kind === "auto-review"
    || result.kind === "reset-credit" || result.kind === "thread-revert" || result.kind === "thread-revert-preview"
    || result.kind === "agents" || result.kind === "plugins" || result.kind === "plugin-health"
    || result.kind === "plugin-detail" || result.kind === "outcome" && (
      result.outcome.type === "review.started" || result.outcome.type === "plan.started"
      || result.outcome.type === "skill.started" || result.outcome.type === "plugin.started"
      || result.outcome.type === "agents.started" || result.outcome.type === "thread.reverted")) {
    return renderQqFieldPanel(field => renderConversationCommandResult(mapQqQueryFields(result, field))!, text);
  }
  if (hasMultilineField(result)) {
    validateText(text);
    return { text, blocks: [{ text }] };
  }
  return renderQqPanel(text);
}

/** Parse only shared structure; restoring a field makes its entire block literal. */
function renderQqFieldPanel(render: (field: (value: string) => string) => string, source: string, resource = false): QqRenderedMessage {
  const values: string[] = [];
  render(value => { values.push(value); return value; });
  let markerId = 0;
  // Alphanumeric markers survive the shared reset-credit formatter's Markdown escaping.
  let prefix = `QQLITERAL${markerId}Z`;
  while (source.includes(prefix) || values.some(value => value.includes(prefix))) prefix = `QQLITERAL${++markerId}Z`;
  const literals = new Map<string, string>();
  const protectedText = render(value => {
    const token = `${prefix}${literals.size}END`;
    literals.set(token, value);
    return token;
  });
  const tokenPattern = new RegExp(`${prefix}\\d+END`, "gu");
  const blocks = renderQqContent(toStructuredMarkdownList(protectedText), true)
    // These fences are the shared resource formatter's wrappers; all external fields are still tokens.
    .filter(block => !resource || block.text !== "```text" && block.text !== "```")
    .map(block => {
      const restored = block.text.replace(tokenPattern, token => literals.get(token)!);
      return restored === block.text ? block : { text: restored };
    });
  const text = blocks.map(block => block.text).join("\n");
  validateText(text);
  return { text, blocks, compact: true };
}

/** Only fields consumed by these command formatters; session names/previews keep shared normalization. */
type QqLiteralCommandResult = Extract<ConversationCommandResult, {
  kind: "sessions" | "metrics" | "skills" | "agents" | "plugins" | "plugin-health" | "plugin-detail" | "outcome"
    | "reset-credit" | "thread-revert" | "thread-revert-preview" | "thread-queue" | "auto-review";
}>;

function mapQqQueryFields(
  result: QqLiteralCommandResult,
  field: (value: string) => string,
): QqLiteralCommandResult {
  if (result.kind === "thread-queue") return { ...result, result: { ...result.result,
    selectors: result.result.selectors.map(field), items: result.result.items.map(item => ({ ...item,
      id: field(item.id), textPreview: item.textPreview === null ? null : field(item.textPreview),
    })),
  } };
  if (result.kind === "auto-review") return { ...result, state: { ...result.state,
    threadId: result.state.threadId === null ? null : field(result.state.threadId),
  } };
  if (result.kind === "reset-credit") {
    const value = result.result;
    const credit = <T extends { id: string; title: string | null; description: string | null }>(entry: T): T => ({
      ...entry, id: field(entry.id), title: entry.title === null ? null : field(entry.title),
      description: entry.description === null ? null : field(entry.description),
    });
    if (value.type === "list") return { ...result, result: { ...value,
      accountId: field(value.accountId), credits: value.credits.map(credit),
    } };
    if (value.type === "preview") return { ...result, result: { ...value,
      accountId: field(value.accountId), credit: credit(value.credit), token: field(value.token),
    } };
    return result;
  }
  if (result.kind === "thread-revert") return { ...result, result: { ...result.result,
    selectors: result.result.selectors.map(field), turns: result.result.turns.map(turn => ({ ...turn,
      id: field(turn.id), ...(turn.textPreview ? { textPreview: field(turn.textPreview) } : {}),
    })),
  } };
  if (result.kind === "thread-revert-preview") return { ...result, preview: { ...result.preview,
    beforeTurnId: field(result.preview.beforeTurnId), token: field(result.preview.token),
    activeTurnId: result.preview.activeTurnId === null ? null : field(result.preview.activeTurnId),
    turn: { ...result.preview.turn,
      ...(result.preview.turn.textPreview ? { textPreview: field(result.preview.turn.textPreview) } : {}),
    },
  } };
  if (result.kind === "skills") return { ...result, entries: result.entries.map(entry => ({ ...entry,
    name: field(entry.name), description: field(entry.description),
  })) };
  if (result.kind === "agents") return { ...result, roles: result.roles.map(role => ({ ...role,
    name: field(role.name), ...(role.description ? { description: field(role.description) } : {}),
  })) };
  if (result.kind === "plugins") return { ...result,
    selectors: result.selectors.map(field), searchTerm: result.searchTerm === null ? null : field(result.searchTerm),
    plugins: result.plugins.map(plugin => ({ ...plugin, id: field(plugin.id), displayName: field(plugin.displayName),
      ...(plugin.description ? { description: field(plugin.description) } : {}),
    })),
  };
  if (result.kind === "plugin-health") return { ...result, report: { ...result.report,
    issues: result.report.issues.map(issue => ({ ...issue, plugin: field(issue.plugin), selector: field(issue.selector) })),
  } };
  if (result.kind === "plugin-detail") {
    const plugin = result.plugin;
    return { ...result, plugin: { ...plugin,
      id: field(plugin.id), displayName: field(plugin.displayName), marketplaceName: field(plugin.marketplaceName),
      ...(plugin.developerName ? { developerName: field(plugin.developerName) } : {}),
      ...(plugin.category ? { category: field(plugin.category) } : {}),
      ...(plugin.description ? { description: field(plugin.description) } : {}),
      version: plugin.version === null ? null : field(plugin.version),
      localVersion: plugin.localVersion === null ? null : field(plugin.localVersion),
      capabilities: plugin.capabilities.map(field), eligiblePlanTypes: plugin.eligiblePlanTypes.map(field),
    } };
  }
  if (result.kind === "outcome") {
    const outcome = result.outcome;
    switch (outcome.type) {
      case "thread-queue.added": case "thread-queue.updated":
        return { ...result, outcome: { ...outcome, item: { ...outcome.item,
          id: field(outcome.item.id), textPreview: outcome.item.textPreview === null ? null : field(outcome.item.textPreview),
        } } };
      case "thread-queue.reordered":
        return { ...result, outcome: { ...outcome, itemId: field(outcome.itemId) } };
      case "thread-queue.started":
        return { ...result, outcome: { ...outcome, turnId: field(outcome.turnId) } };
      case "review.started": case "plan.started":
        return { ...result, outcome: { ...outcome, turnId: field(outcome.turnId) } };
      case "skill.started":
        return { ...result, outcome: { ...outcome, skillName: field(outcome.skillName), turnId: field(outcome.turnId) } };
      case "plugin.started":
        return { ...result, outcome: { ...outcome, pluginName: field(outcome.pluginName), turnId: field(outcome.turnId) } };
      case "agents.started":
        return { ...result, outcome: { ...outcome, roleName: field(outcome.roleName), turnId: field(outcome.turnId) } };
      case "thread.reverted":
        return { ...result, outcome: { ...outcome, threadId: field(outcome.threadId), beforeTurnId: field(outcome.beforeTurnId) } };
      default: return result;
    }
  }
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
    const candidate = completeFileCandidate(event.text);
    if (candidate) return candidate;
    const blocks = renderQqContent(event.text);
    return { source: event.text, text: blocks.map(block => block.text).join("\n"), blocks };
  }
  if (event.type === "operation.updated") {
    const panel = renderQqPanel([
      `${operationTitle(event.operation)} · ${operationStatus(event.operation.status)}`,
      ...operationMetadata(event.operation),
    ].join("\n"));
    if (!event.operation.detail) return panel;
    const detail = redactOperationDetail(event.operation.detail);
    const text = `${panel.text}\n${detail}`;
    validateText(text);
    return { text, blocks: [...panel.blocks, { text: detail }] };
  }
  if (event.type === "turn.completed") {
    const presentation = createTurnCompletedPresentation(event);
    const text = renderPlainLifecyclePresentation(presentation);
    if (hasMultilineField(presentation)) {
      validateText(text);
      return { text, blocks: [{ text }] };
    }
    return {
      text,
      blocks: renderQqContent(renderStructuredLifecyclePresentation(presentation, false), true),
    };
  }
  throw new Error("QQ 尚不支持此类结果");
}
