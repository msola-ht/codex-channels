import {
  type ConversationStatus,
} from "../../application/index.js";
import type {
  OutputEvent,
  UserFacingError,
} from "../../conversation-core/index.js";
import {
  conversationCommandHelpLines,
} from "../conversation-command-help.js";
import { toStructuredMarkdownList } from "../markdown-list.js";
import {
  createStartupPresentation,
  createSubagentCompletedPresentation,
  createTurnCompletedPresentation,
  renderStructuredLifecyclePresentation,
  type LifecyclePresentation,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";

export {
  renderConversationCommandResult as renderWeixinCommandResult,
} from "../conversation-command-renderer.js";

export type WeixinStartupRuntimeInfo = LifecycleStartupRuntimeInfo;

export function renderWeixinStartupNotification(
  workspaces: ReadonlyArray<{ id: string; name: string; cwd: string }>,
  status: Pick<
    ConversationStatus,
    | "threadId"
    | "threadName"
    | "workspaceId"
    | "model"
    | "modelProvider"
    | "effort"
    | "serviceTier"
    | "modelPending"
    | "effortPending"
    | "fastModePending"
    | "collaborationMode"
    | "collaborationModePending"
    | "weeklyLimit"
    | "gitBranch"
  >,
  runtime: WeixinStartupRuntimeInfo,
): string {
  return renderWeixinLifecyclePresentation(
    createStartupPresentation(workspaces, status, runtime),
  );
}

export function renderWeixinHelp(): string {
  return toStructuredMarkdownList([
    "微信 Codex 命令",
    "普通文本会发送到当前 Codex Session。",
    ...conversationCommandHelpLines,
    "微信：",
    "- /whoami · /wx doctor",
    "- /start · /help · /h",
  ].join("\n"));
}

export function renderWeixinIdentity(message: {
  actorId: string;
  target: {
    accountId: string;
    conversationId: string;
  };
}): string {
  return toStructuredMarkdownList([
    "微信身份",
    `用户 ID：${message.actorId}`,
    `会话 ID：${message.target.conversationId}`,
    `账号 ID：${message.target.accountId}`,
  ].join("\n"));
}

export function renderWeixinTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
  debug = false,
  autoCompactPercent?: (
    provider: string | null | undefined,
    model: string | null | undefined,
  ) => number | null,
): string {
  return renderWeixinLifecyclePresentation(
    createTurnCompletedPresentation(
      event,
      debug,
      autoCompactPercent,
    ),
  );
}

export function renderWeixinSubagentCompleted(
  event: Extract<OutputEvent, { type: "subagent.completed" }>,
  debug = false,
): string {
  return renderWeixinLifecyclePresentation(
    createSubagentCompletedPresentation(event, debug),
  );
}

export function renderWeixinUserFacingError(
  error: UserFacingError,
): string {
  return formatSurfaceUserFacingError(error, "微信");
}

export function formatWeixinCommandText(
  text: string,
  options: { structuredFields?: boolean } = {},
): string {
  const lines = text
    .replace(/\r\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .split("\n");
  let fenced = false;
  return lines.map((line, index) => {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      return line;
    }
    if (!fenced && options.structuredFields === true) {
      const heading = /^#{1,6}\s+(.+)$/u.exec(line);
      if (heading) {
        return `**${heading[1]}**`;
      }
      const section = /^([^：\n]{1,64})：\s*$/u.exec(line);
      if (section) {
        return `**${section[1]}**`;
      }
      if (
        index === 0
        && line.length > 0
        && isWeixinStructuredField(lines[index + 1])
      ) {
        return `**${line}**`;
      }
      const field = parseWeixinCommandField(line);
      if (field) {
        return `- ${field.label}：${field.value}`;
      }
    }
    const next = lines[index + 1];
    if (
      fenced
      || line.length === 0
      || isMarkdownBlockLine(line)
      || next === undefined
      || next.length === 0
      || next.trimStart().startsWith("```")
    ) {
      return line;
    }
    return `${line}  `;
  }).join("\n");
}

function isMarkdownBlockLine(line: string): boolean {
  return /^\s*(?:[-+*]\s+|\d+\.\s+|>|#{1,6}\s+|\||-{3,}\s*$)/u
    .test(line);
}

function isWeixinStructuredField(line: string | undefined): boolean {
  return parseWeixinCommandField(line) !== null
    || (line !== undefined && /^\s*[-+*]\s+[^：\n]{1,40}：\s*.+$/u.test(line));
}

function parseWeixinCommandField(
  line: string | undefined,
): { label: string; value: string } | null {
  if (line === undefined || isMarkdownBlockLine(line)) {
    return null;
  }
  const field = /^([^：\n]{1,40})：\s*(.+)$/u.exec(line);
  return field === null
    ? null
    : { label: field[1]!, value: field[2]! };
}

function renderWeixinLifecyclePresentation(
  presentation: LifecyclePresentation,
): string {
  return renderStructuredLifecyclePresentation(presentation);
}
