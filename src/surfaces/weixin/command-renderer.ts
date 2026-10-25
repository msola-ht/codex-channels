import {
  type ConversationStatus,
  type ConversationCommandResult,
} from "../../application/index.js";
import type {
  OutputEvent,
  UserFacingError,
} from "../../conversation-core/index.js";
import {
  conversationCommandHelpLines,
} from "../conversation-command-help.js";
import { toStructuredMarkdownList } from "../markdown-list.js";
import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";
import {
  createStartupPresentation,
  createSubagentCompletedPresentation,
  createTurnCompletedPresentation,
  renderStructuredLifecyclePresentation,
  escapeLifecycleLiteral,
  type LifecyclePresentation,
  type PresentationDetail,
  type StartupRuntimeInfo as LifecycleStartupRuntimeInfo,
} from "../lifecycle-presentation.js";
import { formatSurfaceUserFacingError } from "../user-facing-error-format.js";

import { renderConversationCommandResult } from "../conversation-command-renderer.js";
import { formatConversationStatus } from "../conversation-workspace-status-command-format.js";

export function renderWeixinCommandResult(result: ConversationCommandResult): string | null {
  if (result.kind === "artifacts" && result.artifacts?.diff?.trim()) {
    const diff = result.artifacts.diff;
    let fenceLength = 3;
    for (const match of diff.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    return `## Turn Diff · ${result.artifacts.turnId}\n\n${fence}diff\n${diff}${diff.endsWith("\n") ? "" : "\n"}${fence}`;
  }
  return result.kind === "status"
    ? formatConversationStatus(result.status, escapeLifecycleLiteral)
    : renderConversationCommandResult(result);
}

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
    | "serviceTierKnown"
    | "effectiveServiceTier"
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
  detailed: PresentationDetail = "basic",
  mode: "brief" | "detailed" = "detailed",
): string {
  return renderWeixinLifecyclePresentation(
    createTurnCompletedPresentation(
      event,
      detailed,
      mode,
    ),
  );
}

export function renderWeixinSubagentCompleted(
  event: Extract<OutputEvent, { type: "subagent.completed" }>,
  detailed: PresentationDetail = "basic",
): string {
  return renderWeixinLifecyclePresentation(
    createSubagentCompletedPresentation(event, detailed),
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
  const lines = text.split("\n");
  let fence: MarkdownFence | undefined;
  return lines.map((rawLine, index) => {
    const previous = fence;
    fence = advanceMarkdownFence(fence, rawLine);
    if (previous || fence) {
      return rawLine;
    }
    const line = rawLine.replace(/\r$/u, "");
    if (options.structuredFields === true) {
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
        && !isMarkdownBlockLine(line)
        && isWeixinStructuredField(lines[index + 1])
      ) {
        return `**${line}**`;
      }
      const field = parseWeixinCommandField(line);
      if (field) {
        return `- ${field.label}：${field.value}`;
      }
    }
    const next = lines[index + 1]?.replace(/\r$/u, "");
    if (
      line.length === 0
      || isMarkdownBlockLine(line)
      || next === undefined
      || next.length === 0
      || advanceMarkdownFence(undefined, next) !== undefined
    ) {
      return line;
    }
    return `${line}  `;
  }).join("\n");
}

function isMarkdownBlockLine(line: string): boolean {
  return /^\s*(?:[-+*]\s+|\d+\.\s+|>|#{1,6}\s+|\*\*.+\*\*\s*$|\||-{3,}\s*$)/u
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
