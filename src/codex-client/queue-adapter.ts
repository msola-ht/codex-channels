import type {
  QueuedSubmission,
  ThreadQueueAddResponse,
  ThreadQueueDeleteResponse,
  ThreadQueueListResponse,
  ThreadQueueStartResponse,
  ThreadQueueUpdateResponse,
  UserInput,
} from "../codex-protocol/index.js";
import type {
  ThreadQueueInputType,
  ThreadQueueItem,
  ThreadQueuePage,
} from "../application/index.js";
import { toTurnStarted } from "./turn-adapter.js";

const maximumQueuePreviewCharacters = 160;

/** Convert the official Queue response to the safe Application summary. */
export function toThreadQueueItem(value: QueuedSubmission): ThreadQueueItem {
  if (!nonEmptyString(value.id) || typeof value.clientUserMessageId !== "string") {
    throw new Error("Codex Queue 响应缺少有效条目标识");
  }
  if (!Array.isArray(value.input) || value.input.length === 0) {
    throw new Error("Codex Queue 响应缺少输入条目");
  }
  const summary = summarizeQueueInput(value.input);
  return {
    id: value.id,
    clientUserMessageId: value.clientUserMessageId,
    inputType: summary.inputType,
    textPreview: summary.textPreview,
    editable: summary.editable,
  };
}

export function toThreadQueuePage(value: ThreadQueueListResponse): ThreadQueuePage {
  if (!Array.isArray(value.data)) {
    throw new Error("Codex Queue 列表响应缺少 data");
  }
  if (value.nextCursor !== null && !nonEmptyString(value.nextCursor)) {
    throw new Error("Codex Queue 列表响应包含无效分页游标");
  }
  return {
    items: value.data.map(toThreadQueueItem),
    nextCursor: value.nextCursor,
  };
}

export function toThreadQueueAddResult(value: ThreadQueueAddResponse): ThreadQueueItem {
  return toThreadQueueItem(value.queuedSubmission);
}

export function toThreadQueueUpdateResult(value: ThreadQueueUpdateResponse): ThreadQueueItem {
  return toThreadQueueItem(value.queuedSubmission);
}

export function toThreadQueueDeleteResult(
  value: ThreadQueueDeleteResponse,
): { deleted: boolean } {
  if (typeof value.deleted !== "boolean") {
    throw new Error("Codex Queue 删除响应缺少 deleted");
  }
  return { deleted: value.deleted };
}

export function toThreadQueueStartResult(
  value: ThreadQueueStartResponse,
): { turnId: string } {
  return toTurnStarted(value);
}

export function toProtocolQueueText(text: string): UserInput[] {
  return [{ type: "text", text, text_elements: [] }];
}

function summarizeQueueInput(input: UserInput[]): {
  inputType: ThreadQueueInputType;
  textPreview: string | null;
  editable: boolean;
} {
  if (input.length === 1) {
    const first = input[0]!;
    switch (first.type) {
      case "text":
        return {
          inputType: "text",
          textPreview: boundedText(first.text),
          editable: true,
        };
      case "image":
      case "localImage":
        return { inputType: "image", textPreview: null, editable: false };
      case "audio":
      case "localAudio":
        return { inputType: "audio", textPreview: null, editable: false };
      case "skill":
        return { inputType: "skill", textPreview: null, editable: false };
      case "mention":
        return { inputType: "mention", textPreview: null, editable: false };
    }
  }
  const text = input
    .filter((item): item is Extract<UserInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join(" ");
  return {
    inputType: "other",
    textPreview: text ? boundedText(text) : null,
    editable: false,
  };
}

function boundedText(value: string): string {
  const printable = [...value]
    .map((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f
      ? " "
      : character)
    .join("");
  const normalized = printable.replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  const characters = [...normalized];
  return characters.length > maximumQueuePreviewCharacters
    ? `${characters.slice(0, maximumQueuePreviewCharacters - 1).join("")}…`
    : normalized;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
